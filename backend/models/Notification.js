const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  color: { type: String, default: "#000000" }, // Màu mặc định là đen
  created_at: { type: Date, default: Date.now },
  domain: { type: String, default: null },

});

module.exports = mongoose.model("Notification", NotificationSchema);
