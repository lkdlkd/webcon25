const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const HistoryUser = require("../../models/History");
const axios = require("axios");
const crypto = require("crypto");
const Telegram = require('../../models/Telegram');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const Order = require('../../models/Order');

// Cấu hình token - access token dài hạn 30 ngày
const ACCESS_TOKEN_EXPIRES = '30d';

// Helper tạo access token
function generateAccessToken(user) {
  return jwt.sign(
    { username: user.username, userId: user._id, role: user.role },
    process.env.secretKey,
    { expiresIn: ACCESS_TOKEN_EXPIRES }
  );
}

// Tạo session key ngẫu nhiên cho HMAC signature
function generateSessionKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Helper gửi tin nhắn Telegram
async function sendTelegramMessage(chatId, text) {
  try {
    const teleConfig = await Telegram.findOne();
    if (!teleConfig || !teleConfig.bot_notify) return false;
    if (global.bot && typeof global.bot.sendMessage === 'function') {
      // Escape characters that can break basic Markdown parsing (focus on underscore which caused 400 errors)
      const safeText = typeof text === 'string' ? text.replace(/_/g, '\\_') : text;
      await global.bot.sendMessage(chatId, safeText, { parse_mode: 'Markdown' });
    } else {
      const safeText = typeof text === 'string' ? text.replace(/_/g, '\\_') : text;
      await axios.post(`https://api.telegram.org/bot${teleConfig.bot_notify}/sendMessage`, {
        chat_id: chatId,
        text: safeText,
        parse_mode: 'Markdown'
      });
    }
    return true;
  } catch (e) {
    console.error('Telegram send error:', e.message);
    return false;
  }
}

exports.login = async (req, res) => {
  try {
    let { username, password, token: otpToken } = req.body;

    username = username.toLowerCase();

    const user = await User.findOne({ username: username });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: "Sai tên người dùng hoặc mật khẩu" });
    }

    // Kiểm tra trạng thái tài khoản
    if (user.status !== "active") {
      return res.status(403).json({ error: "Tài khoản đã bị khóa" });
    }
    if (user.twoFactorEnabled) {
      if (!otpToken) {
        return res.status(200).json({ twoFactorRequired: true, message: 'Yêu cầu mã 2FA' });
      }
      // Cần lấy secret (đã bật) gồm trường twoFactorSecret (ẩn theo select:false)
      const userWithSecret = await User.findById(user._id).select('+twoFactorSecret');
      if (!userWithSecret || !userWithSecret.twoFactorSecret) {
        return res.status(500).json({ error: 'Không tìm thấy secret 2FA' });
      }
      const verified = speakeasy.totp.verify({
        secret: userWithSecret.twoFactorSecret,
        encoding: 'base32',
        token: otpToken,
        window: 1,
      });
      if (!verified) {
        return res.status(401).json({ error: 'Mã 2FA không chính xác' });
      }
    }

    // Lưu lịch sử đăng nhập vào mảng loginHistory
    // Ưu tiên lấy IP từ header X-User-IP (IP thật từ client), sau đó mới dùng x-forwarded-for
    const ip = req.headers['x-user-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.connection.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || '';
    user.loginHistory = user.loginHistory || [];
    user.loginHistory.push({ ip, agent: userAgent, time: new Date() });
    await user.save();

    // Tạo access token (dài hạn 30 ngày)
    const accessToken = generateAccessToken(user);

    // Tạo sessionKey cho HMAC signature (trả về trong body, không dùng cookie)
    const sessionKey = generateSessionKey();

    // Nếu là admin, gửi thông báo Telegram
    if (user.role === 'admin') {
      const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const teleConfig = await Telegram.findOne();
      if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
        const telegramMessage =
          `📌 *Admin đăng nhập!*\n` +
          `👤 *Admin:* ${user.username}\n` +
          `🔹 *IP:* ${ip}\n` +
          `🔹 *User-Agent:* ${userAgent}\n` +
          `🔹 *Thời gian:* ${taoluc.toLocaleString("vi-VN", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}\n`;
        try {
          await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
            chat_id: teleConfig.chatId,
            text: telegramMessage,
            parse_mode: "Markdown",
          });
          console.log("Thông báo Telegram admin đăng nhập đã được gửi.");
        } catch (telegramError) {
          console.error("Lỗi gửi thông báo Telegram:", telegramError.message);
        }
      }
    }
    // ✅ Trả về token và sessionKey trong body (frontend lưu vào localStorage)
    return res.status(200).json({
      token: accessToken,
      sessionKey: sessionKey,
      role: user.role,
      username: user.username,
      twoFactorEnabled: user.twoFactorEnabled,
      expiresIn: 30 * 24 * 60 * 60 // 30 ngày tính bằng giây
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Có lỗi xảy ra khi đăng nhập" });
  }
};


// Bắt đầu thiết lập 2FA: tạo secret tạm & trả về QR code + otpauth URL
exports.setup2FA = async (req, res) => {
  try {
    const currentUser = req.user;
    const user = await User.findById(currentUser.userId || currentUser._id);
    if (!user) return res.status(404).json({ error: 'User không tồn tại' });

    // Nếu đã bật 2FA thì không nên cho setup lại (buộc disable trước)
    if (user.twoFactorEnabled) {
      return res.status(400).json({ status: false, message: 'Bạn đã bật 2FA. Hãy tắt trước nếu muốn tạo lại.' });
    }

    const secret = speakeasy.generateSecret({
      name: `App-${user.username}`,
      length: 20,
    });

    user.twoFactorTempSecret = secret.base32;
    await user.save();

    // Tạo QR code từ otpauth_url
    const qrDataURL = await QRCode.toDataURL(secret.otpauth_url);

    return res.status(200).json({
      status: true,
      otpauth_url: secret.otpauth_url,
      qr: qrDataURL,
      base32: secret.base32,
      message: 'Quét QR trong Google Authenticator và xác minh bằng mã OTP.'
    });
  } catch (err) {
    console.error('Setup 2FA error:', err);
    return res.status(500).json({ error: 'Lỗi server khi setup 2FA' });
  }
};

