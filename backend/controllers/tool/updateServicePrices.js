const cron = require('node-cron');
const axios = require('axios');
const Service = require('../../models/server');
const SmmSv = require('../../models/SmmSv');
const Telegram = require('../../models/Telegram');
const Platform = require('../../models/platform');
const configweb = require('../../models/Configweb');

// Biến chống chồng lệnh
let isUpdating = false;
let updateStartTime = null;

// Helper: Tính giá mới theo tỷ lệ riêng cho từng cấp bậc
function calculateNewPrices(apiRate, priceUpdateMember, priceUpdateVip, priceUpdateDistributor) {
  const member = Math.round(apiRate * (1 + Number(priceUpdateMember) / 100) * 10000) / 10000;
  const vip = Math.round(apiRate * (1 + Number(priceUpdateVip) / 100) * 10000) / 10000;
  const distributor = Math.round(apiRate * (1 + Number(priceUpdateDistributor) / 100) * 10000) / 10000;

  return { member, vip, distributor };
}

// Helper: Gửi thông báo Telegram
async function sendPriceUpdateNotification(serviceItem, oldRate, newPrices, previousOriginal, apiRate, sourceName, direction) {
  const teleConfig = await Telegram.findOne();
  if (!teleConfig?.botToken || !teleConfig?.chatidthaydoigoi) return;

  const createdAtVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const telegramMessage =
    `📌 *Cập nhật giá ${direction}!*\n` +
    `🔹 *Mã gói:* ${serviceItem.Magoi}\n` +
    `👤 *Dịch vụ:* ${serviceItem.name}\n` +
    `🔹 *Giá cũ (Member):* ${oldRate}\n` +
    `🔹 *Giá Thành Viên:* ${newPrices.member}\n` +
    `🔹 *Giá Đại Lý:* ${newPrices.vip}\n` +
    `🔹 *Giá Nhà Phân Phối:* ${newPrices.distributor}\n` +
    `🔹 *Giá cũ API:* ${Math.round(previousOriginal * 10000) / 10000}\n` +
    `🔹 *Giá mới API:* ${Math.round(apiRate * 10000) / 10000}\n` +
    `🔹 *Nguồn:* ${sourceName}\n` +
    `🔹 *Thời gian:* ${createdAtVN.toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}\n`;

  try {
    await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
      chat_id: teleConfig.chatidthaydoigoi,
      text: telegramMessage,
      parse_mode: 'Markdown'
    });
    console.log('Thông báo Telegram đã được gửi.');
  } catch (error) {
    console.error('Lỗi gửi thông báo Telegram:', error.message);
  }
}

// Helper: Cập nhật giá dịch vụ
async function updateServicePrice(serviceItem, apiService, apiRate, smmSvConfig) {
  const previousOriginal = typeof serviceItem.originalRate === 'number' ? serviceItem.originalRate : apiRate;

  // Xác định hướng thay đổi giá
  let direction = '!';
  if (apiRate > previousOriginal) direction = 'TĂNG';
  else if (apiRate < previousOriginal) direction = 'GIẢM';

  // Nếu ischeck = true, chỉ cập nhật originalRate và serviceName
  if (serviceItem.ischeck === true) {
    let needUpdate = false;
    if (typeof serviceItem.originalRate !== 'number' || serviceItem.originalRate !== apiRate) {
      serviceItem.originalRate = apiRate;
      needUpdate = true;
    }
    if (serviceItem.serviceName !== apiService.name) {
      serviceItem.serviceName = apiService.name;
      needUpdate = true;
    }
    if (needUpdate) {
      await serviceItem.save();
      console.log(`Service ${serviceItem.name} có ischeck=true, chỉ cập nhật originalRate.`);
    }
    return;
  }

  const dbRate = serviceItem.rate;
  const dbRateVip = serviceItem.ratevip;
  const dbRateDistributor = serviceItem.rateDistributor;

  // Kiểm tra điều kiện cập nhật giá
  const shouldUpdatePrice =
    typeof serviceItem.originalRate === 'number' &&
    smmSvConfig.update_price === "on" &&
    (
      apiRate !== previousOriginal ||
      dbRate < apiRate ||
      dbRateVip < apiRate ||
      dbRateDistributor < apiRate ||
      apiRate < previousOriginal
    );

  if (shouldUpdatePrice) {
    const oldRate = serviceItem.rate;

    // Tính giá mới theo % riêng cho từng cấp bậc
    const newPrices = calculateNewPrices(
      apiRate,
      smmSvConfig.price_update || 15,           // Member: mặc định 15%
      smmSvConfig.price_updateVip || 10,        // VIP: mặc định 10%
      smmSvConfig.price_updateDistributor || 5 // Distributor: mặc định 5%
    );

    serviceItem.rate = newPrices.member;
    serviceItem.ratevip = newPrices.vip;
    serviceItem.rateDistributor = newPrices.distributor;
    serviceItem.originalRate = apiRate;

    await serviceItem.save();

    // Gửi thông báo Telegram
    await sendPriceUpdateNotification(
      serviceItem,
      oldRate,
      newPrices,
      previousOriginal,
      apiRate,
      smmSvConfig.name,
      direction
    );
  } else {
    // Cập nhật originalRate và serviceName nếu cần
    let needUpdate = false;
    if (typeof serviceItem.originalRate !== 'number' || serviceItem.originalRate !== apiRate) {
      serviceItem.originalRate = apiRate;
      needUpdate = true;
    }
    if (serviceItem.serviceName !== apiService.name) {
      serviceItem.serviceName = apiService.name;
      needUpdate = true;
    }
    if (needUpdate) {
      await serviceItem.save();
    }
  }
}

