require('dotenv').config();
require('module-alias/register');
const express = require('express');
const connectDB = require('@/database/connection');
require('@/controllers/tool/updateServicePrices');
require('@/controllers/tool/checkOrderStatus');
require('@/controllers/tool/RechargeCardController');
require('@/controllers/tool/RestThang');
require('@/controllers/tool/laytrangthaicard');
require('@/controllers/tool/CheckBanKing');
require('@/controllers/tool/Updatetocdo'); // Đảm bảo import Updatetocdo.js để chạy cronjob cập nhật tốc độ dịch vụ
const cors = require('cors');
const api = require('@/routes/api'); // Đường dẫn đúng đến file api.js
const app = express();
const noti = require('@/routes/website/notificationsRouter');
app.use(express.json());
const multer = require('multer');
const upload = multer();
app.use(upload.any());
app.use(express.urlencoded({ extended: true }));
const path = require('path');
global.__basedir = path.resolve(__dirname);


// Cấu hình CORS cho các API khác
// Cho phép cả http và https cho domain cấu hình trong URL_WEBSITE (bỏ qua tiền tố www.)
const rawAllowed = process.env.URL_WEBSITE || '';
let allowedHost = '';
try {
    allowedHost = new URL(rawAllowed).hostname;
} catch (e) {
    // Nếu URL_WEBSITE không có scheme, coi như là host
    allowedHost = rawAllowed;
}
allowedHost = (allowedHost || '').replace(/^www\./, '').toLowerCase();

const corsOptions = {
    origin: (origin, callback) => {
        // Không cho phép yêu cầu không có Origin (ví dụ: Postman mặc định)
        if (!origin) return callback(new Error('Not allowed by CORS'));
        try {
            const u = new URL(origin);
            const host = (u.hostname || '').replace(/^www\./, '').toLowerCase();
            const isHttpOrHttps = u.protocol === 'http:' || u.protocol === 'https:';
            if (isHttpOrHttps && host === allowedHost) {
                return callback(null, true);
            }
        } catch (_) {
            // origin không hợp lệ
        }
        return callback(new Error('Not allowed by CORS'));
    },
};

// Middleware CORS tùy chỉnh
app.use((req, res, next) => {
    if (req.path.startsWith("/api/v2")) {
        // Không áp dụng CORS cho /api/v2
        next();
    } else {
        cors(corsOptions)(req, res, next);
    }
});
// Kết nối MongoDB
connectDB();

// Migration: Chạy 1 lần khi khởi động
const { migrateServiceStatus } = require('@/controllers/tool/migrationStatus');
connectDB().then(() => {
  migrateServiceStatus();
});

app.get('/', (req, res) => {
    res.send('API is running...');
});
app.get('/api/v2', (req, res) => {
    res.send('API V2 is running...');
});
// Sử dụng routes cho API
app.use('/api', api);
app.use('/api/noti', noti);

// ================= Bootstrap background services (Telegram bot + SMM cron) =================
const { bootstrapTelegramAndCrons } = require('@/controllers/Smm/telegramBot');
bootstrapTelegramAndCrons();

// Cron: gửi số dư sau 2 giờ kể từ khi liên kết Telegram (kiểm tra mỗi 5 phút)
// cron.schedule('*/5 * * * *', async () => {
//     try {
//         const now = new Date();
//         const threshold = new Date(now.getTime() - 1 * 60 * 1000);

//         // const threshold = new Date(now.getTime() - 2 * 60 * 60 * 1000);
//         const users = await User.find({
//             telegramChatId: { $ne: null },
//             telegramLinkedAt: { $lte: threshold },
//             telegramBalanceSent: false
//         }).limit(50);
//         if (!users.length) return;
//         const teleConfig = await Telegram.findOne();
//         if (!teleConfig || !teleConfig.bot_notify) return;
//         for (const u of users) {
//             try {
//                 if (bot) {
//                     await bot.sendMessage(u.telegramChatId, `Số dư hiện tại của bạn: ${Number(Math.floor(Number(u.balance))).toLocaleString("en-US")} VNĐ`);
//                 } else {
//                     await axios.post(`https://api.telegram.org/bot${teleConfig.bot_notify}/sendMessage`, {
//                         chat_id: u.telegramChatId,
//                         text: `Số dư hiện tại của bạn: ${Number(Math.floor(Number(u.balance))).toLocaleString("en-US")} VNĐ`,
//                         parse_mode: 'Markdown'
//                     });
//                 }
//                 u.telegramBalanceSent = true;
//                 await u.save();
//             } catch (e) {
//                 console.error('Telegram balance send fail for user', u._id.toString(), e.message);
//             }
//         }
//     } catch (err) {
//         console.error('Cron telegram balance error:', err.message);
//     }
// });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));