// Xác minh mã OTP để kích hoạt 2FA (dùng secret tạm)
exports.verify2FA = async (req, res) => {
  try {
    const currentUser = req.user;
    // Chấp nhận cả 'token' hoặc 'code' từ client cho linh hoạt
    const { token, code } = req.body;
    const otp = token || code;
    if (!otp) return res.status(400).json({ error: 'Thiếu mã OTP' });

    const user = await User.findById(currentUser.userId || currentUser._id).select('+twoFactorTempSecret +twoFactorSecret');
    if (!user) return res.status(404).json({ status: false, message: 'User không tồn tại' });
    if (user.twoFactorEnabled) return res.status(400).json({ status: false, message: '2FA đã được bật' });
    if (!user.twoFactorTempSecret) return res.status(400).json({ status: false, message: 'Chưa tạo secret tạm' });

    // Speakeasy yêu cầu field 'token', không phải 'code'.
    const verified = speakeasy.totp.verify({
      secret: user.twoFactorTempSecret,
      encoding: 'base32',
      token: otp,
      window: 1, // Cho phép lệch 1 bước thời gian (±30s)
    });
    if (!verified) {
      return res.status(400).json({ status: false, message: 'Mã OTP không chính xác hoặc đã hết hạn' });
    }

    // Chuyển secret tạm thành secret chính & bật 2FA
    user.twoFactorSecret = user.twoFactorTempSecret;
    user.twoFactorTempSecret = undefined;
    user.twoFactorEnabled = true;
    await user.save();

    return res.status(200).json({ status: true, message: 'Kích hoạt 2FA thành công', twoFactorEnabled: true });
  } catch (err) {
    console.error('Verify 2FA error:', err);
    return res.status(500).json({ status: false, message: 'Lỗi server khi verify 2FA' });
  }
};

// Tắt 2FA (yêu cầu OTP hiện tại nếu đang bật để tránh bị lạm dụng)
exports.disable2FA = async (req, res) => {
  try {
    const currentUser = req.user;
    const { code } = req.body; // OTP để xác nhận tắt
    const user = await User.findById(currentUser.userId || currentUser._id).select('+twoFactorSecret');
    if (!user) return res.status(404).json({ error: 'User không tồn tại' });
    if (!user.twoFactorEnabled) return res.status(400).json({ status: false, message: '2FA chưa bật' });
    console.log(code);
    // Xác thực OTP trước khi tắt
    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
    if (!verified) return res.status(401).json({ status: false, message: 'Mã OTP không chính xác hoặc đã hết hạn' });

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.twoFactorTempSecret = undefined;
    await user.save();
    return res.status(200).json({ status: true, message: 'Đã tắt 2FA thành công', twoFactorEnabled: false });
  } catch (err) {
    console.error('Disable 2FA error:', err);
    return res.status(500).json({ error: 'Lỗi server khi tắt 2FA' });
  }
};

