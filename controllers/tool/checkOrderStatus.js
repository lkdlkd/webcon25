const cron = require('node-cron');
const Order = require('../../models/Order');
const SmmSv = require('../../models/SmmSv');
const SmmApiService = require('../Smm/smmServices');
const User = require('../../models/User');
const HistoryUser = require('../../models/History');
const axios = require('axios');
const Telegram = require('../../models/Telegram');
const Refund = require('../../models/Refund');

// ===== ANTI-OVERLAP =====
let isChecking = false;
let checkStartTime = null;
let processedOrdersCount = 0;
let totalProcessedOrders = 0;

// ===== TELEGRAM QUEUE (tránh spam API) =====
const telegramQueue = [];
let isSendingTelegram = false;

async function processTelegramQueue() {
  if (isSendingTelegram || telegramQueue.length === 0) return;

  isSendingTelegram = true;
  while (telegramQueue.length > 0) {
    const message = telegramQueue.shift();
    try {
      await axios.post(`https://api.telegram.org/bot${message.botToken}/sendMessage`, {
        chat_id: message.chatId,
        text: message.text,
        parse_mode: 'Markdown'
      });
      await new Promise(resolve => setTimeout(resolve, 100)); // Delay 100ms giữa các message
    } catch (err) {
      console.error('❌ Lỗi gửi Telegram:', err.message);
    }
  }
  isSendingTelegram = false;
}

