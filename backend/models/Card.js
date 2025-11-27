const mongoose = require("mongoose");

const cardSchema = new mongoose.Schema({
  telco: { type: String, required: true },   // Loại thẻ (VIETTEL, ZING, ...)
  value: { type: Number, required: true },   // Mệnh giá
  fees: { type: Number, required: true },    // Phí chiết khấu (%)
  penalty: { type: Number, required: true }, // Phí phạt (%)
  domain: { type: String, default: null },

}, { timestamps: true });

module.exports = mongoose.model("Card", cardSchema);