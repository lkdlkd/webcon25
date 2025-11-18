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

// ===== PER-SOURCE PAGINATION (mỗi nguồn chỉ gọi 1 chunk tối đa 100 đơn/lần) =====
const domainChunkState = {}; // { [domainId]: { nextIndex: number } }
const CHUNK_SIZE = 50; // tối đa 100 đơn/1 lần gọi API theo yêu cầu
const MAX_CHUNK_PER_RUN = 1; // mỗi nguồn chỉ xử lý 1 chunk mỗi lần cron
const PER_DOMAIN_INTERVAL_MS = 15_000; // thời gian giãn cách tối thiểu giữa 2 lần gọi 1 nguồn
const RATE_LIMIT_COOLDOWN_MS = 60_000; // cooldown khi bị rate limit
const REQUEST_TIMEOUT_MS = 15_000; // timeout cho mỗi lần gọi trạng thái chunk
const BATCH_SIZE = 500; // số đơn tối đa mỗi batch query
const MAX_TOTAL_ORDERS = 5000; // số đơn tối đa xử lý mỗi lần chạy cron

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

    // Arrays cho bulk operations
    const ordersToUpdate = [];
    const refundsToInsert = [];
    const historiesToInsert = [];
    const usersToUpdate = new Map();

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

    // Vòng lặp: xử lý hết tất cả chunks của mọi nguồn
    while (true) {
      let didWork = false;

      for (const groupKey in domainStates) {
        const state = domainStates[groupKey];
        if (!state.chunks.length) continue;
        const now = Date.now();
        if (now < state.nextAvailableAt) continue; // phải chờ giãn cách giữa 2 lần gọi cùng nguồn

        const { ids, tries } = state.chunks.shift();
        const currentChunkSet = new Set(ids.map(id => id?.toString()));
        let resData = {};
        try {
          const res = await withTimeout(
            state.smmService.multiStatus(ids),
            REQUEST_TIMEOUT_MS,
            `multiStatus ${groupKey} size=${ids.length}`
          );
          // Kiểm tra response hợp lệ
          if (!res || typeof res !== 'object') {
            console.error(`❌ [${groupKey}] Response không hợp lệ (null/undefined/not object)`);
            console.error(res);
            state.chunks.push({ ids, tries: tries + 1 });
            state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
            continue;
          }

          const rawErr = res.error || res.err || res.Error;
          const codeErr = res.code || res.status;
          // Nếu có error field hoặc response không chứa data hợp lệ
          if (rawErr) {
            const code = Number(codeErr) || 0;
            const errCode = typeof rawErr === 'string' ? rawErr : (rawErr?.code || rawErr?.error || rawErr?.name);
            const msg = typeof rawErr === 'string' ? rawErr : (rawErr?.message || '');

            if ((rawErr?.code === 'ETIMEDOUT') || /timeout/i.test(msg)) {
              console.warn(`⏰ [${groupKey}] TIMEOUT chunk (size=${ids.length}) sau ${REQUEST_TIMEOUT_MS}ms`);
              state.chunks.push({ ids, tries: tries + 1 });
              state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
              continue;
            }

            if (errCode === 'read ECONNRESET' || errCode === 'ECONNRESET' || errCode === 'ECONNABORTED' || /ECONNRESET|socket hang up|network error/i.test(msg)) {
              console.warn(`🌐 [${groupKey}] NETWORK ERROR (${errCode || 'unknown'}) chunk (size=${ids.length}): ${msg}`);
              if (tries >= 2) {
                console.error(`🚫 [${groupKey}] Bỏ chunk sau ${tries} lần ECONNRESET`);
                continue;
              }
              state.chunks.push({ ids, tries: tries + 1 });
              state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
              continue;
            }

            console.error(`❌ [${groupKey}] Lỗi chunk (size=${ids.length})`, { status: code, code: errCode, error: msg });
            if (/incorrect.*order.*id/i.test(msg) || /incorrect.*order.*id/i.test(errCode)) {
              console.warn(`🚫 [${groupKey}] Bỏ chunk do order IDs không hợp lệ (${ids.length} IDs)`);
              continue;
            }
            if (code === 500) {
              console.warn(`🚫 [${groupKey}] Bỏ chunk do lỗi 500 từ server (${ids.length} IDs)`);
              continue;
            }

            if (code === 429 || /rate|limit|too many/i.test(msg)) {
              state.nextAvailableAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
              state.chunks.unshift({ ids, tries });
            } else {
              state.chunks.push({ ids, tries: tries + 1 });
            }
            state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
            continue;
          }
          // Response hợp lệ: assign data
          resData = Object.assign({}, res);
        } catch (err) {
          const code = err?.response?.status;
          const errCode = (typeof err === 'string') ? err : (err?.code || err?.error);
          const msg = (typeof err === 'string') ? err : (err?.message || '');
          if ((err?.code === 'ETIMEDOUT') || /timeout/i.test(msg)) {
            console.warn(`⏰ [${groupKey}] TIMEOUT chunk (size=${ids.length}) sau ${REQUEST_TIMEOUT_MS}ms`);
            // timeout: đẩy chunk về cuối để thử lại sau, giữ pacing
            state.chunks.push({ ids, tries: tries + 1 });
            state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
            continue;
          }
          // Network transient errors (e.g., ECONNRESET / socket hang up)
          if (errCode === 'read ECONNRESET' || errCode === 'ECONNRESET' || errCode === 'ECONNABORTED' || /ECONNRESET|socket hang up|network error/i.test(msg)) {
            console.warn(`🌐 [${groupKey}] NETWORK ERROR (${errCode || 'unknown'}) chunk (size=${ids.length}): ${msg}`);

            if (tries >= 2) {
              console.error(`🚫 [${groupKey}] Bỏ chunk sau ${tries} lần ECONNRESET`);
              continue; // bỏ qua chunk này
            }
            state.chunks.push({ ids, tries: tries + 1 });
            state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
            continue;
          }
          console.error(`❌ [${groupKey}] Lỗi chunk (size=${ids.length})`, { status: code, code: errCode, error: msg });

          // Nếu là lỗi "Incorrect order IDs" -> bỏ qua chunk này (không retry)
          if (/incorrect.*order.*id/i.test(msg) || /incorrect.*order.*id/i.test(errCode)) {
            console.warn(`🚫 [${groupKey}] Bỏ chunk do order IDs không hợp lệ (${ids.length} IDs)`);
            continue;
          }

          // Nếu rate limit -> đặt cooldown và đẩy chunk lại đầu hàng đợi
          if (code === 429 || /rate|limit|too many/i.test(msg)) {
            state.nextAvailableAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            state.chunks.unshift({ ids, tries });
          } else {
            // lỗi khác: đẩy chunk về cuối để thử lại sau
            state.chunks.push({ ids, tries: tries + 1 });
          }

          // đặt giãn cách tối thiểu trước khi gọi lại nguồn này
          state.nextAvailableAt = Math.max(state.nextAvailableAt, Date.now() + PER_DOMAIN_INTERVAL_MS);
          continue;
        }

        // Gọi OK: đặt giãn cách cho lần gọi tiếp theo của nguồn này
        state.nextAvailableAt = Date.now() + PER_DOMAIN_INTERVAL_MS;
        const returnedKeys = new Set(Object.keys(resData || {}));
        console.log(`📦 [${groupKey}] trả ${returnedKeys.size}/${ids.length} đơn (còn ${state.chunks.length} chunk chờ)`);

        // Cache Users cho group này (1 lần mỗi vòng lặp domain)
        const usernames = [...new Set(state.orders.map(o => o.username))];
        const users = await User.find({ username: { $in: usernames } }).lean();
        const userCache = {};
        users.forEach(u => {
          userCache[u.username] = u;
          if (!usersToUpdate.has(u.username)) {
            usersToUpdate.set(u.username, { ...u, balanceChange: 0 });
          }
        });

        // Arrays cho chunk hiện tại
        const chunkOrdersToUpdate = [];
        const chunkRefundsToInsert = [];
        const chunkHistoriesToInsert = [];
        const chunkUsersToUpdate = new Map();

        // Xử lý chỉ các order có dữ liệu trả về trong chunk
        for (const order of state.orders) {
          const key = order.orderId?.toString();
          if (!currentChunkSet.has(key)) continue;
          const statusObj = resData[key];
          if (!statusObj) continue; // thiếu -> sẽ được thử lại bởi chunk kế tiếp
          const mappedStatus = mapStatus(statusObj.status);
          const updateData = {};

          // Chỉ update status nếu thay đổi
          if (mappedStatus && mappedStatus !== order.status) {
            updateData.status = mappedStatus;
          }

          // Chỉ update start nếu thay đổi
          if (statusObj.start_count !== undefined && statusObj.start_count !== order.start) {
            updateData.start = statusObj.start_count;
          }

          // Tính dachay mới
          let newDachay;
          if (['Pending', 'In progress', 'Processing'].includes(mappedStatus) && Number(statusObj.remains) === 0) {
            newDachay = 0;
          } else if (statusObj.remains !== undefined) {
            newDachay = order.quantity - Number(statusObj.remains);
          }

          // Chỉ update dachay nếu thay đổi
          if (newDachay !== undefined && newDachay !== order.dachay) {
            updateData.dachay = newDachay;
          }

          const user = userCache[order.username];
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

            // Nếu Canceled, set dachay = 0 (chưa chạy gì)
            if (mappedStatus === 'Canceled') {
              updateData.dachay = 0;
            }

            // Prepare refund
            chunkRefundsToInsert.push({
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
                    noidung: `Hệ thống hoàn cho bạn ${Number(Math.floor(soTienHoan)).toLocaleString('en-US')}đ tương đương với số lượng ${chuachay} cho uid ${order.link} và ${phihoan} phí dịch vụ`,
                    status: isApproved,
                    createdAt: new Date()
                  }
                },
                upsert: true
              }
            });

            if (isApproved) {
              const userData = chunkUsersToUpdate.get(order.username) || {
                username: order.username,
                balance: user.balance,
                balanceChange: 0
              };
              userData.balanceChange = (userData.balanceChange || 0) + soTienHoan;
              chunkUsersToUpdate.set(order.username, userData);

              chunkHistoriesToInsert.push({
                username: order.username,
                madon: order.Madon,
                hanhdong: "Hoàn tiền",
                link: order.link,
                tienhientai: user.balance,
                tongtien: soTienHoan,
                tienconlai: user.balance + userData.balanceChange,
                mota: `Hệ thống hoàn cho bạn ${Number(Math.floor(soTienHoan)).toLocaleString('en-US')}đ tương đương với số lượng ${chuachay} cho uid ${order.link} và ${phihoan} phí dịch vụ`,
                createdAt: new Date()
              });

              updateData.iscancel = false;
            } else {
              updateData.iscancel = true;
            }

            queueTelegramNotification(teleConfig, order, soTienHoan, chuachay, isApproved, phihoan);
          }

          if (hasOrderChanged(updateData, order)) {
            chunkOrdersToUpdate.push({ filter: { _id: order._id }, update: updateData });
          }

          processedOrdersCount++;
        }

        // ===== LƯU DB NGAY SAU KHI XỬ LÝ XONG CHUNK =====
        const chunkBulkPromises = [];

        // Bulk update Orders cho chunk
        if (chunkOrdersToUpdate.length > 0) {
          const bulkOps = chunkOrdersToUpdate.map(({ filter, update }) => ({
            updateOne: { filter, update: { $set: update } }
          }));
          chunkBulkPromises.push(Order.bulkWrite(bulkOps, { ordered: false }));
        }

        // Bulk upsert Refunds cho chunk
        if (chunkRefundsToInsert.length > 0) {
          chunkBulkPromises.push(Refund.bulkWrite(chunkRefundsToInsert, { ordered: false }));
        }

        // Bulk insert Histories cho chunk
        if (chunkHistoriesToInsert.length > 0) {
          chunkBulkPromises.push(HistoryUser.insertMany(chunkHistoriesToInsert, { ordered: false }));
        }

        // Bulk update Users cho chunk
        const chunkUserBulkOps = [];
        for (const [username, userData] of chunkUsersToUpdate.entries()) {
          if (userData.balanceChange > 0) {
            chunkUserBulkOps.push({
              updateOne: {
                filter: { username },
                update: { $inc: { balance: userData.balanceChange } }
              }
            });

            // Cập nhật global usersToUpdate để tracking đúng
            const globalUserData = usersToUpdate.get(username) || { balance: userData.balance, balanceChange: 0 };
            globalUserData.balanceChange = (globalUserData.balanceChange || 0) + userData.balanceChange;
            usersToUpdate.set(username, globalUserData);
          }
        }
        if (chunkUserBulkOps.length > 0) {
          chunkBulkPromises.push(User.bulkWrite(chunkUserBulkOps, { ordered: false }));
        }

        // Execute all bulk operations cho chunk này
        if (chunkBulkPromises.length > 0) {
          await Promise.all(chunkBulkPromises);
          console.log(`💾 [${groupKey}] Đã lưu ${chunkOrdersToUpdate.length} orders, ${chunkRefundsToInsert.length} refunds, ${chunkHistoriesToInsert.length} histories, ${chunkUserBulkOps.length} users`);
        }

        didWork = true;
      }
      // nếu vòng này không làm gì nhưng vẫn còn chunk chờ cooldown -> sleep ngắn rồi lặp lại
      const hasPending = Object.values(domainStates).some(s => s.chunks.length > 0);
      if (!hasPending) break;
      if (!didWork) {
        await new Promise(r => setTimeout(r, 1000));
      }
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