// Helper: Tạo mã nạp tiền (6 ký tự) - duplicate sẽ được unique index xử lý
function generateUniqueDepositCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const codeLength = 6;
  let code = '';
  for (let i = 0; i < codeLength; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

// Helper: Tạo mã giới thiệu (8 ký tự) - bỏ I, O, 0, 1 để tránh nhầm lẫn
function generateReferralCode() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codeLength = 8;
  let code = '';
  for (let i = 0; i < codeLength; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

exports.register = async (req, res) => {
  try {
    let { username, password, recaptchaToken, referralCode: inputReferralCode } = req.body;

    // Xác thực reCAPTCHA
    const { verifyRecaptcha } = require('../captcha/captchaController');
    const recaptchaResult = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaResult.success) {
      return res.status(400).json({ error: recaptchaResult.message });
    }

    // Chuyển username thành chữ thường
    username = username.toLowerCase();

    // Kiểm tra username và password không được ngắn hơn 6 ký tự
    if (username.length < 6) {
      return res.status(400).json({ error: "Tên người dùng phải có ít nhất 6 ký tự" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự" });
    }

    // Kiểm tra username chỉ chứa chữ và số (không cho phép ký tự đặc biệt hoặc gạch dưới)
    const usernameRegex = /^[a-zA-Z0-9]+$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ error: "Tên người dùng không được chứa ký tự đặc biệt" });
    }

    // Kiểm tra username phải chứa ít nhất một ký tự chữ
    const containsLetterRegex = /[a-zA-Z]/;
    if (!containsLetterRegex.test(username)) {
      return res.status(400).json({ error: "Tên người dùng phải chứa ít nhất một ký tự chữ" });
    }

    // Kiểm tra nếu người dùng đã tồn tại (không phân biệt hoa thường)
    const existingUser = await User.findOne({ username: username.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: "Tên người dùng đã tồn tại" });
    }

    // Kiểm tra xem đã có admin chưa
    const isAdminExists = await User.findOne({ role: "admin" });

    // **Tạo API key**
    const apiKey = crypto.randomBytes(32).toString("hex");

    // **Tạo user với retry cho depositCode trùng**
    let savedUser = null;
    const maxRetries = 10;

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        const depositCode = generateUniqueDepositCode();
        const referralCode = generateReferralCode();

        // Tìm người giới thiệu (nếu có)
        let referrer = null;
        if (inputReferralCode) {
          referrer = await User.findOne({ referralCode: inputReferralCode.toUpperCase() });
        }

        const user = new User({
          username,
          password,
          role: isAdminExists ? "user" : "admin",
          apiKey,
          depositCode,
          referralCode,
          referredBy: referrer ? referrer._id : null,
          referredByCode: referrer ? inputReferralCode.toUpperCase() : null,
        });
        savedUser = await user.save();
        break; // Thành công
      } catch (saveErr) {
        if (saveErr.code === 11000 && saveErr.keyPattern?.depositCode) {
          // Duplicate depositCode - retry
          console.log(`⚠️ Mã nạp tiền trùng, retry ${retry + 1}/${maxRetries}...`);
          continue;
        }
        throw saveErr; // Lỗi khác, throw ra ngoài
      }
    }

    // Fallback: dùng timestamp nếu tất cả retry đều trùng
    if (!savedUser) {
      try {
        const timestamp = Date.now().toString(36).toUpperCase();
        const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 6 - timestamp.length);
        const depositCode = (timestamp + randomPart).substring(0, 6);
        const referralCode = generateReferralCode();

        // Tìm người giới thiệu (nếu có)
        let referrer = null;
        if (inputReferralCode) {
          referrer = await User.findOne({ referralCode: inputReferralCode.toUpperCase() });
        }

        const user = new User({
          username,
          password,
          role: isAdminExists ? "user" : "admin",
          apiKey,
          depositCode,
          referralCode,
          referredBy: referrer ? referrer._id : null,
          referredByCode: referrer ? inputReferralCode.toUpperCase() : null,
        });
        savedUser = await user.save();
        console.log(`✅ Fallback timestamp code: ${depositCode}`);
      } catch (fallbackErr) {
        return res.status(500).json({ error: "Không thể tạo tài khoản, vui lòng thử lại" });
      }
    }

    // Cập nhật thống kê affiliate cho người giới thiệu
    if (savedUser && savedUser.referredBy) {
      try {
        await User.findByIdAndUpdate(savedUser.referredBy, {
          $inc: { 'affiliateStats.totalReferrals': 1 }
        });
        console.log(`✅ Đã cập nhật totalReferrals cho người giới thiệu`);
      } catch (affiliateErr) {
        console.error('Lỗi cập nhật affiliate stats:', affiliateErr.message);
      }
    }

    // **Thông báo qua Telegram**
    const teleConfig = await Telegram.findOne();
    if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
      // Giờ Việt Nam (UTC+7)
      const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const telegramMessage =
        `📌 *Có khách mới được tạo!*\n` +
        `👤 *Khách hàng:* ${username}\n` +
        (savedUser.referredByCode ? `🔗 *Được giới thiệu bởi:* ${savedUser.referredByCode}\n` : '') +
        `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n`;
      try {
        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
          chat_id: teleConfig.chatId,
          text: telegramMessage,
          parse_mode: "Markdown",
        });
        console.log("Thông báo Telegram đã được gửi.");
      } catch (telegramError) {
        console.error("Lỗi gửi thông báo Telegram:", telegramError.message);
      }
    }

    return res.status(201).json({
      message: "Đăng ký thành công",
    });
  } catch (error) {
    console.error("Đăng ký lỗi:", error);
    return res.status(500).json({ error: "Có lỗi xảy ra. Vui lòng thử lại." });
  }
};

exports.getMe = async (req, res) => {
  try {
    const currentUser = req.user; // Lấy từ middleware
    const username = currentUser.username; // Lấy username từ params
    // Nếu là admin hoặc chính chủ mới được xem thông tin
    if (currentUser.role !== "admin" && currentUser.username !== username) {
      return res.status(403).json({ error: "Bạn không có quyền xem thông tin người dùng này" });
    }

    // Tìm người dùng theo username
    const user = await User.findOne({ username }).select("-password");
    if (!user) {
      return res.status(404).json({ error: "Người dùng không tồn tại" });
    }

    // Trả về thông tin user nhưng thay token bằng apiKey
    const loginHistory = Array.isArray(user.loginHistory)
      ? user.loginHistory.slice(-10).reverse()
      : [];
    return res.status(200).json({
      balance: user.balance,
      capbac: user.capbac,
      createdAt: user.createdAt,
      role: user.role,
      status: user.status,
      twoFactorEnabled: user.twoFactorEnabled,
      token: user.apiKey, // Hiển thị API Key thay vì token
      tongnap: user.tongnap,
      tongnapthang: user.tongnapthang,
      updatedAt: user.updatedAt,
      userId: user._id,
      telegramChat: user.telegramChatId ? true : false,
      username: user.username,
      depositCode: user.depositCode, // Mã nạp tiền duy nhất
      loginHistory,
    });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ error: "Có lỗi xảy ra. Vui lòng thử lại sau." });
  }
};

