const mongoose = require("mongoose");

const ScheduledSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true }, // Người dùng đặt đơn
  link: { type: String, required: true }, // Link dịch vụ
  quantity: { type: Number, required: true }, // Số lượng đặt
  magoi: { type: String, required: true }, // Mã gói dịch vụ
  category: String, // Loại dịch vụ
  note: String, // Ghi chú đơn hàng
  comments: String, // Bình luận nếu có
  ObjectLink: String, // Link object nếu có
  scheduleTime: { type: Date, required: true, index: true }, // Thời gian chạy
  estimatedCost: { type: Number, required: true }, // Chi phí dự kiến
  serviceRate: Number, // Giá dịch vụ tại thời điểm đặt
  serviceName: String, // Tên dịch vụ
  status: {
    type: String,
    default: "Pending",
    enum: ["Pending", "Running", "Success", "Failed", "Cancelled"],
    index: true
  }, // Trạng thái đơn hẹn giờ
  madon: String, // Mã đơn khi đã được tạo
  errorMessage: String, // Lỗi nếu có
  executedAt: Date, // Thời gian thực thi thực tế
}, { timestamps: true });

// Index compound để query hiệu quả
ScheduledSchema.index({ status: 1, scheduleTime: 1 });
ScheduledSchema.index({ username: 1, status: 1 });

module.exports = mongoose.model("Scheduled", ScheduledSchema);
