const cron = require('node-cron');
const axios = require('axios');
const Scheduled = require('../models/Scheduled');
const Service = require('../models/server');
const Order = require('../models/Order');
const User = require('../models/User');
const HistoryUser = require('../models/History');
const Counter = require('../models/Counter');
const SmmSv = require('../models/SmmSv');
const Telegram = require('../models/Telegram');
const SmmApiService = require('../controllers/Smm/smmServices');

function getEffectiveRate(service, user) {
  try {
    const base = Number(service?.rate || 0);
    const vip = Number(service?.ratevip || 0);
    const distributor = Number(service?.rateDistributor || 0);
    const level = (user?.capbac || 'member').toLowerCase();
    if (level === 'vip' && vip > 0) return vip;
    if (level === 'distributor' && distributor > 0) return distributor;
    return base;
  } catch (_) {
    return Number(service?.rate || 0);
  }
}

async function fetchSmmConfig(domain) {
  const smmSvConfig = await SmmSv.findById(domain);
  if (!smmSvConfig || !smmSvConfig.url_api || !smmSvConfig.api_token) {
    throw new Error('Lỗi khi mua dịch vụ, vui lòng ib admin');
  }
  return smmSvConfig;
}

function sanitizeProviderMessage(message) {
  if (!message) return 'Lỗi khi mua dịch vụ, vui lòng thử lại';
  const errRaw = String(message);
  const errStr = errRaw.toLowerCase();
  const urlRegex = /(https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.(com|net|org|io|vn|co)\b/i;
  const phoneRegexVN = /\b(\+?84|0)(3|5|7|8|9)\d{8}\b/;
  const isSensitive = errStr.includes('số dư') || errStr.includes('balance') || errStr.includes('xu') || errStr.includes('tiền')
    || urlRegex.test(errRaw) || phoneRegexVN.test(errRaw);
  return isSensitive ? 'Lỗi khi mua dịch vụ, vui lòng thử lại' : errRaw;
}

function normalizeObjectLink(rawInput, service) {
  if (!rawInput || !service?.type?.name) return rawInput;
  const raw = rawInput.trim();
  if (!raw) return raw;
  const platformRaw = service.type.name.toLowerCase();
  const isFacebook = platformRaw.includes('facebook') || platformRaw === 'fb' || platformRaw.includes(' fb');
  const isTiktok = platformRaw.includes('tiktok') || platformRaw === 'tt';
  const isInstagram = platformRaw.includes('instagram') || platformRaw === 'ig';

  try {
    if (isFacebook) {
      if (/^https?:\/\//i.test(raw)) {
        return raw.replace(/^https?:\/\/(facebook\.com)/i, 'https://www.facebook.com');
      }
      if (/^facebook\.com\//i.test(raw)) {
        return 'https://www.' + raw;
      }
      if (/^fb\.com\//i.test(raw)) {
        return 'https://www.' + raw.replace(/^fb\.com/i, 'facebook.com');
      }
      const cleaned = raw.replace(/^\/+/, '');
      return 'https://www.facebook.com/' + cleaned;
    }

    if (isTiktok) {
      if (/^https?:\/\//i.test(raw)) {
        return raw;
      }
      if (/^tiktok\.com\//i.test(raw)) {
        return 'https://' + raw;
      }
      let cleaned = raw.replace(/^\/+/, '');
      if (!cleaned.startsWith('@') && !/\//.test(cleaned)) {
        cleaned = '@' + cleaned;
      }
      return 'https://www.tiktok.com/' + cleaned;
    }

    if (isInstagram) {
      if (/^https?:\/\//i.test(raw)) {
        return raw;
      }
      if (/^instagram\.com\//i.test(raw)) {
        return 'https://' + raw;
      }
      let cleaned = raw.replace(/^\/+/, '');
      if (cleaned.startsWith('@')) cleaned = cleaned.slice(1);
      return 'https://www.instagram.com/' + cleaned.replace(/\/+$/, '');
    }
  } catch (_) {
    return raw;
  }

  return raw;
}

async function sendTelegramNotification({ telegramBotToken, telegramChatId, message }) {
  if (!telegramBotToken || !telegramChatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      chat_id: telegramChatId,
      text: message,
    });
    console.log('Thông báo Telegram đã được gửi.');

  } catch (error) {
    console.error('Lỗi gửi thông báo Telegram (scheduled):', error.message);
  }
}

async function getNextOrderCode() {
  let counter = await Counter.findOne({ name: 'orderCounter' });
  if (!counter) {
    const lastOrder = await Order.findOne({}).sort({ Madon: -1 });
    const maxMadon = lastOrder && lastOrder.Madon ? Number(lastOrder.Madon) : 9999;
    counter = await Counter.create({ name: 'orderCounter', value: maxMadon + 1 });
  } else {
    counter = await Counter.findOneAndUpdate(
      { name: 'orderCounter' },
      { $inc: { value: 1 } },
      { new: true }
    );
  }
  return counter.value;
}

