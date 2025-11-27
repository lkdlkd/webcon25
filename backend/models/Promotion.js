const mongoose = require('mongoose');

const PromotionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    minAmount: { type: Number, default: 0 }, // Số tiền tối thiểu để áp dụng khuyến mãi
    percentBonus: { type: Number, required: true },
    description: { type: String, default: null },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    repeatMonthly: { type: Boolean, default: false }, // Có lặp lại hàng tháng hay không
    domain: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Promotion', PromotionSchema);