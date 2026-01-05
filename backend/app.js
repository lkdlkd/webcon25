require('dotenv').config();
require('module-alias/register');
const express = require('express');
const rateLimit = require('express-rate-limit');
const connectDB = require('@/database/connection');
connectDB();
function allowFrontendOnly(req, res, next) {
    // Cho preflight đi qua
    if (req.method === 'OPTIONS') return next();

    const origin = req.headers.origin;

    if (!origin) {
        return res.status(403).json({
            success: false,
            message: 'Không hỗ trợ'
        });
    }

    try {
        const u = new URL(origin);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();

        if (host === allowedHost) {
            return next();
        }
    } catch (e) { }

    return res.status(403).json({
        success: false,
        message: 'Không hỗ trợ'
    });
}

require('@/controllers/tool/updateServicePrices');
require('@/controllers/tool/checkOrderStatus');
require('@/controllers/tool/RechargeCardController');
require('@/controllers/tool/RestThang');
require('@/controllers/tool/laytrangthaicard');
require('@/controllers/tool/CheckBanKing');
require('@/controllers/tool/Updatetocdo'); // Đảm bảo import Updatetocdo.js để chạy cronjob cập nhật tốc độ dịch vụ
require('@/controllers/tool/autoDeleteOldData'); // Cronjob tự động xóa dữ liệu cũ (chạy 2h sáng mỗi ngày)
require('@/controllers/tool/syncServicesFromSmm'); // Cronjob tự động đồng bộ services từ SMM API (chạy mỗi 6 giờ)
const cors = require('cors');
const cookieParser = require('cookie-parser'); // Thêm cookie-parser
const api = require('@/routes/api'); // Đường dẫn đúng đến file api.js
const app = express();
const noti = require('@/routes/website/notificationsRouter');

// ================= Rate Limiting - Chống spam API =================
// Rate limiter chung cho tất cả API
const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 phút
    max: 100, // Giới hạn 100 requests mỗi 1 phút
    message: { error: 'Quá nhiều requests từ IP này, vui lòng thử lại sau 1 phút' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiter cho API v2 (tạo order)
const apiV2Limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 phút
    max: 150, // Tối đa 150 requests mỗi phút
    message: { error: 'Quá nhiều requests, vui lòng thử lại sau 1 phút' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ================= Anti-Spam Protection =================
app.set('trust proxy', 1); // Nếu ứng dụng chạy sau proxy (như Nginx), để lấy đúng IP client
app.use(express.json());
app.use(cookieParser()); // Sử dụng cookie-parser
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
        // 1️⃣ Cho phép request không có Origin (server-to-server, cron, mobile, retry)
        if (!origin) return callback(null, true);

        try {
            const u = new URL(origin);
            const host = (u.hostname || '')
                .replace(/^www\./, '')
                .toLowerCase();

            const isHttpOrHttps = u.protocol === 'http:' || u.protocol === 'https:';

            if (isHttpOrHttps && host === allowedHost) {
                return callback(null, true);
            }
        } catch (e) {
            // origin không hợp lệ → không cho
        }

        // 2️⃣ Không throw Error – chỉ từ chối
        return callback(null, false);
    },
    credentials: true
};


// Áp dụng rate limiting
app.use('/api/v2', apiV2Limiter); // Rate limit cho API v2
app.get('/api/v2', (req, res) => {
    res.send('Vui lòng sử dụng post /api/v2 để truy cập API');
});
// Sử dụng routes cho API
app.use(
    '/api',
    allowFrontendOnly,
    cors(corsOptions),
    generalLimiter,
    api
);

app.use(
    '/api/noti',
    allowFrontendOnly,
    cors(corsOptions),
    generalLimiter,
    noti
);


// ================= Bootstrap background services (Telegram bot + SMM cron) =================
const { bootstrapTelegramAndCrons } = require('@/controllers/Smm/telegramBot');
bootstrapTelegramAndCrons();
require('@/cron/scheduledOrderCron'); // Cronjob xử lý đơn hàng hẹn giờ

const PORT = process.env.PORT || 5000;
const http = require('http');
const server = http.createServer(app);

// Khởi tạo Socket.IO
const { initSocket } = require('@/utils/socket');
initSocket(server);

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));