// Cập nhật thông tin người dùng (chỉ admin hoặc chính chủ mới có thể sửa)
exports.updateUser = async (req, res) => {
  try {
    const currentUser = req.user;
    const { id } = req.params;

    // Chỉ admin hoặc chính chủ mới được cập nhật
    if (currentUser.role !== "admin") {
      return res.status(403).json({ error: "Bạn không có quyền sửa thông tin người dùng này" });
    }

    const updatedData = req.body;
    const updatedUser = await User.findByIdAndUpdate(id, updatedData, { new: true })
      .select("-password");
    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.json(updatedUser);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
// Cộng tiền vào số dư (chỉ admin mới có quyền)
exports.addBalance = async (req, res) => {
  try {
    const currentUser = req.user;
    if (currentUser.role !== "admin") {
      return res.status(403).json({ error: "Chỉ admin mới có quyền cộng tiền vào số dư" });
    }
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Số tiền không hợp lệ" });
    }

    // Lấy ngày hiện tại
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    // Tìm người dùng và cập nhật số dư
    let user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "Người dùng không tồn tại" });
    }

    const update = {
      $inc: {
        balance: amount,
        tongnap: amount,
        tongnapthang: amount,
      },
      $set: { lastDepositMonth: { month: currentMonth, year: currentYear } },
    };

    const updatedUser = await User.findByIdAndUpdate(id, update, { new: true })
      .select("-password");

    // Lưu lịch sử giao dịch
    const currentBalance = updatedUser.balance;
    const historyDataa = new HistoryUser({
      username: updatedUser.username,
      madon: "null",
      hanhdong: "Cộng tiền",
      link: "",
      tienhientai: user.balance,
      tongtien: amount,
      tienconlai: currentBalance,
      createdAt: new Date(),
      mota: `Admin cộng thành công số tiền ${amount}`,
    });
    await historyDataa.save();
    const taoluc = new Date();

    // Sử dụng cấu hình Telegram trong DB
    const teleConfig = await Telegram.findOne();
    if (teleConfig && teleConfig.botToken && teleConfig.chatidnaptien) {
      // Giờ Việt Nam (UTC+7)
      const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const telegramMessage =
        `📌 *Cộng tiền!*\n` +
        `👤 *Khách hàng:* ${updatedUser.username}\n` +
        `👤 *Cộng tiền:*  Admin đã cộng thành công số tiền ${amount}.\n` +
        `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n`;
      try {
        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
          chat_id: teleConfig.chatidnaptien,
          text: telegramMessage,
          parse_mode: "Markdown",
        });
        console.log("Thông báo Telegram đã được gửi.");
      } catch (telegramError) {
        console.error("Lỗi gửi thông báo Telegram:", telegramError.message);
      }
    }

    // Gửi thông báo cho user nếu đã liên kết Telegram
    if (teleConfig && teleConfig.bot_notify && updatedUser.telegramChatId) {
      const taolucUser = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const userMessage =
        `🎉 *Thông báo cộng tiền!*\n` +
        `💰 *Số tiền:* ${Number(amount).toLocaleString("en-US")} VNĐ\n` +
        `💵 *Số dư hiện tại:* ${Number(Math.floor(currentBalance)).toLocaleString("en-US")} VNĐ\n` +
        `🔹 *Thời gian:* ${taolucUser.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n` +
        `📝 *Nội dung:* Admin cộng tiền`;
      try {
        await axios.post(`https://api.telegram.org/bot${teleConfig.bot_notify}/sendMessage`, {
          chat_id: updatedUser.telegramChatId,
          text: userMessage,
          parse_mode: "Markdown",
        });
        console.log("Thông báo Telegram cho user đã được gửi.");
      } catch (telegramError) {
        console.error("Lỗi gửi thông báo Telegram cho user:", telegramError.message);
      }
    }

    res.status(200).json({ message: "Cộng tiền thành công" });
  } catch (error) {
    console.error("Add balance error:", error);
    return res.status(500).json({ message: "Lỗi server" });
  }
};

// Trừ tiền khỏi số dư (chỉ admin mới có quyền)
exports.deductBalance = async (req, res) => {
  try {
    const currentUser = req.user;
    if (currentUser.role !== "admin") {
      return res.status(403).json({ error: "Chỉ admin mới có quyền trừ tiền từ số dư" });
    }

    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Số tiền cần trừ không hợp lệ" });
    }

    // Tìm người dùng trong cơ sở dữ liệu
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "Người dùng không tồn tại" });
    }

    // Kiểm tra số dư có đủ để trừ không
    if (user.balance < amount) {
      return res.status(400).json({ message: "Số dư không đủ để trừ" });
    }
    const tiencu = user.balance;
    // Trừ tiền và cập nhật số dư
    const updatedBalance = user.balance - amount;
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { balance: updatedBalance },
      { new: true }
    ).select("-password");

    // Lưu lịch sử giao dịch
    const historyData = new HistoryUser({
      username: updatedUser.username,
      madon: "null",
      hanhdong: "Trừ tiền",
      link: "",
      tienhientai: tiencu,
      tongtien: amount,
      tienconlai: updatedBalance,
      createdAt: new Date(),
      mota: `Admin trừ thành công số tiền ${amount}`,
    });
    await historyData.save();

    // Gửi thông báo qua Telegram (nếu cấu hình có đủ)
    const taoluc = new Date();
    const teleConfig = await Telegram.findOne();
    if (teleConfig && teleConfig.botToken && teleConfig.chatidnaptien) {
      // Giờ Việt Nam (UTC+7)
      const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const telegramMessage =
        `📌 *Trừ tiền!*\n` +
        `👤 *Khách hàng:* ${updatedUser.username}\n` +
        `💸 *Số tiền trừ:* Admin đã trừ thành công số tiền ${amount}.\n` +
        `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n`;
      try {
        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
          chat_id: teleConfig.chatidnaptien,
          text: telegramMessage,
          parse_mode: "Markdown",
        });
        console.log("Thông báo Telegram đã được gửi.");
      } catch (telegramError) {
        console.error("Lỗi gửi thông báo Telegram:", telegramError.message);
      }
    }

    return res.status(200).json({ message: "Trừ tiền thành công" });
  } catch (error) {
    console.error("Deduct balance error:", error);
    return res.status(500).json({ message: "Lỗi server" });
  }
};