// Hàm kiểm tra và cập nhật giá dịch vụ
async function updateServicePrices() {
  // Kiểm tra chống chồng lệnh
  if (isUpdating) {
    const elapsedTime = Date.now() - updateStartTime;
    console.warn(`⚠️ Bỏ qua: Tiến trình cập nhật giá đang chạy (${Math.round(elapsedTime / 1000)}s)`);
    return;
  }

  isUpdating = true;
  updateStartTime = Date.now();

  try {
    // Không lấy các dịch vụ có ordertay = true
    const services = await Service.find({ ordertay: { $ne: true } });
    console.log(`🔄 Bắt đầu kiểm tra ${services.length} dịch vụ...`);

    const config = await configweb.findOne({});

    // Gom nhóm các service theo DomainSmm
    const smmGroups = {};
    for (const service of services) {
      const domainId = String(service.DomainSmm);
      if (!smmGroups[domainId]) smmGroups[domainId] = [];
      smmGroups[domainId].push(service);
    }

    // Duyệt qua từng nhóm DomainSmm
    for (const domainId in smmGroups) {
      const smmSvConfig = await SmmSv.findById(domainId);
      // Bỏ qua nếu không có config hoặc status = 'off'
      if (!smmSvConfig?.url_api || !smmSvConfig?.api_token || smmSvConfig.ordertay === true) {
        console.warn(`Bỏ qua domainId ${domainId}: Cấu hình không đầy đủ hoặc đã tắt`);
        continue;
      }

      let apiResponse;
      try {
        apiResponse = await axios.post(smmSvConfig.url_api, {
          key: smmSvConfig.api_token,
          action: 'services',
        });
      } catch (err) {
        console.warn(`Lỗi gọi API cho domainId ${domainId}:`, err.message);
        continue;
      }

      if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
        console.warn(`Dữ liệu API không hợp lệ cho domainId ${domainId}`);
        continue;
      }

      // Xử lý từng service thuộc domain này
      await Promise.all(
        smmGroups[domainId].map(async (serviceItem) => {
          try {
            const apiService = apiResponse.data.find(
              (s) => Number(s.service) === Number(serviceItem.serviceId)
            );

            let needSave = false;

            if (!apiService) {
              console.warn(`Không tìm thấy dịch vụ ${serviceItem.serviceId} trong API cho ${serviceItem.name}`);
              serviceItem.isActive = false;
              await serviceItem.save();
              return;
            }

            // Tự động cập nhật trạng thái isActive nếu config.autoactive = true
            if (config && config.autoactive === true && serviceItem.isActive !== true) {
              serviceItem.isActive = true;
              needSave = true;
              console.log(`✅ Đã tự động kích hoạt dịch vụ: ${serviceItem.name}`);
            }

            // Cập nhật min và max nếu có trong API
            if (apiService.min && apiService.max) {
              if (serviceItem.min !== apiService.min || serviceItem.max !== apiService.max) {
                serviceItem.min = apiService.min;
                serviceItem.max = apiService.max;
                needSave = true;
              }
            }

            // Lưu các thay đổi trước khi gọi updateServicePrice
            if (needSave) {
              await serviceItem.save();
            }

            const apiRate = apiService.rate * smmSvConfig.tigia;
            await updateServicePrice(serviceItem, apiService, apiRate, smmSvConfig);

          } catch (innerError) {
            console.error(`Lỗi khi xử lý dịch vụ ${serviceItem.name}:`, innerError.message);
          }
        })
      );

      console.log(`✅ Đã xử lý xong dịch vụ từ nguồn ${smmSvConfig.name} (${smmGroups[domainId].length} dịch vụ).`);
    }

    const totalTime = Date.now() - updateStartTime;
    console.log(`✅ Hoàn thành cập nhật giá trong ${Math.round(totalTime / 1000)}s`);
  } catch (error) {
    console.error('❌ Lỗi khi lấy danh sách dịch vụ:', error.message);
  } finally {
    // Luôn luôn reset trạng thái để cho phép lần chạy tiếp theo
    isUpdating = false;
    updateStartTime = null;
  }
}

// Hàm cập nhật type từ string sang ObjectId (chạy 1 lần để migration)
async function updateTypeToPlatformId() {
  const services = await Service.find({});
  console.log(`Đang cập nhật type cho ${services.length} dịch vụ...`);

  for (const service of services) {
    if (typeof service.type === 'string') {
      const platform = await Platform.findOne({ name: service.type });
      if (platform) {
        service.type = platform._id;
        console.log(`Cập nhật type cho dịch vụ ${service.name} thành ${platform._id}`);
        await service.save();
      }
    }
  }
  console.log('Cập nhật hoàn tất!');
}

const cronExpression = '*/30 * * * * *'; // Chạy mỗi 30 giây
const webcon = process.env.webcon;
if (!webcon) {
  cron.schedule(cronExpression, () => {
    console.log('⏰ Cron job: Bắt đầu kiểm tra giá dịch vụ...');
    updateServicePrices();
  });
}