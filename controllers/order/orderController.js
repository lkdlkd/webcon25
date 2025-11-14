const axios = require('axios');
const Service = require('../../models/server');
const Order = require('../../models/Order');
const HistoryUser = require('../../models/History');
const SmmSv = require("../../models/SmmSv");
const SmmApiService = require('../Smm/smmServices'); // hoặc đường dẫn tương ứng
const Telegram = require('../../models/Telegram');
const Counter = require('../../models/Counter');

// Helper: lấy đơn giá theo cấp bậc user (member/vip)
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
// Lấy đơn hàng theo category, user, và từ khóa tìm kiếm (phân trang)
async function getOrders(req, res) {
  const user = req.user;
  const { category, search, status, ordertay } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  // Xây dựng điều kiện tìm kiếm
  let filter = {};
  if (user.role !== 'admin') {
    filter.username = user.username;
  }
  if (category) {
    filter.category = category;
  }
  if (status) {
    filter.status = status;
  }
  if (search) {
    filter.$or = [
      { Madon: { $regex: search, $options: 'i' } },
      { link: { $regex: search, $options: 'i' } }
    ];
  }
  if (ordertay) {
    filter.ordertay = ordertay === 'true';
  }

  try {
    let selectFields = '-SvID -orderId -DomainSmm -lai -tientieu -ordertay'; // Các trường không cần thiết cho người dùng thường
    if (user.role === 'admin') {
      selectFields = ''; // admin xem tất cả các trường
    }

    const orders = await Order.find(filter, selectFields)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('username')
      .populate('DomainSmm', 'name');

    const totalOrders = await Order.countDocuments(filter);

    if (orders.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }

    // Convert DomainSmm to name string for each order
    const ordersWithDomainName = orders.map(order => {
      const o = order.toObject();
      if (o.DomainSmm && typeof o.DomainSmm === 'object' && o.DomainSmm.name) {
        o.DomainSmm = o.DomainSmm.name;
      }
      return o;
    });
    res.status(200).json({
      orders: ordersWithDomainName,
      currentPage: page,
      totalPages: Math.ceil(totalOrders / limit),
      totalOrders
    });
  } catch (error) {
    res.status(500).json({
      message: 'Có lỗi xảy ra khi lấy đơn hàng',
      error: error.message
    });
  }
}
// Hàm xóa đơn hàng (chỉ admin)
async function deleteOrder(req, res) {
  const user = req.user;
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: 'Chỉ admin mới có quyền sử dụng chức năng này' });
  }

  const { orderId } = req.params;
  try {
    const order = await Order.findOneAndDelete({ _id: orderId });
    if (!order) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }
    res.status(200).json({ message: 'Xóa đơn hàng thành công', order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Có lỗi xảy ra khi xóa đơn hàng', error: error.message });
  }
}
// order
async function fetchServiceData(magoi) {
  const serviceFromDb = await Service.findOne({ Magoi: magoi })
    .populate('DomainSmm', 'name')
    .populate('type', 'name');
  if (!serviceFromDb) throw new Error('Dịch vụ không tồn tại');
  return serviceFromDb;
}

async function fetchSmmConfig(domain) {
  const smmSvConfig = await SmmSv.findById(domain);
  if (!smmSvConfig || !smmSvConfig.url_api || !smmSvConfig.api_token) {
    throw new Error('Lỗi khi mua dịch vụ, vui lòng ib admin');
  }
  return smmSvConfig;
}

async function sendTelegramNotification(data) {
  const { telegramBotToken, telegramChatId, message } = data;
  if (telegramBotToken && telegramChatId) {
    try {
      await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        chat_id: telegramChatId,
        text: message,
      });
      console.log('Thông báo Telegram đã được gửi.');
    } catch (error) {
      console.error('Lỗi gửi thông báo Telegram:', error.message);
    }
  } else {
    console.log('Thiếu thông tin cấu hình Telegram.');
  }
}