async function processSingleScheduledOrder(pendingOrder) {
  const lockedOrder = await Scheduled.findOneAndUpdate(
    { _id: pendingOrder._id, status: 'Pending' },
    { $set: { status: 'Running', executedAt: new Date() } },
    { new: true }
  );

  if (!lockedOrder) {
    return; // Đã được xử lý bởi tiến trình khác
  }

  try {
    const user = await User.findOne({ username: lockedOrder.username });
    if (!user) {
      throw new Error('Không tìm thấy người dùng');
    }

    const service = await Service.findOne({ Magoi: lockedOrder.magoi })
      .populate('DomainSmm', 'name')
      .populate('type', 'name');

    if (!service) {
      throw new Error('Dịch vụ không tồn tại');
    }
    if (service.isActive === false) {
      throw new Error('Dịch vụ đang bảo trì');
    }

    const qty = Number(lockedOrder.quantity || 0);
    if (qty < service.min || qty > service.max) {
      throw new Error('Số lượng không hợp lệ');
    }

    const rateForUser = getEffectiveRate(service, user);
    const totalCost = rateForUser * qty;
    const apiRate = service.originalRate;

    const isManualOrder = service.ordertay === true ? true : false;

    // Kiểm tra giá giống orderController
    if (!isManualOrder) {
      if (service.ischeck !== true && apiRate > rateForUser) {
        throw new Error('Lỗi khi mua dịch vụ, vui lòng ib admin');
      }
    }

    const formattedComments = lockedOrder.comments ? lockedOrder.comments.replace(/\r?\n/g, '\r\n') : '';

    // Xử lý chiết khấu giống orderController
    let apiQuantity = qty;
    const discountRaw = service.chietkhau;
    const discount = Number(discountRaw);
    if (!isNaN(discount) && discount !== 0) {
      apiQuantity = Math.floor(qty * (100 - discount) / 100);
    }
    const tientieu = apiRate * apiQuantity;
    const lai = totalCost - tientieu;

    // Bước 1: Trừ tiền trước khi gọi API provider (atomic để handle race condition)
    const updatedUser = await User.findOneAndUpdate(
      {
        username: lockedOrder.username,
        balance: { $gte: totalCost }
      },
      { $inc: { balance: -totalCost } },
      { new: true }
    );

    if (!updatedUser) {
      throw new Error('Số dư không đủ để thực hiện giao dịch');
    }

    const oldBalance = updatedUser.balance + totalCost; // Số dư trước khi trừ
    const newBalance = updatedUser.balance; // Số dư sau khi trừ

    // Kiểm tra số dư âm - nếu âm thì ban user và rollback
    if (newBalance < 0) {
      console.error('⚠️ [Scheduled] Phát hiện số dư âm:', lockedOrder.username, 'số dư:', newBalance);
      await User.findOneAndUpdate(
        { username: lockedOrder.username },
        { 
          $inc: { balance: totalCost },
          $set: { status: 'banned' }
        }
      );
      throw new Error('Tài khoản đã bị khóa do phát hiện bất thường về số dư');
    }

    // Bước 2: Gọi API provider
    let purchaseOrderId;
    let providerError = null;

    if (isManualOrder) {
      purchaseOrderId = `m${Math.floor(10000 + Math.random() * 90000)}`;
    } else {
      try {
        const smmSvConfig = await fetchSmmConfig(service.DomainSmm);
        const smm = new SmmApiService(smmSvConfig.url_api, smmSvConfig.api_token);

        const purchasePayload = {
          link: lockedOrder.link,
          quantity: apiQuantity,
          service: service.serviceId,
          comments: formattedComments,
        };

        const purchaseResponse = await smm.order(purchasePayload);
        if (!purchaseResponse || !purchaseResponse.order) {
          const nestedError = purchaseResponse?.data?.error || purchaseResponse?.error || purchaseResponse?.error?.message;
          throw new Error(sanitizeProviderMessage(nestedError));
        }
        purchaseOrderId = purchaseResponse.order;
      } catch (err) {
        providerError = err;
      }
    }

    // Nếu provider lỗi, hoàn tiền lại cho user
    if (providerError) {
      console.error('❌ [Scheduled] Provider lỗi, rollback tiền cho user:', lockedOrder.username, 'số tiền:', totalCost);
      await User.findOneAndUpdate(
        { username: lockedOrder.username },
        { $inc: { balance: totalCost } }
      );
      throw providerError;
    }

    // Tạo mã đơn nội bộ
    const newMadon = await getNextOrderCode();

    const now = new Date();
    const normalizedObjectLink = normalizeObjectLink(lockedOrder.ObjectLink, service);

    const orderData = new Order({
      Madon: newMadon,
      Magoi: service.Magoi,
      username: lockedOrder.username,
      SvID: service.serviceId,
      orderId: purchaseOrderId,
      namesv: `${service.maychu} ${service.name}`,
      category: lockedOrder.category,
      link: lockedOrder.link,
      start: 0,
      quantity: qty,
      rate: rateForUser,
      totalCost,
      status: 'Pending',
      note: lockedOrder.note,
      ObjectLink: normalizedObjectLink || lockedOrder.ObjectLink,
      comments: formattedComments,
      DomainSmm: service.DomainSmm,
      tientieu: tientieu,
      lai: lai,
      refil: service.refil,
      cancel: service.cancel,
      ordertay: isManualOrder,
      createdAt: now,
    });

    const historyData = new HistoryUser({
      username: lockedOrder.username,
      madon: newMadon,
      hanhdong: 'Tạo đơn hàng',
      link: lockedOrder.link,
      tienhientai: oldBalance,
      tongtien: totalCost,
      tienconlai: newBalance,
      createdAt: now,
      mota: `Tăng ${service.maychu} ${service.name} thành công cho uid ${lockedOrder.link}`,
    });

    await Service.findOneAndUpdate(
      { Magoi: service.Magoi },
      { $inc: { luotban: 1 } },
      { new: true }
    );

    await orderData.save();
    await historyData.save();

    const teleConfig = await Telegram.findOne();
    if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
      const createdAtVN = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const telegramMessage = `📌 *Đơn hàng mới đã được tạo theo lịch đặt!*\n` +
        `👤 *Khách hàng:* ${lockedOrder.username}\n` +
        `🆔 *Mã đơn:* ${newMadon}\n` +
        `🔹 *Dịch vụ:* ${service.Magoi} - ${service.maychu} ${service.name}\n` +
        `🔗 *Link:* ${lockedOrder.link}\n` +
        `🔸 *Rate:* ${rateForUser}\n` +
        `📌 *Số lượng:* ${qty}\n` +
        `💰 *Tiền cũ:* ${Number(Math.floor(Number(oldBalance))).toLocaleString('en-US')} VNĐ\n` +
        `💰 *Tổng tiền:* ${Number(Math.floor(Number(totalCost))).toLocaleString('en-US')} VNĐ\n` +
        `💰 *Tiền còn lại:* ${Number(Math.floor(Number(newBalance))).toLocaleString('en-US')} VNĐ\n` +
        `📆 *Ngày tạo:* ${createdAtVN.toLocaleString('vi-VN', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}\n` +
        `📝 *Ghi chú:* ${lockedOrder.note || 'Không có'}\n` +
        `Nguồn: ${service.DomainSmm?.name || 'N/A'}`;

      const targetChatId = isManualOrder && teleConfig.chatiddontay ? teleConfig.chatiddontay : teleConfig.chatId;
      await sendTelegramNotification({
        telegramBotToken: teleConfig.botToken,
        telegramChatId: targetChatId,
        message: telegramMessage,
      });
    }
    if (teleConfig && teleConfig.bot_notify && updatedUser.telegramChatId) {
      const createdAtVN = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const telegramMessage = `📌 *Mua thành công đơn hàng*\n` +
        `🆔 *Mã đơn:* ${newMadon}\n` +
        `🔹 *Dịch vụ:* ${service.Magoi} - ${service.maychu} ${service.name}\n` +
        `🔗 *Link:* ${lockedOrder.link}\n` +
        `💰 *Tổng tiền:* ${Number(Math.floor(Number(totalCost))).toLocaleString("en-US")} VNĐ\n` +
        `📆 *Ngày tạo:* ${createdAtVN.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n`;

      await sendTelegramNotification({
        telegramBotToken: teleConfig.bot_notify,
        telegramChatId: updatedUser.telegramChatId,
        message: telegramMessage,
      });
    }
    await Scheduled.findByIdAndUpdate(lockedOrder._id, {
      status: 'Success',
      madon: newMadon,
      executedAt: now,
      errorMessage: undefined,
    });
  } catch (error) {
    const safeMessage = sanitizeProviderMessage(error?.message || error);
    await Scheduled.findByIdAndUpdate(lockedOrder._id, {
      status: 'Failed',
      errorMessage: safeMessage,
      executedAt: new Date(),
    });
    console.error(`Hẹn giờ đơn ${lockedOrder._id} thất bại:`, safeMessage);
  }
}
let isProcessing = false;

async function processScheduledOrders(limit = 50) {
  if (isProcessing) {
    console.log('⏳ Cron đang bận, bỏ qua vòng lặp...');
    return;
  }
  isProcessing = true;

  try {
    const now = new Date();

    const pendingOrders = await Scheduled.find({
      status: 'Pending',
      scheduleTime: { $lte: now },
    })
      .sort({ scheduleTime: 1 })
      .limit(limit);

    if (pendingOrders.length === 0) return;

    const tasks = pendingOrders.map((scheduled) =>
      processSingleScheduledOrder(scheduled)
    );

    await Promise.allSettled(tasks);
  } finally {
    isProcessing = false;
  }
}



const scheduledOrderTask = cron.schedule(
  '* * * * *',
  () => {
    processScheduledOrders().catch((error) => {
      console.error('Lỗi xử lý cron hẹn giờ:', error.message);
    });
  },
  {
    scheduled: true,
    timezone: 'Asia/Ho_Chi_Minh',
  }
);

module.exports = {
  processScheduledOrders,
  scheduledOrderTask,
};
