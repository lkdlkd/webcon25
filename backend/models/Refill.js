const mongoose = require('mongoose');

const RefillSchema = new mongoose.Schema({
    username: { type: String, required: true }, // Tên người dùng
    mabaohanh: { type: String }, // Mã bảo hành
    madon: { type: String }, // Mã đơn
    link: { type: String }, // Object_id liên kết Order
    server: { type: String }, // Server
    soluongmua: { type: Number }, // Số lượng mua
    goc: { type: Number }, // Gốc
    thoigianmua: { type: Date }, // Thời gian mua
    trangthai: { type: String , default: 'pending' }, // Trạng thái
}, { timestamps: true });

module.exports = mongoose.model('Refill', RefillSchema);