// Xóa người dùng (chỉ admin mới có quyền)
exports.deleteUser = async (req, res) => {
  try {
    const currentUser = req.user;
    if (currentUser.role !== "admin") {
      return res.status(403).json({ error: "Chỉ admin mới có quyền xóa người dùng" });
    }
    const { id } = req.params;
    const deletedUser = await User.findByIdAndDelete(id);
    if (!deletedUser) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.json({ message: "Xóa user thành công" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Đổi mật khẩu (chỉ admin hoặc chính chủ tài khoản mới có thể đổi mật khẩu)
exports.changePassword = async (req, res) => {
  try {
    const currentUser = req.user;
    const { id } = req.params;
    const { oldPassword, newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ error: "Mật khẩu mới không được để trống" });
    }

    // Kiểm tra độ dài mật khẩu mới
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 6 ký tự" });
    }

    // Kiểm tra quyền hạn
    if (currentUser.role !== "admin" && currentUser._id.toString() !== id) {
      return res.status(403).json({ error: "Bạn không có quyền đổi mật khẩu cho người dùng này" });
    }

    // Tìm user
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Người dùng không tồn tại" });
    }

    // Nếu không phải admin, kiểm tra mật khẩu cũ
    if (currentUser.role !== "admin") {
      if (!oldPassword) {
        return res.status(400).json({ error: "Vui lòng cung cấp mật khẩu hiện tại" });
      }
      const isMatch = await user.comparePassword(oldPassword);
      if (!isMatch) {
        return res.status(400).json({ error: "Mật khẩu hiện tại không chính xác" });
      }
    }

    // Cập nhật mật khẩu mới
    user.password = newPassword;

    // Tạo token mới
    const newToken = jwt.sign(
      { username: user.username, userId: user._id, role: user.role },
      process.env.secretKey
    );

    // **Tạo API key mới**
    const newApiKey = crypto.randomBytes(32).toString("hex");

    // Cập nhật thông tin mới vào database
    user.apiKey = newApiKey;
    await user.save();

    return res.status(200).json({
      message: "Đổi mật khẩu thành công"

    });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ error: "Có lỗi xảy ra. Vui lòng thử lại sau." });
  }
};

// // Lấy danh sách tất cả người dùng (chỉ admin mới có quyền)
// exports.getAllUsers = async (req, res) => {
//   try {
//     const currentUser = req.user;
//     if (currentUser.role !== "admin") {
//       return res.status(403).json({ error: "Chỉ admin mới có quyền xem danh sách người dùng" });
//     }
//     const users = await User.find()
//       .select("-password")
//       .sort({ balance: -1 }); // Sắp xếp theo balance từ cao đến thấp

