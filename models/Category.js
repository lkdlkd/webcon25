const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  platforms_id: { type: mongoose.Schema.Types.ObjectId, ref: "Platform", required: true }, // Tham chiếu đến Platform
  name: { type: String, required: true }, // Tên danh mục
  path: { type: String, required: true }, // Đường dẫn
  notes: { type: String, default: null }, // Ghi chú
  modal_show: { type: String, default: null }, // Hiển thị modal
  status: { type: Boolean, default: true }, // Trạng thái (1: hoạt động, 0: không hoạt động)
  created_at: { type: Date, default: Date.now }, // Ngày tạo
  updated_at: { type: Date, default: Date.now }, // Ngày cập nhật
  domain: { type: String, default: null },
  thutu: { type: Number, default: 4 }, // Thứ tự hiển thị
});

module.exports = mongoose.model("Category", categorySchema);