const Service = require('../../models/server');

// Migration: Set status = true cho các service chưa có field status
async function migrateServiceStatus() {
  try {
    console.log('🔄 Đang kiểm tra migration cho Service.status...');
    
    const result = await Service.updateMany(
      { status: { $exists: false } },
      { $set: { status: true } }
    );

    if (result.modifiedCount > 0) {
      console.log(`✅ Migration hoàn tất: Đã cập nhật ${result.modifiedCount} services với status = true`);
    } else {
      console.log('✅ Migration đã chạy trước đó, không có service nào cần cập nhật');
    }
  } catch (error) {
    console.error('❌ Lỗi khi chạy migration Service.status:', error.message);
  }
}

// Export để gọi từ app.js
module.exports = { migrateServiceStatus };
