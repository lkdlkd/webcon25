const cron = require('node-cron');
const Configweb = require('../../models/Configweb');
const Order = require('../../models/Order');
const User = require('../../models/User');
const History = require('../../models/History');

// Biến chống chồng lệnh
let isDeleting = false;
let deleteStartTime = null;

/**
 * Hàm xóa dữ liệu cũ tự động
 */
async function autoDeleteOldData() {
    // Kiểm tra chống chồng lệnh
    if (isDeleting) {
        const elapsedTime = Date.now() - deleteStartTime;
        console.warn(`⚠️ Bỏ qua: Tiến trình xóa dữ liệu đang chạy (${Math.round(elapsedTime / 1000)}s)`);
        return;
    }

    isDeleting = true;
    deleteStartTime = Date.now();

    try {
        // Lấy cấu hình
        const config = await Configweb.findOne();

        if (!config || !config.autoremove) {
            console.log('ℹ️ Auto delete đã tắt hoặc chưa cấu hình');
            return;
        }

        const monthsToDelete = config.autoDeleteMonths || 3;
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - monthsToDelete);

        console.log(`🗑️ Bắt đầu xóa dữ liệu cũ hơn ${monthsToDelete} tháng (trước ${cutoffDate.toLocaleDateString('vi-VN')})...`);

        let totalDeleted = 0;

        // 1. Xóa đơn hàng cũ
        if (config.deleteOrders) {
            try {
                const orderResult = await Order.deleteMany({
                    createdAt: { $lt: cutoffDate }
                });

                console.log(`✅ Đã xóa ${orderResult.deletedCount} đơn hàng cũ`);
                totalDeleted += orderResult.deletedCount;
            } catch (error) {
                console.error('❌ Lỗi khi xóa đơn hàng:', error.message);
            }
        }

        // 2. Xóa user không hoạt động
        if (config.deleteUsers) {
            try {
                // Chỉ xóa user thường, không xóa admin
                // Điều kiện: không phải admin, không hoạt động lâu, balance = 0
                const userResult = await User.deleteMany({
                    role: { $ne: 'admin' },
                    updatedAt: { $lt: cutoffDate },
                    balance: { $lte: 0 }, // Số dư hiện tại = 0
                });

                console.log(`✅ Đã xóa ${userResult.deletedCount} user không hoạt động (chưa từng nạp tiền)`);
                totalDeleted += userResult.deletedCount;
            } catch (error) {
                console.error('❌ Lỗi khi xóa user:', error.message);
            }
        }

        // 3. Xóa lịch sử cũ
        if (config.deleteHistory) {
            try {
                const historyResult = await History.deleteMany({
                    createdAt: { $lt: cutoffDate }
                });

                console.log(`✅ Đã xóa ${historyResult.deletedCount} lịch sử cũ`);
                totalDeleted += historyResult.deletedCount;
            } catch (error) {
                console.error('❌ Lỗi khi xóa lịch sử:', error.message);
            }
        }

        const totalTime = Date.now() - deleteStartTime;
        console.log(`✅ Hoàn thành xóa dữ liệu cũ: Tổng ${totalDeleted} bản ghi trong ${Math.round(totalTime / 1000)}s`);

    } catch (error) {
        console.error('❌ Lỗi khi xóa dữ liệu cũ:', error.message);
    } finally {
        // Luôn luôn reset trạng thái
        isDeleting = false;
        deleteStartTime = null;
    }
}

// Cronjob: Chạy mỗi ngày lúc 2h sáng (ít traffic)
cron.schedule('0 2 * * *', () => {
  console.log('⏰ Cron job: Bắt đầu xóa dữ liệu cũ tự động...');
  autoDeleteOldData();
}, {
  timezone: "Asia/Ho_Chi_Minh"
});
// cron.schedule('*/30 * * * * *', async () => {
//     console.log('⏰ Cron job: Bắt đầu xóa dữ liệu cũ tự động...');
//     autoDeleteOldData();
// }, {
//     timezone: "Asia/Ho_Chi_Minh"
// });
console.log('✅ Auto delete cronjob đã được khởi động (chạy lúc 2h sáng mỗi ngày)');

// Export để có thể gọi thủ công nếu cần
module.exports = { autoDeleteOldData };
