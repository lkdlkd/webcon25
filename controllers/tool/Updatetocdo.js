const cron = require('node-cron');
const Service = require('../../models/server');

const cronExpression = '*/30 * * * * *'; // Chạy mỗi 30 giây
const webcon = process.env.webcon;
if (!webcon) {
  // Cronjob: cập nhật tốc độ dự kiến cho tất cả dịch vụ mỗi 10 phút
  cron.schedule('*/30 * * * *', async () => {
    console.log('Cronjob: Bắt đầu cập nhật tốc độ dự kiến cho tất cả dịch vụ...');
    const results = await Service.updateAllTocDoDuKien();
    console.log('Kết quả cập nhật tốc độ:', results);
  });

  // Nếu muốn chạy ngay khi khởi động file
  (async () => {
    const results = await Service.updateAllTocDoDuKien();
    console.log('Kết quả cập nhật tốc độ (lần đầu):', results);
  })();

}
