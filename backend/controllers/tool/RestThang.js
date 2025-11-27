const cron = require("node-cron");
const User = require("../../models/User");
const { updateMonthlyPromotions } = require("../Khuyenmai/KhuyenmaiController");
// Hàm reset tongnapthang về 0
const resetTongNapThang = async () => {
    try {
        console.log("🔄 Đang reset tongnapthang cho tất cả user...");
        await User.updateMany({}, { $set: { tongnapthang: 0 } });
        console.log("✅ Đã reset tongnapthang về 0 thành công!");
    } catch (error) {
        console.error("❌ Lỗi khi reset tongnapthang:", error);
    }
};

// 🌟 Reset ngay bây giờ khi server khởi động
// resetTongNapThang();

// ⏳ Reset tự động vào ngày 1 hàng tháng lúc 00:00
cron.schedule("0 0 1 * *", resetTongNapThang);
// */30 * * * * *
// cron.schedule('*/30 * * * * *', async () => {
//     console.log('⏳ Đang kiểm tra và cập nhật các chương trình khuyến mãi hàng tháng...');
//     await updateMonthlyPromotions();
// });

cron.schedule('0 0 * * *', async () => {
    console.log('⏳ Đang kiểm tra và cập nhật các chương trình khuyến mãi hàng tháng...');
    await updateMonthlyPromotions();
});
