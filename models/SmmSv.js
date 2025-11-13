const mongoose = require("mongoose");

const smmPanelPartnerSchema = new mongoose.Schema({
    name: { type: String, default: null },
    url_api: { type: String, required: true },
    api_token: { type: String, required: true },
    price_update: { type: Number, default: 15 },
    price_updateVip: { type: Number, default: 10 },
    price_updateDistributor: { type: Number, default: 5 },
    minbalance : { type: Number, default: 100000 },
    // balance: { type: Number, default: 0 },
    tigia: { type: Number, default: 0 }, // Tỷ giá quy đổi
    status: { type: String, enum: ["on", "off"], default: "on" },
    update_price: { type: String, enum: ["on", "off"], default: "on" },
    autohoan: { type: String, enum: ["on", "off"], default: "on" },
    phihoan: { type: Number, default: 1000 }, // Phí hoàn tiền
    ordertay : { type: Boolean, default: false }, // Cho phép đơn tay
    domain: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('SmmSv', smmPanelPartnerSchema);
