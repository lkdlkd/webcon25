const mongoose = require("mongoose");

const refreshTokenSchema = new mongoose.Schema({
  token: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true 
  },
  expiresAt: { 
    type: Date, 
    required: true,
    index: { expires: 0 } // TTL index - tự động xóa khi hết hạn
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  userAgent: { type: String },
  ip: { type: String }
});

// Index để tìm kiếm nhanh theo userId
refreshTokenSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("RefreshToken", refreshTokenSchema);