function queueTelegramNotification(teleConfig, order, soTienHoan, quantity, isApproved) {
  if (!teleConfig?.botToken || !teleConfig?.chatId) return;

  const title = isApproved ? 'THÔNG BÁO HOÀN TIỀN!' : 'THÔNG BÁO HOÀN TIỀN CHƯA DUYỆT!';
  const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const text =
    `📌 *${title}*\n` +
    `👤 *Khách hàng:* ${order.username}\n` +
    `💳 Mã đơn: ${order.Madon}\n` +
    `💰 *Số tiền hoàn:* ${Number(Math.floor(soTienHoan)).toLocaleString("en-US")}₫\n` +
    `🔹 Số lượng: ${quantity} × rate : ${order.rate}\n` +
    `🔸 Dịch vụ: ${order.namesv}\n` +
    `⏰ ${taoluc.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

  telegramQueue.push({
    botToken: teleConfig.botToken,
    chatId: teleConfig.chatId,
    text
  });

  // Trigger xử lý queue
  processTelegramQueue();
}

const chunkArray = (arr, size) => {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
};

function mapStatus(status) {
  const mapping = {
    "Pending": "Pending",
    "Processing": "Processing",
    "Completed": "Completed",
    "In progress": "In progress",
    "Partial": "Partial",
    "Canceled": "Canceled"
  };
  return mapping[status] || null;
}

async function checkOrderStatus() {
  if (isChecking) {
    const elapsed = Math.round((Date.now() - checkStartTime) / 1000);
    console.warn(`⚠️ Bỏ qua: Đang chạy ${elapsed}s - Đã xử lý ${processedOrdersCount}/${totalProcessedOrders}`);
    return;
  }

  isChecking = true;
  checkStartTime = Date.now();
  processedOrdersCount = 0;

  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // BATCH 1: Lấy orders (giới hạn 500 đơn/lần để tránh quá tải)
    const runningOrders = await Order.find({
      status: { $in: ["Pending", "In progress", "Processing"] },
      createdAt: { $gte: threeMonthsAgo }
    }).limit(1000).lean();

    if (!runningOrders.length) {
      console.log("⏳ Không có đơn đang chạy.");
      return;
    }

    // BATCH 2: Parallel queries (Refund + Telegram)
    const [existingRefunds, teleConfig] = await Promise.all([
      Refund.find({ madon: { $in: runningOrders.map(o => o.Madon) } }).select('madon').lean(),
      Telegram.findOne().lean()
    ]);

    const refundedMadons = new Set(existingRefunds.map(r => r.madon));

    // BATCH 3: Cache SmmSv (query tất cả một lần)
    const uniqueDomainSmmIds = [...new Set(runningOrders.map(o => o.DomainSmm?.toString()).filter(Boolean))];
    const smmConfigs = await SmmSv.find({ _id: { $in: uniqueDomainSmmIds } }).lean();
    const smmConfigCache = {};
    smmConfigs.forEach(cfg => smmConfigCache[cfg._id.toString()] = cfg);

    // Group orders
    const groups = {};
    for (const order of runningOrders) {
      if (refundedMadons.has(order.Madon) || !order.DomainSmm) continue;

      const domainSmmId = order.DomainSmm.toString();
      const smmConfig = smmConfigCache[domainSmmId];
      if (!smmConfig?.url_api || !smmConfig?.api_token) continue;

      if (!groups[domainSmmId]) {
        groups[domainSmmId] = {
          smmService: new SmmApiService(smmConfig.url_api, smmConfig.api_token),
          smmConfig,
          orders: []
        };
      }
      groups[domainSmmId].orders.push(order);
    }

    // Arrays cho bulk operations
    const ordersToUpdate = [];
    const refundsToInsert = [];
    const historiesToInsert = [];
    const usersToUpdate = new Map();

    // Xử lý từng group
    for (const groupKey in groups) {
      const { smmService, smmConfig, orders } = groups[groupKey];

      // PARALLEL API CALLS (chia chunks và gọi song song)
      const orderIdChunks = chunkArray(orders.map(o => o.orderId), 50);
      const apiPromises = orderIdChunks.map(chunk =>
        smmService.multiStatus(chunk).catch(err => {
          console.error(`❌ API error:`, err.message);
          return {};
        })
      );

      const apiResults = await Promise.all(apiPromises);
      const allData = Object.assign({}, ...apiResults);

      // BATCH 4: Cache Users cho group này
      const usernames = [...new Set(orders.map(o => o.username))];
      const users = await User.find({ username: { $in: usernames } }).lean();
      const userCache = {};
      users.forEach(u => {
        userCache[u.username] = u;
        if (!usersToUpdate.has(u.username)) {
          usersToUpdate.set(u.username, { ...u, balanceChange: 0 });
        }
      });

      // Xử lý orders
      for (const order of orders) {
        const statusObj = allData[order.orderId?.toString()];
        if (!statusObj) continue;

        const mappedStatus = mapStatus(statusObj.status);
        const updateData = {};

        if (mappedStatus) updateData.status = mappedStatus;
        if (statusObj.start_count !== undefined) updateData.start = statusObj.start_count;

        if (['Pending', 'In progress', 'Processing'].includes(mappedStatus) && Number(statusObj.remains) === 0) {
          updateData.dachay = 0;
        } else if (statusObj.remains !== undefined) {
          updateData.dachay = order.quantity - Number(statusObj.remains);
        }

        const user = userCache[order.username];
        if (!user) {
          if (Object.keys(updateData).length > 0) {
            ordersToUpdate.push({ filter: { _id: order._id }, update: updateData });
          }
          continue;
        }

        const phihoan = smmConfig.phihoan || 1000;
        let soTienHoan = 0;
        let chuachay = 0;

        if (mappedStatus === 'Partial') {
          chuachay = statusObj.remains || 0;
          soTienHoan = (chuachay * order.rate) - phihoan;
        } else if (mappedStatus === 'Canceled') {
          chuachay = order.quantity;
          soTienHoan = (chuachay * order.rate) - phihoan;
        }

        if (soTienHoan > 50 && ['Partial', 'Canceled'].includes(mappedStatus)) {
          const isApproved = smmConfig.autohoan === 'on';

          // Prepare refund
          refundsToInsert.push({
            updateOne: {
              filter: { madon: order.Madon },
              update: {
                $setOnInsert: {
                  username: order.username,
                  madon: order.Madon,
                  link: order.link,
                  server: order.namesv || '',
                  soluongmua: order.quantity,
                  giatien: order.rate,
                  chuachay,
                  tonghoan: soTienHoan,
                  noidung: `Hoàn ${Number(soTienHoan).toLocaleString('en-US')}₫ (${chuachay} chưa chạy, phí ${phihoan})`,
                  status: isApproved,
                  createdAt: new Date()
                }
              },
              upsert: true
            }
          });

          if (isApproved) {
            const userData = usersToUpdate.get(order.username);
            userData.balanceChange += soTienHoan;

            historiesToInsert.push({
              username: order.username,
              madon: order.Madon,
              hanhdong: "Hoàn tiền",
              link: order.link,
              tienhientai: user.balance,
              tongtien: soTienHoan,
              tienconlai: user.balance + userData.balanceChange,
              mota: `Hoàn ${Number(soTienHoan).toLocaleString('en-US')}₫`,
              createdAt: new Date()
            });

            updateData.iscancel = false;
          } else {
            updateData.iscancel = true;
          }

          queueTelegramNotification(teleConfig, order, soTienHoan, chuachay, isApproved);
        }

        if (Object.keys(updateData).length > 0) {
          ordersToUpdate.push({ filter: { _id: order._id }, update: updateData });
        }

        processedOrdersCount++;
      }
    }

    // ===== BULK OPERATIONS (Giảm queries xuống tối thiểu) =====
    const bulkPromises = [];

    // Bulk update Orders
    if (ordersToUpdate.length > 0) {
      const bulkOps = ordersToUpdate.map(({ filter, update }) => ({
        updateOne: { filter, update: { $set: update } }
      }));
      bulkPromises.push(Order.bulkWrite(bulkOps, { ordered: false }));
    }

    // Bulk upsert Refunds
    if (refundsToInsert.length > 0) {
      bulkPromises.push(Refund.bulkWrite(refundsToInsert, { ordered: false }));
    }

    // Bulk insert Histories
    if (historiesToInsert.length > 0) {
      bulkPromises.push(HistoryUser.insertMany(historiesToInsert, { ordered: false }));
    }

    // Bulk update Users
    const userBulkOps = [];
    for (const [username, userData] of usersToUpdate.entries()) {
      if (userData.balanceChange > 0) {
        userBulkOps.push({
          updateOne: {
            filter: { username },
            update: { $inc: { balance: userData.balanceChange } }
          }
        });
      }
    }
    if (userBulkOps.length > 0) {
      bulkPromises.push(User.bulkWrite(userBulkOps, { ordered: false }));
    }

    // Execute all bulk operations in parallel
    await Promise.all(bulkPromises);

    totalProcessedOrders += processedOrdersCount;
    const elapsed = Math.round((Date.now() - checkStartTime) / 1000);
    console.log(`✅ Xử lý ${processedOrdersCount}/${runningOrders.length} đơn trong ${elapsed}s | Tổng: ${totalProcessedOrders}`);

  } catch (err) {
    console.error("❌ Lỗi:", err.message);
  } finally {
    isChecking = false;
    totalProcessedOrders = 0;
  }
}

// Cron: Chạy mỗi phút
cron.schedule('*/1 * * * *', () => {
  console.log("⏱️ Cron: Kiểm tra đơn hàng...");
  checkOrderStatus();
});

console.log("🚀 Cronjob checkOrderStatus Ultra Optimized v4.0");
