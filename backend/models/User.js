const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true }, // Không cần required, vì chúng ta sẽ tự gán nếu chưa có
  username: { type: String, required: true, unique: true },
  name: { type: String },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  balance: { type: Number, default: 0 },
  tongnap: { type: Number, default: 0 },
  tongnapthang: { type: Number, default: 0 },
  apiKey: { type: String }, // Không cần required, sẽ cập nhật sau khi tạo token
  capbac: { type: String, enum: ['member', 'vip', 'distributor'], default: 'member' },
  status: { type: String, enum: ['active', 'banned'], default: 'active' },
  loginHistory: [
    {
      ip: { type: String },
      agent: { type: String },
      time: { type: Date, default: Date.now }
    }
  ], // Lưu lịch sử đăng nhập
  domain: { type: String, default: null },
  // 2FA fields
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String, select: false }, // Secret chính đã xác thực
  twoFactorTempSecret: { type: String, select: false }, // Secret tạm trong bước setup

  // Telegram linking fields
  telegramChatId: { type: String, index: true },
  telegramLinkedAt: { type: Date },
  telegramBalanceSent: { type: Boolean, default: false },

  // Unique deposit code for bank transfer identification
  depositCode: { type: String, unique: true, sparse: true, index: true },

  // Affiliate fields
  referralCode: { type: String, unique: true, sparse: true, index: true }, // Mã giới thiệu của user này
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // User đã giới thiệu user này
  referredByCode: { type: String, default: null }, // Mã giới thiệu khi đăng ký (lưu để tra cứu)
  commissionBalance: { type: Number, default: 0 }, // Số dư hoa hồng có thể rút (riêng biệt với balance)
  affiliateStats: {
    totalEarnings: { type: Number, default: 0 }, // Tổng hoa hồng đã nhận
    totalReferrals: { type: Number, default: 0 }, // Tổng số người đã giới thiệu (cấp 1)
    monthlyEarnings: { type: Number, default: 0 }, // Hoa hồng tháng này
    lastEarningMonth: { type: Number, default: 0 }, // Tháng nhận hoa hồng gần nhất
    lastEarningYear: { type: Number, default: 0 } // Năm nhận hoa hồng gần nhất
  },

}, { timestamps: true }); // Tự động tạo createdAt và updatedAt

// Pre-save hook: mã hóa mật khẩu và cập nhật userId nếu chưa có
userSchema.pre("save", async function (next) {
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  // Nếu chưa có userId, gán giá trị _id của document
  if (!this.userId) {
    this.userId = this._id.toString();
  }
  next();
});

// Phương thức kiểm tra mật khẩu
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model("User", userSchema);
