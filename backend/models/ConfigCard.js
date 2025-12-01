const mongoose = require("mongoose");

const configCardSchema = new mongoose.Schema({
  API_URLCARD: { type: String, }, // URL API nạp thẻ
  PARTNER_ID: { type: String, }, // ID đối tác
  PARTNER_KEY: { type: String, }, // Khóa đối tác
  RATE : { type: Number, default: 5 }, // Tỷ lệ chiết khấu
  domain: { type: String, default: null },

}, { timestamps: true }); // Tự động thêm createdAt và updatedAt

module.exports = mongoose.model("ConfigCard", configCardSchema);