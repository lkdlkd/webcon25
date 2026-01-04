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
let tongdon = 0;

// ===== CONFIG =====
const CHUNK_SIZE = 50; // tăng lên 50 đơn/chunk để giảm số lần gọi API
const PER_DOMAIN_INTERVAL_MS = 10_000; // giảm xuống 10s
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000; // tăng timeout
const BATCH_SIZE = 500; // tăng batch size
const MAX_TOTAL_ORDERS = 5000; // tăng số đơn xử lý
const MAX_RETRIES = 3;
const MAX_PARALLEL_DOMAINS = 3; // số nguồn gọi song song

// Helper: Kiểm tra lỗi nghiêm trọng không cần retry
const isFatalError = (msg, code) => {
  const fatalPatterns = /api key|authentication|unauthorized|forbidden|invalid.*key|key.*invalid|không tồn tại|incorrect.*order.*id/i;
  return fatalPatterns.test(msg) || fatalPatterns.test(code) || code === 500;
};

// Helper: Kiểm tra lỗi mạng tạm thời
const isTransientError = (msg, code) => {
  return code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'read ECONNRESET' ||
    /ECONNRESET|socket hang up|network error|timeout/i.test(msg);
};

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

function queueTelegramNotification(teleConfig, order, soTienHoan, quantity, isApproved, phihoan) {
  if (!teleConfig?.botToken || !teleConfig?.chatidnaptien) return;

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
    chatId: teleConfig.chatidnaptien,
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

// Helper: timeout wrapper cho promise
function withTimeout(promise, ms, label = 'request') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`TIMEOUT: ${label} exceeded ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function checkOrderStatus() {
  if (isChecking) {
    const elapsed = Math.round((Date.now() - checkStartTime) / 1000);
    console.warn(`⚠️ Bỏ qua: Đang chạy ${elapsed}s - Đã xử lý ${processedOrdersCount}/${tongdon} đơn`);
    return;
  }

  isChecking = true;
  checkStartTime = Date.now();
  processedOrdersCount = 0;
  tongdon = 0;

  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // Đếm tổng số đơn cần xử lý
    const totalCount = await Order.countDocuments({
      status: { $in: ["Pending", "In progress", "Processing"] },
      createdAt: { $gte: threeMonthsAgo },
      ordertay: { $ne: true },
      DomainSmm: { $exists: true }
    });

    console.log(`📊 Tổng ${totalCount} đơn cần kiểm tra`);

    if (totalCount === 0) {
      console.log("⏳ Không có đơn đang chạy.");
      return;
    }

    // Xác định số batch cần lấy
    const maxOrdersToProcess = Math.min(totalCount, MAX_TOTAL_ORDERS);
    const numBatches = Math.ceil(maxOrdersToProcess / BATCH_SIZE);

    console.log(`🔄 Sẽ xử lý ${maxOrdersToProcess} đơn trong ${numBatches} batch(es)`);

    let allRunningOrders = [];

    // Lấy orders theo batch với pagination
    for (let batchIndex = 0; batchIndex < numBatches; batchIndex++) {
      const skip = batchIndex * BATCH_SIZE;
      const limit = Math.min(BATCH_SIZE, maxOrdersToProcess - skip);

      console.log(`📥 Batch ${batchIndex + 1}/${numBatches}: skip=${skip}, limit=${limit}`);

      const batchOrders = await Order.find({
        status: { $in: ["Pending", "In progress", "Processing"] },
        createdAt: { $gte: threeMonthsAgo },
        ordertay: { $ne: true },
        DomainSmm: { $exists: true }
      })
        .skip(skip)
        .limit(limit)
        .lean();

      // Filter cực kỳ an toàn: loại bỏ null, undefined, false, true, 0, '', {}, []
      const validOrders = batchOrders.filter(o => {
        const d = o.DomainSmm;
        if (!d || typeof d === 'boolean' || typeof d === 'number' && d === 0) return false;
        if (typeof d === 'string') return d.trim().length > 0;
        if (Array.isArray(d)) return d.length > 0;
        if (typeof d === 'object') return Object.keys(d).length > 0;
        return true;
      });

      allRunningOrders = allRunningOrders.concat(validOrders);
      console.log(`✓ Batch ${batchIndex + 1}: ${validOrders.length} đơn hợp lệ`);
    }

    const runningOrders = allRunningOrders;
    console.log(`⏳ Tổng cộng ${runningOrders.length} đơn hợp lệ với DomainSmm.`);

    tongdon = runningOrders.length;

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
      // Đã hoàn → bỏ qua
      if (refundedMadons.has(order.Madon)) continue;

      // KHÔNG CÓ DOMAIN SMM → BỎ QUA
      if (!order.DomainSmm || !String(order.DomainSmm).trim()) {
        console.warn(`⚠️ Bỏ qua đơn ${order.Madon} vì không có DomainSmm`);
        continue;
      }

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

    // Cache users một lần cho tất cả orders
    const allUsernames = [...new Set(runningOrders.map(o => o.username))];
    const allUsers = await User.find({ username: { $in: allUsernames } }).lean();
    const globalUserCache = new Map(allUsers.map(u => [u.username, u]));

    // Tạo state cho từng nguồn (vòng lặp round-robin để xử lý hết đơn trong 1 lần cron)
    const domainStates = {};
    for (const groupKey in groups) {
      const { smmService, smmConfig, orders } = groups[groupKey];
      // Filter và validate order IDs: phải là số hoặc string không rỗng
      const orderIds = orders
        .map(o => o.orderId)
        .filter(id => {
          if (!id) return false;
          if (typeof id === 'number') return true;
          if (typeof id === 'string') return id.trim().length > 0;
          return false;
        });

      if (orderIds.length === 0) {
        console.warn(`⚠️ [${groupKey}] Không có order ID hợp lệ, bỏ qua nguồn này`);
        continue;
      }

      const chunks = chunkArray(orderIds, CHUNK_SIZE).map(ids => ({ ids, tries: 0 }));
      domainStates[groupKey] = {
        smmService,
        smmConfig,
        orders,
        chunks,
        nextAvailableAt: 0, // có thể gọi ngay
      };
    }

    // Vòng lặp: xử lý song song nhiều nguồn
    while (true) {
      const now = Date.now();

      // Lấy các nguồn sẵn sàng để gọi (tối đa MAX_PARALLEL_DOMAINS)
      const readyDomains = Object.entries(domainStates)
        .filter(([_, s]) => s.chunks.length > 0 && now >= s.nextAvailableAt)
        .slice(0, MAX_PARALLEL_DOMAINS);

      if (readyDomains.length === 0) {
        const hasPending = Object.values(domainStates).some(s => s.chunks.length > 0);
        if (!hasPending) break;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // Xử lý song song các nguồn
      await Promise.all(readyDomains.map(async ([groupKey, state]) => {

        const { ids, tries } = state.chunks.shift();
        const currentChunkSet = new Set(ids.map(String));
        let resData = {};
        try {
          const res = await withTimeout(
            state.smmService.multiStatus(ids),
            REQUEST_TIMEOUT_MS,
            `multiStatus ${groupKey}`
          );

          // Response không hợp lệ
          if (!res || typeof res !== 'object') {
            if (tries < MAX_RETRIES) state.chunks.push({ ids, tries: tries + 1 });
            state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;
            return;
          }

          const rawErr = res.error || res.err || res.Error;
          if (rawErr) {
            const errCode = typeof rawErr === 'string' ? rawErr : (rawErr?.code || rawErr?.error || '');
            const msg = typeof rawErr === 'string' ? rawErr : (rawErr?.message || '');
            const code = Number(res.code || res.status) || 0;

            // Lỗi nghiêm trọng - bỏ qua
            if (isFatalError(msg, errCode) || isFatalError(msg, code)) {
              console.warn(`🚫 [${groupKey}] Bỏ chunk (${ids.length} IDs): ${errCode || msg}`);
              state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;
              return;
            }

            // Rate limit
            if (code === 429 || /rate|limit|too many/i.test(msg)) {
              state.chunks.unshift({ ids, tries });
              state.nextAvailableAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
              return;
            }

            // Retry nếu chưa quá giới hạn
            if (tries < MAX_RETRIES) {
              state.chunks.push({ ids, tries: tries + 1 });
            } else {
              console.warn(`🚫 [${groupKey}] Bỏ chunk sau ${tries} lần (${ids.length} IDs)`);
            }
            state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;
            return;
          }

          resData = res;
        } catch (err) {
          const errCode = err?.code || '';
          const msg = err?.message || '';

          // Lỗi nghiêm trọng
          if (isFatalError(msg, errCode)) {
            console.warn(`🚫 [${groupKey}] Bỏ chunk: ${errCode || msg}`);
            state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;
            return;
          }

          // Lỗi mạng tạm thời hoặc timeout - retry
          if (isTransientError(msg, errCode) && tries < MAX_RETRIES) {
            state.chunks.push({ ids, tries: tries + 1 });
          } else if (tries >= MAX_RETRIES) {
            console.warn(`🚫 [${groupKey}] Bỏ chunk sau ${tries} lần`);
          }
          state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;
          return;
        }

        // Đặt giãn cách cho lần gọi tiếp theo
        state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;

        // Filter orders có lỗi riêng lẻ
        let validCount = 0;
        for (const key in resData) {
          if (resData[key]?.error || resData[key]?.err) {
            delete resData[key];
          } else {
            validCount++;
          }
        }

        if (validCount === 0) return;
        console.log(`📦 [${groupKey}] ${validCount}/${ids.length} đơn OK (còn ${state.chunks.length} chunk)`);

        // Arrays cho chunk
        const chunkOrdersToUpdate = [];
        const chunkRefundsToInsert = [];
        const chunkHistoriesToInsert = [];
        const chunkUserBalanceChanges = new Map();

        // Xử lý orders trong chunk
        for (const order of state.orders) {
          const key = String(order.orderId || '');
          if (!currentChunkSet.has(key)) continue;

          const statusObj = resData[key];
          if (!statusObj) continue;

          const mappedStatus = mapStatus(statusObj.status);
          if (!mappedStatus) continue;

          const updateData = {};
          const remains = Number(statusObj.remains) || 0;
          const startCount = statusObj.start_count;

          // Update status
          if (mappedStatus !== order.status) updateData.status = mappedStatus;

          // Update start
          if (startCount !== undefined && startCount !== order.start) updateData.start = startCount;

          // Update dachay
          const newDachay = ['Pending', 'In progress', 'Processing'].includes(mappedStatus) && remains === 0
            ? 0 : (statusObj.remains !== undefined ? order.quantity - remains : undefined);
          if (newDachay !== undefined && newDachay !== order.dachay) updateData.dachay = newDachay;

          const user = globalUserCache.get(order.username);
          if (!user) {
            if (Object.keys(updateData).length > 0) {
              chunkOrdersToUpdate.push({ filter: { _id: order._id }, update: updateData });
            }
            continue;
          }

          const phihoan = state.smmConfig.phihoan || 1000;
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
            const isApproved = state.smmConfig.autohoan === 'on';
            if (mappedStatus === 'Canceled') updateData.dachay = 0;

            const refundDesc = `Hệ thống hoàn cho bạn ${Math.floor(soTienHoan).toLocaleString('en-US')}đ tương đương với số lượng ${chuachay} cho uid ${order.link} và ${phihoan} phí dịch vụ`;

            chunkRefundsToInsert.push({
              updateOne: {
                filter: { madon: order.Madon },
                update: {
                  $setOnInsert: {
                    username: order.username, madon: order.Madon, link: order.link,
                    server: order.namesv || '', soluongmua: order.quantity, giatien: order.rate,
                    chuachay, tonghoan: soTienHoan, noidung: refundDesc,
                    status: isApproved, createdAt: new Date()
                  }
                },
                upsert: true
              }
            });

            if (isApproved) {
              const prevChange = chunkUserBalanceChanges.get(order.username) || 0;
              chunkUserBalanceChanges.set(order.username, prevChange + soTienHoan);

              chunkHistoriesToInsert.push({
                username: order.username, madon: order.Madon, hanhdong: "Hoàn tiền",
                link: order.link, tienhientai: user.balance, tongtien: soTienHoan,
                tienconlai: user.balance + prevChange + soTienHoan,
                mota: refundDesc, createdAt: new Date()
              });
              updateData.iscancel = false;
            } else {
              updateData.iscancel = true;
            }

            queueTelegramNotification(teleConfig, order, soTienHoan, chuachay, isApproved, phihoan);
          }

          if (Object.keys(updateData).length > 0 && hasOrderChanged(updateData, order)) {
            chunkOrdersToUpdate.push({ filter: { _id: order._id }, update: updateData });
          }
          processedOrdersCount++;
        }

        // Bulk operations
        const bulkOps = [];

        if (chunkOrdersToUpdate.length > 0) {
          bulkOps.push(Order.bulkWrite(
            chunkOrdersToUpdate.map(({ filter, update }) => ({ updateOne: { filter, update: { $set: update } } })),
            { ordered: false }
          ));
        }

        if (chunkRefundsToInsert.length > 0) {
          bulkOps.push(Refund.bulkWrite(chunkRefundsToInsert, { ordered: false }));
        }

        if (chunkHistoriesToInsert.length > 0) {
          bulkOps.push(HistoryUser.insertMany(chunkHistoriesToInsert, { ordered: false }));
        }

        if (chunkUserBalanceChanges.size > 0) {
          const userOps = [...chunkUserBalanceChanges.entries()]
            .filter(([_, amt]) => amt > 0)
            .map(([username, amt]) => ({ updateOne: { filter: { username }, update: { $inc: { balance: amt } } } }));
          if (userOps.length > 0) bulkOps.push(User.bulkWrite(userOps, { ordered: false }));
        }

        if (bulkOps.length > 0) {
          await Promise.all(bulkOps);
          console.log(
            `💾 [${groupKey}] Đã lưu ${chunkOrdersToUpdate.length} orders, ` +
            `${chunkRefundsToInsert.length} refunds, ` +
            `${chunkHistoriesToInsert.length} histories, ` +
            `${chunkUserBalanceChanges.size} users`
          );
        }
      })); // end Promise.all for parallel domains
    }
    // end while loop: all chunks processed

    totalProcessedOrders += processedOrdersCount;
    const elapsed = Math.round((Date.now() - checkStartTime) / 1000);
    console.log(`✅ Xử lý don hang ${processedOrdersCount}/${runningOrders.length} đơn trong ${elapsed}s | Còn lại: ${totalProcessedOrders < totalCount ? (totalCount - totalProcessedOrders) : 0} đơn`);

  } catch (err) {
    console.error("❌ Lỗi:", err.message);
  } finally {
    isChecking = false;
    totalProcessedOrders = 0;
    tongdon = 0;
  }
}
function hasOrderChanged(updateData, existingOrder) {
  return Object.entries(updateData).some(([key, value]) => {
    const oldValue = existingOrder[key];

    // Bỏ qua undefined/null
    if (value === undefined) return false;

    // So sánh number với number
    if (typeof value === 'number' && typeof oldValue === 'number') {
      return value !== oldValue;
    }

    // So sánh string với string
    if (typeof value === 'string' && typeof oldValue === 'string') {
      return value.trim() !== oldValue.trim();
    }

    // So sánh các kiểu khác
    return value != oldValue; // loose comparison cho an toàn
  });
}

// Cron: Chạy mỗi phút
cron.schedule('*/1 * * * *', () => {
  console.log("⏱️ Cron: Kiểm tra đơn hàng...");
  checkOrderStatus();
});

console.log("🚀 Cronjob checkOrderStatus Ultra Optimized v4.0");
