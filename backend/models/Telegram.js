const mongoose = require('mongoose');

const telegramSchema = new mongoose.Schema({
  botToken: { type: String, default: "" },
  chatId: { type: String, default: "" }, // chat ID đơn hàng chính
  chatidnaptien: { type: String, default: "" }, // chat ID nạp tiền
  chatidthaydoigoi: { type: String, default: "" }, // chat ID thay đổi gói
  chatidsdnguon: { type: String, default: "" }, // chat ID số dư ngưồn
  chatiddontay: { type: String, default: "" }, // chat ID đơn tay
  bot_notify: { type: String, default: "" }, // bot người dùng
}, { timestamps: true });

module.exports = mongoose.model('Telegram', telegramSchema);