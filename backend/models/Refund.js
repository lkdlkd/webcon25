const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema({
	username: { type: String, required: true }, // Tên người dùng
	madon: { type: String, required: true ,unique: true }, // Mã đơn
	link : { type: String, required: true }, // Link hoàn tiền
	server: { type: String, required: true }, // Server
	soluongmua: { type: Number, required: true }, // Số lượng mua
	giatien: { type: Number, required: true }, // Giá tiền
	chuachay: { type: Number, required: true }, // Số lượng chưa chạy
	tonghoan: { type: Number, required: true }, // Tổng tiền hoàn
	noidung: { type: String, required: false }, // Nội dung
    status : { type: Boolean, default: true } // Trạng thái
}, { timestamps: true }); // Thêm createdAt và updatedAt tự động

module.exports = mongoose.model('Refund', refundSchema);
