const cron = require('node-cron');
const axios = require('axios');
const Service = require('../../models/server');
const SmmSv = require('../../models/SmmSv');
const Telegram = require('../../models/Telegram');

// Hàm kiểm tra và cập nhật giá dịch vụ
async function updateServicePrices() {
  try {
    // Lấy toàn bộ dịch vụ trong CSDL
    const services = await Service.find({});
    console.log(`Đang kiểm tra ${services.length} dịch vụ...`);

    // Gom nhóm các service theo DomainSmm (ObjectId)
    const smmGroups = {};
    for (const service of services) {
      const domainId = String(service.DomainSmm);
      if (!smmGroups[domainId]) smmGroups[domainId] = [];
      smmGroups[domainId].push(service);
    }

    // Duyệt qua từng nhóm DomainSmm, chỉ gọi API 1 lần cho mỗi nhóm
    for (const domainId in smmGroups) {
      const smmSvConfig = await SmmSv.findById(domainId);
      if (!smmSvConfig || !smmSvConfig.url_api || !smmSvConfig.api_token) {
        console.warn(`Cấu hình API chưa được thiết lập cho domainId ${domainId}`);
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
      // Duyệt qua từng service thuộc domain này
      await Promise.all(
        smmGroups[domainId].map(async (serviceItem) => {
          try {
            const apiService = apiResponse.data.find(
              (s) => Number(s.service) === Number(serviceItem.serviceId)
            );
            if (!apiService) {
              console.warn(`Không tìm thấy dịch vụ ${serviceItem.serviceId} trong API cho ${serviceItem.name}`);
              serviceItem.isActive = false;
              await serviceItem.save();
              return;
            }
            // ✅ Cập nhật min và max nếu có trong 
            if (apiService.min && apiService.max) {
              if (serviceItem.min !== apiService.min || serviceItem.max !== apiService.max) {
                serviceItem.min = apiService.min;
                serviceItem.max = apiService.max;
                await serviceItem.save();
              }
            }
            const apiRate = apiService.rate * smmSvConfig.tigia;
            const dbRate = serviceItem.rate;
            const dbRateVip = serviceItem.ratevip;
            const dbRateDistributor = serviceItem.rateDistributor;
            const previousOriginal = typeof serviceItem.originalRate === 'number' ? serviceItem.originalRate : apiRate;
            // const direction = apiRate > previousOriginal ? 'GIẢM' : 'TĂNG';
            let direction;
            if (apiRate > previousOriginal) {
              direction = 'TĂNG';
            } else if (apiRate < previousOriginal) {
              direction = 'GIẢM';
            } else {
              direction = '!';
            }
            // console.log(`Kiểm tra dịch vụ: ${serviceItem.name} - Giá API: ${apiRate}, Giá CSDL: ${dbRate}`);

            // Nếu service có ischeck = true, chỉ cập nhật originalRate mà không cập nhật giá
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
              }
              console.log(`Service ${serviceItem.name} có ischeck=true, chỉ cập nhật originalRate mà không cập nhật giá.`);
            }
            // So sánh và cập nhật giá (chỉ khi ischeck != true)
            else if (
              typeof serviceItem.originalRate === 'number' &&
              (dbRate < apiRate || dbRateVip < apiRate || dbRateDistributor < apiRate) &&
              smmSvConfig.update_price === "on"
            ) {
              let newRate = apiRate * (1 + Number(smmSvConfig.price_update) / 100); // cập nhật với tỷ lệ tăng đã cấu hình
              newRate = Math.round(newRate * 10000) / 10000; // Làm tròn 4 chữ số thập phân
              let newDistributor = newRate; // Giá Distributor cao hơn giá thường 10%
              let newVip = newDistributor * 1.1; // Giá VIP cao hơn giá thường 20%
              newVip = Math.round(newVip * 10000) / 10000; // Làm tròn 4 chữ số thập phân
              let newmember = newVip * 1.15; // Giá Member cao hơn giá thường 15%
              newmember = Math.round(newmember * 10000) / 10000; // Làm tròn 4 chữ số thập phân              
              const oldRate = serviceItem.rate;
              serviceItem.rate = newmember;
              serviceItem.ratevip = newVip;
              serviceItem.rateDistributor = newDistributor;
              await serviceItem.save();
              // console.log(`Đã cập nhật giá của ${serviceItem.name} thành ${newRate}`);

              // Gửi thông báo Telegram nếu có cấu hình (TĂNG GIÁ)
              const teleConfig = await Telegram.findOne();
              const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
              if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
                const telegramMessage = `📌 *Cập nhật giá ${direction}!*\n` +
                  `🔹 *Mã gói:* ${serviceItem.Magoi}\n` +
                  `👤 *Dịch vụ:* ${serviceItem.name}\n` +
                  `🔹 *Giá cũ:* ${oldRate}\n` +
                  `🔹 *Giá Thành Viên:* ${newmember}\n` +
                  `🔹 *Giá Đại Lý:* ${newVip}\n` +
                  `🔹 *Giá Nhà Phân Phối:* ${newDistributor}\n` +
                  `🔹 *Giá cũ API :* ${Math.round(previousOriginal * 10000) / 10000}\n` +
                  `🔹 *Giá mới API :* ${Math.round(apiRate * 10000) / 10000}\n` +
                  `🔹 *Nguồn:* ${smmSvConfig.name}\n` +
                  `🔹 *Thời gian:* ${taoluc.toLocaleString("vi-VN", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}\n`;
                try {
                  await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
                    chat_id: teleConfig.chatId,
                    text: telegramMessage,
                  });
                  console.log('Thông báo Telegram đã được gửi.');
                } catch (telegramError) {
                  console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                }
              }
              // Sau khi tăng giá, cập nhật lại originalRate
              serviceItem.originalRate = apiRate;
              await serviceItem.save();
            } else if (
              typeof serviceItem.originalRate === 'number' &&
              apiRate < serviceItem.originalRate &&
              smmSvConfig.update_price === "on"
            ) {
              let newRate = apiRate * (1 + Number(smmSvConfig.price_update) / 100); // cập nhật với tỷ lệ tăng đã cấu hình
              newRate = Math.round(newRate * 10000) / 10000; // Làm tròn 4 chữ số thập phân
              let newDistributor = newRate; // Giá Distributor cao hơn giá thường 10%
              let newVip = newDistributor * 1.1; // Giá VIP cao hơn giá thường 20%
              newVip = Math.round(newVip * 10000) / 10000; // Làm tròn 4 chữ số thập phân
              let newmember = newVip * 1.15; // Giá Member cao hơn giá thường 15%
              newmember = Math.round(newmember * 10000) / 10000; // Làm tròn 4 chữ số thập phân              
              const oldRate = serviceItem.rate;
              serviceItem.rate = newmember;
              serviceItem.ratevip = newVip;
              serviceItem.rateDistributor = newDistributor;
              await serviceItem.save();
              // console.log(`Đã giảm giá của ${serviceItem.name} thành ${newRate}`);

              // Gửi thông báo Telegram nếu có cấu hình (GIẢM GIÁ)
              const teleConfig = await Telegram.findOne();
              const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
              if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
                const telegramMessage = `📌 *Cập nhật giá ${direction}!*\n` +
                  `🔹 *Mã gói:* ${serviceItem.Magoi}\n` +
                  `👤 *Dịch vụ:* ${serviceItem.name}\n` +
                  `🔹 *Giá cũ:* ${oldRate}\n` +
                  `🔹 *Giá Thành Viên:* ${newmember}\n` +
                  `🔹 *Giá Đại Lý:* ${newVip}\n` +
                  `🔹 *Giá Nhà Phân Phối:* ${newDistributor}\n` +
                  `🔹 *Giá cũ API :* ${Math.round(previousOriginal * 10000) / 10000}\n` +
                  `🔹 *Giá mới API :* ${Math.round(apiRate * 10000) / 10000}\n` +
                  `🔹 *Nguồn:* ${smmSvConfig.name}\n` +
                  `🔹 *Thời gian:* ${taoluc.toLocaleString("vi-VN", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}\n`;
                try {
                  await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
                    chat_id: teleConfig.chatId,
                    text: telegramMessage,
                  });
                  console.log('Thông báo Telegram đã được gửi.');
                } catch (telegramError) {
                  console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                }
              }
              // Sau khi giảm giá, cập nhật lại originalRate
              serviceItem.originalRate = apiRate;
              await serviceItem.save();
            } else {
              // Nếu không tăng/giảm giá, vẫn cập nhật originalRate nếu chưa có
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
              //console.log(`Giá của ${serviceItem.name} đã bằng hoặc cao hơn giá API, bỏ qua cập nhật.`);
            }

          } catch (innerError) {
            console.error(`Lỗi khi xử lý dịch vụ ${serviceItem.name}:`, innerError.message);
          }
        })
      );
      console.log(`Đã xử lý xong dịch vụ từ nguồn ${smmSvConfig.name} (${smmGroups[domainId].length} dịch vụ).`);
    }
  } catch (error) {
    console.error('Lỗi khi lấy danh sách dịch vụ:', error.message);
  }
}
const Platform = require('../../models/platform');

async function updateTypeToPlatformId() {
  const services = await Service.find({});
  console.log(`Đang cập nhật type cho ${services} dịch vụ...`);
  for (const service of services) {
    console.log('type string:', service.type);

    if (typeof service.type === 'string') {

      const platform = await Platform.findOne({ name: service.type });
      if (platform) {
        service.type = platform._id;
        console.log(`Cập nhật type cho dịch vụ ${service.name} thành ${platform._id}`);
        console.log(service)
        await service.save();
      }
    }
  }
  console.log('Cập nhật hoàn tất!');
}

// Cronjob: Kiểm tra giá dịch vụ mỗi 30 giây
setInterval(() => {
  console.log('Cron job: Kiểm tra giá dịch vụ mỗi 30 giây');
  updateServicePrices();
  // updateTypeToPlatformId();

}, 30000); // 30,000 milliseconds = 30 seconds