//     // Lấy tất cả user, loại bỏ trường password
//     //const users = await User.find().select("-password");
//     return res.status(200).json({ users });
//   } catch (error) {
//     console.error("Get all users error:", error);
//     return res.status(500).json({ error: "Có lỗi xảy ra. Vui lòng thử lại sau." });
//   }
// };
exports.getUsers = async (req, res) => {
  try {
    const currentUser = req.user;
    if (currentUser.role !== "admin") {
      return res.status(403).json({ error: "Chỉ admin mới có quyền xem danh sách người dùng" });
    }

    // Lấy các tham số từ query
    let { username } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    // Tạo bộ lọc tìm kiếm
    const filter = username ? { username: { $regex: username, $options: "i" } } : {};

    const skip = (page - 1) * limit;
    const users = await User.find(filter)
      .select("-password")
      .sort({ balance: -1 })
      .skip(skip)
      .limit(limit);

    // Tổng số người dùng
    const total = await User.countDocuments(filter);

    return res.json({
      total,
      page,
      totalPages: Math.ceil(total / limit),
      users,
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách người dùng:", error);
    return res.status(500).json({ message: "Lỗi server", error: error.message });
  }
};

// Lấy danh sách lịch sử theo username hoặc orderId, hỗ trợ phân trang
exports.getHistory = async (req, res) => {
  try {
    const currentUser = req.user;
    let { page = 1, limit = 10, orderId, search, action } = req.query;
    page = parseInt(page);
    limit = limit === "all" ? null : parseInt(limit);
    const skip = (page - 1) * (limit || 0);
    let filter = {};

    if (currentUser.role === "admin") {
      // Admin: xem tất cả, tìm kiếm theo username hoặc orderId
      if (orderId) {
        filter.madon = orderId;
      }
      if (search) {
        filter.username = { $regex: search, $options: "i" };
      }
      if (action) {
        filter.hanhdong = action;
      }
    } else {
      // User thường: chỉ xem lịch sử của chính mình
      filter.username = currentUser.username;
      if (orderId) {
        filter.madon = orderId;
        // filter.search = link;
      }
      if (action) {
        filter.hanhdong = action;
      }
    }

    if (!limit) {
      const history = await HistoryUser.find(filter).sort({ createdAt: -1 });
      return res.status(200).json({
        history,
        totalItems: history.length,
        page: 1,
        totalPages: 1,
      });
    }

    const totalItems = await HistoryUser.countDocuments(filter);
    const totalPages = Math.ceil(totalItems / limit);

    const history = await HistoryUser.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    return res.status(200).json({
      history,
      totalItems,
      page,
      totalPages,
    });
  } catch (error) {
    console.error("Lỗi khi lấy lịch sử:", error);
    res.status(500).json({ message: "Lỗi server", error });
  }
};

// Bắt đầu tạo mã liên kết Telegram
// exports.startTelegramLink = async (req, res) => {
//   try {
//     const currentUser = req.user;
//     const user = await User.findById(currentUser.userId || currentUser._id);
//     if (!user) return res.status(404).json({ error: 'User không tồn tại' });
//     if (user.telegramChatId) {
//       return res.status(400).json({ message: 'Bạn đã liên kết Telegram rồi.' });
//     }
//     // Dùng apiKey làm mã liên kết luôn
//     if (!user.apiKey) {
//       user.apiKey = crypto.randomBytes(32).toString('hex');
//       await user.save();
//     }
//     return res.status(200).json({ code: user.apiKey });
//   } catch (err) {
//     console.error('startTelegramLink error:', err);
//     return res.status(500).json({ error: 'Lỗi server' });
//   }
// };

// Hàm dùng chung để xử lý lệnh (dùng cho polling)
exports.processTelegramCommand = async (chatId, text) => {
  try {
    if (text === '/start') {
      await sendTelegramMessage(chatId, `Chào bạn! Vui lòng truy cập vào: ${process.env.URL_WEBSITE || ''}/profile\n1. Sao chép API KEY của bạn\n2. Dán API KEY vào khung chat này.\n3. Sau khi liên kết: dùng /balance để xem số dư, /order MÃ ĐƠN để kiểm tra đơn, /unlink để hủy liên kết.\n4. Gõ /help để xem hướng dẫn.`);
      return;
    }
    if (text === '/help') {
      await sendTelegramMessage(chatId, `Hướng dẫn sử dụng bot:\n1. Vào website của bạn, đăng nhập và vào trang ${process.env.URL_WEBSITE || ''}/profile để sao chép API KEY.\n2. Quay lại đây và gửi API KEY vào khung chat này để liên kết tài khoản.\n3. Sau khi liên kết thành công, bạn có thể dùng các lệnh sau:\n/balance - Xem số dư hiện tại\n/order MÃ ĐƠN - Kiểm tra trạng thái đơn của bạn\n/unlink - Hủy liên kết tài khoản Telegram\n/help - Xem hướng dẫn sử dụng`);
      return;
    }
    if (/^[a-fA-F0-9]{64}$/.test(text)) {
      const apiKeyRaw = text.trim();
      const user = await User.findOne({ apiKey: { $regex: `^${apiKeyRaw}$`, $options: 'i' } });
      if (!user) {
        await sendTelegramMessage(chatId, 'API KEY không hợp lệ. Vào /profile để copy đúng.');
        return;
      }
      if (user.telegramChatId) {
        await sendTelegramMessage(chatId, 'Tài khoản này đã liên kết trước đó. Dùng /unlink nếu muốn hủy.');
        return;
      }
      const existing = await User.findOne({ telegramChatId: String(chatId) });
      if (existing) {
        await sendTelegramMessage(chatId, 'Chat này đã liên kết với tài khoản khác. Dùng /unlink nếu muốn đổi.');
        return;
      }
      user.telegramChatId = String(chatId);
      user.telegramLinkedAt = new Date();
      user.telegramBalanceSent = false;
      await user.save();
      await sendTelegramMessage(chatId, `Liên kết thành công tài khoản: ${user.username}. Dùng /balance để xem số dư.`);
      return;
    }
    if (text === '/unlink') {
      const user = await User.findOne({ telegramChatId: String(chatId) });
      if (!user) {
        await sendTelegramMessage(chatId, 'Chưa liên kết để hủy.');
        return;
      }
      user.telegramChatId = null;
      user.telegramLinkedAt = null;
      await user.save();
      await sendTelegramMessage(chatId, 'Đã hủy liên kết.Vào website để lấy API KEY và gửi để liên kết lại.');
      return;
    }
    if (text === '/balance') {
      const user = await User.findOne({ telegramChatId: String(chatId) });
      if (!user) {
        await sendTelegramMessage(chatId, 'Chưa liên kết. Vào website để lấy API KEY và gửi lại.');
        return;
      }
      await sendTelegramMessage(chatId, `Số dư hiện tại của bạn: ${Number(Math.floor(Number(user.balance))).toLocaleString("en-US")} VNĐ`);
      return;
    }
    if (text.startsWith('/order')) {
      const parts = text.split(/\s+/);
      if (parts.length !== 2) {
        await sendTelegramMessage(chatId, 'Sai cú pháp. Dùng: /order MÃ ĐƠN');
        return;
      }
      const code = parts[1].trim();
      const user = await User.findOne({ telegramChatId: String(chatId) });
      if (!user) {
        await sendTelegramMessage(chatId, 'Chưa liên kết. Gửi API KEY trước.');
        return;
      }
      // Tìm đơn theo Madon thuộc về user
      let order = await Order.findOne({ Madon: code, username: user.username });
      if (!order) {
        // fallback tìm theo orderId nếu người dùng gõ mã hệ thống khác
        order = await Order.findOne({ orderId: code, username: user.username });
      }
      if (!order) {
        await sendTelegramMessage(chatId, 'Không tìm thấy đơn hàng của bạn với mã này.');
        return;
      }
      const createdAtVN = new Date(order.createdAt.getTime() + 7 * 60 * 60 * 1000);

      await sendTelegramMessage(chatId,
        `🔎 Trạng thái đơn hàng\n` +
        `• Mã đơn: ${order.Madon}\n` +
        `• Dịch vụ: ${order.namesv}\n` +
        `• Số lượng: ${order.quantity || 0}\n` +
        `• Bắt đầu: ${order.start || 0}\n` +
        `• Đã chạy: ${order.dachay || 0}\n` +
        `• Trạng thái: ${order.status}\n` +
        `• Link: ${order.link}\n` +
        `• Tạo lúc: ${createdAtVN.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}\n`);
      return;
    }
    await sendTelegramMessage(chatId, 'Lệnh không hợp lệ. Gõ /start để xem hướng dẫn.');
  } catch (e) {
    console.error('processTelegramCommand error:', e.message);
  }
};

// API: User tự tạo mã nạp tiền mới
exports.generateNewDepositCode = async (req, res) => {
  try {
    const currentUser = req.user;
    const user = await User.findOne({ username: currentUser.username });

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại' });
    }

    // Retry logic để đảm bảo không bị trùng (xử lý race condition)
    const maxRetries = 10;
    let attempts = 0;
    let saved = false;
    let newCode = '';

    while (attempts < maxRetries && !saved) {
      try {
        newCode = generateUniqueDepositCode();
        user.depositCode = newCode;
        await user.save();
        saved = true;
      } catch (saveError) {
        // E11000 là lỗi duplicate key của MongoDB
        if (saveError.code === 11000 && saveError.keyPattern?.depositCode) {
          attempts++;
          console.log(`⚠️ Mã ${newCode} bị trùng, thử lại lần ${attempts}...`);
          continue;
        }
        throw saveError; // Lỗi khác thì throw
      }
    }

    // Fallback: dùng timestamp nếu tất cả retry đều trùng
    if (!saved) {
      try {
        const timestamp = Date.now().toString(36).toUpperCase();
        const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 6 - timestamp.length);
        newCode = (timestamp + randomPart).substring(0, 6);
        user.depositCode = newCode;
        await user.save();
        saved = true;
        console.log(`✅ Fallback timestamp code: ${newCode}`);
      } catch (fallbackErr) {
        return res.status(500).json({ error: 'Không thể tạo mã duy nhất sau nhiều lần thử' });
      }
    }

    return res.status(200).json({
      success: true,
      depositCode: newCode,
      message: 'Mã nạp tiền mới đã được tạo thành công.'
    });
  } catch (error) {
    console.error('Generate new deposit code error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra khi tạo mã nạp tiền' });
  }
};