async function addOrder(req, res) {
  try {
    // Lấy user từ middleware
    const user = req.user;
    const username = user.username;

    // Lấy thông tin từ body
    const { link, category, quantity, magoi, note, comments, ObjectLink } = req.body;
    const qty = Number(quantity);
    const formattedComments = comments ? comments.replace(/\r?\n/g, "\r\n") : "";

    // Lấy thông tin dịch vụ
    const serviceFromDb = await fetchServiceData(magoi);

    // Kiểm tra số dư và số lượng
    const rateForUser = getEffectiveRate(serviceFromDb, user);
    const totalCost = rateForUser * qty;
    const apiRate = serviceFromDb.originalRate; // Giá gốc từ nguồn

    // Kiểm tra nếu là đơn tay (ordertay = true)
    const isManualOrder = serviceFromDb.ordertay === true ? true : false;

    if (!isManualOrder) {
      // Chỉ kiểm tra giá nếu ischeck = true
      if (serviceFromDb.ischeck !== true && apiRate > rateForUser) {
        throw new Error('Lỗi khi mua dịch vụ, vui lòng ib admin');
      }
    }

    if (qty < serviceFromDb.min || qty > serviceFromDb.max) {
      throw new Error('Số lượng không hợp lệ');
    }
    if (user.balance < totalCost) {
      throw new Error('Số dư không đủ để thực hiện giao dịch');
    }
    if (serviceFromDb.isActive === false) {
      throw new Error('Dịch vụ bảo trì, vui lòng liên hệ admin');
    }

    const lai = totalCost - (apiRate * qty);
    const tientieu = apiRate * qty;

    let purchaseOrderId;

    if (isManualOrder) {
      // Đơn tay: tạo orderId ngẫu nhiên
      purchaseOrderId = `m${Math.floor(10000 + Math.random() * 90000)}`;
    } else {
      // Đơn API: gửi yêu cầu mua dịch vụ
      const smmSvConfig = await fetchSmmConfig(serviceFromDb.DomainSmm);
      const smm = new SmmApiService(smmSvConfig.url_api, smmSvConfig.api_token);

      const purchasePayload = {
        link,
        quantity: qty,
        service: serviceFromDb.serviceId,
        comments: formattedComments,
      };
      const purchaseResponse = await smm.order(purchasePayload);

      if (!purchaseResponse || !purchaseResponse.order) {
        // Một số nguồn trả về lỗi theo nhiều dạng khác nhau
        const nestedError = purchaseResponse?.data?.error || purchaseResponse?.error || purchaseResponse?.error?.message;

        if (nestedError) {
          console.error('Đối tác trả về lỗi', nestedError);
          const errRaw = String(nestedError);
          const errStr = errRaw.toLowerCase();
          // Nhạy cảm: số dư, đường link, số điện thoại VN
          const urlRegex = /(https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.(com|net|org|io|vn|co)\b/i;
          const phoneRegexVN = /\b(\+?84|0)(3|5|7|8|9)\d{8}\b/;
          const isSensitive = errStr.includes('số dư') || errStr.includes('balance') || errStr.includes('xu') || errStr.includes('tiền')
            || urlRegex.test(errRaw) || phoneRegexVN.test(errRaw);
          if (isSensitive) {
            throw new Error('Lỗi khi mua dịch vụ, vui lòng thử lại');
          } else {
            throw new Error(String(nestedError));
          }
        } else {
          throw new Error('Lỗi khi mua dịch vụ, vui lòng thử lại');
        }
      }

      purchaseOrderId = purchaseResponse.order;
    }

    // Cập nhật số dư và lưu đơn hàng
    const newBalance = user.balance - totalCost;
    user.balance = newBalance;
    await user.save();

    // Lấy mã đơn từ Counter (tự động tăng)
    let counter = await Counter.findOne({ name: 'orderCounter' });

    if (!counter) {
      // Lần đầu tiên: lấy mã đơn lớn nhất từ Order
      const lastOrder = await Order.findOne({}).sort({ Madon: -1 });
      const maxMadon = lastOrder && lastOrder.Madon ? Number(lastOrder.Madon) : 9999;

      // Khởi tạo counter với giá trị tiếp theo
      counter = await Counter.create({
        name: 'orderCounter',
        value: maxMadon + 1
      });
    } else {
      // Tăng counter và lấy giá trị mới
      counter = await Counter.findOneAndUpdate(
        { name: 'orderCounter' },
        { $inc: { value: 1 } },
        { new: true }
      );
    }

    const newMadon = counter.value;

    const createdAt = new Date();
    // Xây dựng ObjectLink cho các nền tảng facebook / tiktok / instagram
    let normalizedObjectLink = '';
    try {
      if (serviceFromDb.type && serviceFromDb.type.name) {
        const platformRaw = serviceFromDb.type.name.toLowerCase();
        const isFacebook = platformRaw.includes('facebook') || platformRaw === 'fb' || platformRaw.includes(' fb');
        const isTiktok = platformRaw.includes('tiktok') || platformRaw === 'tt';
        const isInstagram = platformRaw.includes('instagram') || platformRaw === 'ig';
        const raw = (ObjectLink || '').trim();
        if (raw) {
          if (isFacebook) {
            if (/^https?:\/\//i.test(raw)) {
              normalizedObjectLink = raw.replace(/^https?:\/\/(facebook\.com)/i, 'https://www.facebook.com');
            } else if (/^facebook\.com\//i.test(raw)) {
              normalizedObjectLink = 'https://www.' + raw;
            } else if (/^fb\.com\//i.test(raw)) {
              normalizedObjectLink = 'https://www.' + raw.replace(/^fb\.com/i, 'facebook.com');
            } else {
              const cleaned = raw.replace(/^\/+/, '');
              normalizedObjectLink = 'https://www.facebook.com/' + cleaned;
            }
          } else if (isTiktok) {
            if (/^https?:\/\//i.test(raw)) {
              normalizedObjectLink = raw;
            } else if (/^tiktok\.com\//i.test(raw)) {
              normalizedObjectLink = 'https://' + raw;
            } else {
              let cleaned = raw.replace(/^\/+/, '');
              if (cleaned.startsWith('@')) cleaned = cleaned; else if (!/\//.test(cleaned)) cleaned = '@' + cleaned;
              normalizedObjectLink = 'https://www.tiktok.com/' + cleaned;
            }
          } else if (isInstagram) {
            if (/^https?:\/\//i.test(raw)) {
              normalizedObjectLink = raw;
            } else if (/^instagram\.com\//i.test(raw)) {
              normalizedObjectLink = 'https://' + raw;
            } else {
              let cleaned = raw.replace(/^\/+/, '');
              if (cleaned.startsWith('@')) cleaned = cleaned.slice(1);
              normalizedObjectLink = 'https://www.instagram.com/' + cleaned.replace(/\/+$/, '');
            }
          }
        }
      }
    } catch (_) { /* ignore normalization error */ }

    const orderData = new Order({
      Madon: newMadon,
      Magoi: serviceFromDb.Magoi,
      username,
      SvID: serviceFromDb.serviceId,
      orderId: purchaseOrderId,
      namesv: `${serviceFromDb.maychu} ${serviceFromDb.name}`,
      category,
      link,
      start: 0,
      quantity: qty,
      rate: rateForUser,
      totalCost,
      status: 'Pending',
      note,
      ObjectLink: normalizedObjectLink || ObjectLink,
      comments: formattedComments,
      DomainSmm: serviceFromDb.DomainSmm,
      tientieu: tientieu,
      lai: lai,
      refil: serviceFromDb.refil,
      cancel: serviceFromDb.cancel,
      ordertay: isManualOrder,
    });

    const HistoryData = new HistoryUser({
      username,
      madon: newMadon,
      hanhdong: 'Tạo đơn hàng',
      link,
      tienhientai: user.balance + totalCost,
      tongtien: totalCost,
      tienconlai: newBalance,
      createdAt,
      mota: `Tăng ${serviceFromDb.maychu} ${serviceFromDb.name} thành công cho uid ${link}`,
    });
    await Service.findOneAndUpdate(
      { Magoi: serviceFromDb.Magoi },
      { $inc: { luotban: 1 } },
      { new: true }
    );

    await orderData.save();
    await HistoryData.save();

    // Gửi thông báo Telegram nếu có cấu hình
    const teleConfig = await Telegram.findOne();
    if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
      // Giờ Việt Nam (UTC+7)
      const createdAtVN = new Date(createdAt.getTime() + 7 * 60 * 60 * 1000);
      const telegramMessage = `📌 *Đơn hàng mới đã được tạo!*\n` +
        `👤 *Khách hàng:* ${username}\n` +
        `🆔 *Mã đơn:* ${newMadon}\n` +
        `🔹 *Dịch vụ:* ${serviceFromDb.maychu} ${serviceFromDb.name}\n` +
        `🔗 *Link:* ${link}\n` +
        `🔸 *Rate:* ${rateForUser}\n` +
        `📌 *Số lượng:* ${qty}\n` +
        `💰 *Tiền cũ:* ${Number(Math.floor(Number(user.balance + totalCost))).toLocaleString("en-US")} VNĐ\n` +
        `💰 *Tổng tiền:* ${Number(Math.floor(Number(totalCost))).toLocaleString("en-US")} VNĐ\n` +
        `💰 *Tiền còn lại:* ${Number(Math.floor(Number(newBalance))).toLocaleString("en-US")} VNĐ\n` +
        `📆 *Ngày tạo:* ${createdAtVN.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n` +
        `📝 *Ghi chú:* ${note || 'Không có'}\n` +
        `Nguồn: ${serviceFromDb.DomainSmm.name}`;
      await sendTelegramNotification({
        telegramBotToken: teleConfig.botToken,
        telegramChatId: teleConfig.chatId,
        message: telegramMessage,
      });
    }

    res.status(200).json({ success: true, message: 'Mua dịch vụ thành công' });
  } catch (error) {
    console.error(error);
    // Nếu có lỗi từ provider, ưu tiên trả message của provider, ẩn thông tin nhạy cảm
    const providerMsgRaw = error?.response?.data?.error || error?.message || '';
    const providerMsg = String(providerMsgRaw || '');
    const errStr = providerMsg.toLowerCase();
    const urlRegex = /(https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.(com|net|org|io|vn|co)\b/i;
    const phoneRegexVN = /\b(\+?84|0)(3|5|7|8|9)\d{8}\b/;
    const isSensitive = errStr.includes('balance') || errStr.includes('xu') || errStr.includes('tiền')
      || urlRegex.test(providerMsg) || phoneRegexVN.test(providerMsg);
    const safeMessage = isSensitive || !providerMsg ? 'Lỗi khi mua dịch vụ, vui lòng thử lại' : providerMsg;
    res.status(500).json({ error: safeMessage });
  }
}
// Hàm cập nhật trạng thái đơn hàng (chỉ admin)
async function updateOrderStatus(req, res) {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Chỉ admin mới có quyền cập nhật đơn hàng' });
    }
    const { Madon } = req.params;
    const { start, dachay, status, iscancel } = req.body;
    const order = await Order.findOne({ Madon });
    if (!order) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    if (start !== undefined) order.start = start;
    if (dachay !== undefined) order.dachay = dachay;
    if (status !== undefined) order.status = status;
    if (iscancel !== undefined) order.iscancel = iscancel;
    await order.save();
    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}


module.exports = {
  addOrder,
  deleteOrder,
  getOrders,
  updateOrderStatus,
};