// ============ AFFILIATE APIs ============

// Lấy thông tin affiliate của user
exports.getAffiliateInfo = async (req, res) => {
  try {
    const currentUser = req.user;
    let user = await User.findOne({ username: currentUser.username });

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại' });
    }

    // Tự động tạo referralCode nếu chưa có
    if (!user.referralCode) {
      const maxRetries = 10;
      let saved = false;

      for (let retry = 0; retry < maxRetries && !saved; retry++) {
        try {
          user.referralCode = generateReferralCode();
          await user.save();
          saved = true;
          console.log(`✅ Đã tạo referralCode mới cho ${user.username}: ${user.referralCode}`);
        } catch (saveErr) {
          if (saveErr.code === 11000 && saveErr.keyPattern?.referralCode) {
            continue; // Retry với mã mới
          }
          throw saveErr;
        }
      }

      // Fallback với timestamp
      if (!saved) {
        const timestamp = Date.now().toString(36).toUpperCase();
        const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 8 - timestamp.length);
        user.referralCode = (timestamp + randomPart).substring(0, 8);
        await user.save();
      }
    }

    // Đếm số người giới thiệu cấp 1
    const directReferrals = await User.countDocuments({ referredBy: user._id });

    return res.status(200).json({
      success: true,
      referralCode: user.referralCode,
      stats: {
        totalEarnings: user.affiliateStats?.totalEarnings || 0,
        monthlyEarnings: user.affiliateStats?.monthlyEarnings || 0,
        totalReferrals: directReferrals,
      },
      referralLink: `${process.env.URL_WEBSITE || ''}/dang-ky?ref=${user.referralCode}`
    });
  } catch (error) {
    console.error('Get affiliate info error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra khi lấy thông tin affiliate' });
  }
};

// Lấy danh sách người đã giới thiệu (multi-level)
exports.getAffiliateReferrals = async (req, res) => {
  try {
    const currentUser = req.user;
    const { page = 1, limit = 10, level = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const targetLevel = parseInt(level);

    // Tìm user ID của current user
    const user = await User.findOne({ username: currentUser.username });
    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại' });
    }

    // Hàm đệ quy lấy referrals theo cấp
    async function getReferralsByLevel(userId, currentLevel, targetLevel) {
      if (currentLevel > targetLevel) return [];

      const directReferrals = await User.find({ referredBy: userId })
        .select('username createdAt affiliateStats.totalEarnings referralCode')
        .lean();

      if (currentLevel === targetLevel) {
        return directReferrals;
      }

      // Nếu chưa đến cấp target, tiếp tục tìm cấp sâu hơn
      let allReferrals = [];
      for (const ref of directReferrals) {
        const subReferrals = await getReferralsByLevel(ref._id, currentLevel + 1, targetLevel);
        allReferrals = allReferrals.concat(subReferrals);
      }
      return allReferrals;
    }

    // Lấy referrals theo level
    const allReferrals = await getReferralsByLevel(user._id, 1, targetLevel);
    const total = allReferrals.length;

    // Phân trang
    const referrals = allReferrals.slice(skip, skip + parseInt(limit)).map(r => ({
      username: r.username,
      createdAt: r.createdAt,
      totalDeposit: r.affiliateStats?.totalEarnings || 0,
    }));

    return res.status(200).json({
      success: true,
      level: targetLevel,
      referrals,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (error) {
    console.error('Get affiliate referrals error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra khi lấy danh sách giới thiệu' });
  }
};

// ============ ADMIN AFFILIATE COMMISSION APIs ============
const AffiliateCommission = require('../../models/AffiliateCommission');

// Lấy danh sách commission (admin)
exports.getAffiliateCommissions = async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {};
    if (status && status !== 'all') {
      query.status = status;
    }

    const [commissions, total] = await Promise.all([
      AffiliateCommission.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      AffiliateCommission.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      commissions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (error) {
    console.error('Get affiliate commissions error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra' });
  }
};

// Duyệt hoa hồng (admin)
exports.approveAffiliateCommission = async (req, res) => {
  try {
    const { commissionId } = req.params;
    const adminUser = req.user;

    const commission = await AffiliateCommission.findById(commissionId);
    if (!commission) {
      return res.status(404).json({ error: 'Không tìm thấy hoa hồng' });
    }
    if (commission.status !== 'pending') {
      return res.status(400).json({ error: 'Hoa hồng đã được xử lý' });
    }

    // Tìm referrer và cộng tiền
    const referrer = await User.findById(commission.referrer);
    if (!referrer) {
      return res.status(404).json({ error: 'Không tìm thấy người nhận hoa hồng' });
    }

    // Lấy thời điểm hiện tại
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Cập nhật số dư và thống kê affiliate
    const updateQuery = {
      $inc: {
        balance: commission.commissionAmount,
        'affiliateStats.totalEarnings': commission.commissionAmount
      }
    };

    // Reset monthlyEarnings nếu sang tháng mới
    if (referrer.affiliateStats?.lastEarningMonth !== currentMonth ||
      referrer.affiliateStats?.lastEarningYear !== currentYear) {
      updateQuery.$set = {
        'affiliateStats.monthlyEarnings': commission.commissionAmount,
        'affiliateStats.lastEarningMonth': currentMonth,
        'affiliateStats.lastEarningYear': currentYear
      };
    } else {
      updateQuery.$inc['affiliateStats.monthlyEarnings'] = commission.commissionAmount;
    }

    const updatedReferrer = await User.findByIdAndUpdate(
      referrer._id,
      updateQuery,
      { new: true }
    );

    // Cập nhật trạng thái commission
    commission.status = 'approved';
    commission.approvedBy = adminUser._id;
    commission.approvedAt = new Date();
    await commission.save();

    // Lưu lịch sử
    const historyData = new HistoryUser({
      username: referrer.username,
      madon: `AFF-${commission.depositorUsername}`,
      hanhdong: "Hoa hồng Affiliate",
      link: "",
      tienhientai: updatedReferrer.balance - commission.commissionAmount,
      tongtien: commission.commissionAmount,
      tienconlai: updatedReferrer.balance,
      createdAt: new Date(),
      mota: `Hoa hồng (${commission.commissionPercent}%) từ ${commission.depositorUsername} nạp ${commission.depositAmount.toLocaleString()} VNĐ`,
    });
    await historyData.save();

    return res.status(200).json({
      success: true,
      message: `Đã duyệt hoa hồng ${commission.commissionAmount.toLocaleString()} VNĐ cho ${referrer.username}`,
      newBalance: updatedReferrer.balance
    });
  } catch (error) {
    console.error('Approve affiliate commission error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra' });
  }
};

// Từ chối hoa hồng (admin)
exports.rejectAffiliateCommission = async (req, res) => {
  try {
    const { commissionId } = req.params;
    const { reason } = req.body;

    const commission = await AffiliateCommission.findById(commissionId);
    if (!commission) {
      return res.status(404).json({ error: 'Không tìm thấy hoa hồng' });
    }
    if (commission.status !== 'pending') {
      return res.status(400).json({ error: 'Hoa hồng đã được xử lý' });
    }

    // Cập nhật trạng thái
    commission.status = 'rejected';
    commission.rejectedReason = reason || 'Admin từ chối';
    await commission.save();

    return res.status(200).json({
      success: true,
      message: 'Đã từ chối hoa hồng'
    });
  } catch (error) {
    console.error('Reject affiliate commission error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra' });
  }
};

// Lấy pending commissions của user hiện tại
exports.getMyPendingCommissions = async (req, res) => {
  try {
    const currentUser = req.user;
    const user = await User.findOne({ username: currentUser.username });

    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy user' });
    }

    const pendingCommissions = await AffiliateCommission.find({
      referrer: user._id,
      status: 'pending'
    }).sort({ createdAt: -1 }).lean();

    const totalPending = pendingCommissions.reduce((sum, c) => sum + c.commissionAmount, 0);

    return res.status(200).json({
      success: true,
      pendingCommissions,
      totalPending,
      count: pendingCommissions.length
    });
  } catch (error) {
    console.error('Get my pending commissions error:', error);
    return res.status(500).json({ error: 'Có lỗi xảy ra' });
  }
};
