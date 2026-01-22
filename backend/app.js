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
const multer = require('multer'); // Parse form-data
const api = require('@/routes/api'); // Đường dẫn đúng đến file api.js
const app = express();
const noti = require('@/routes/website/notificationsRouter');

// ================= Signature Verification Middleware =================
const crypto = require('crypto');

function verifySignature(req, res, next) {
    // Cho preflight đi qua
    if (req.method === 'OPTIONS') return next();

    // Whitelist các endpoint public (login, register, refresh) - không cần signature
    // Lưu ý: req.path không bao gồm /api vì middleware được mount tại /api
    const publicPaths = [
        '/login',
        '/register',
        '/recaptcha-site-key',
        '/configweblogo',
    ];

    // Kiểm tra nếu đường dẫn bắt đầu bằng một trong các public paths
    const isPublicPath = publicPaths.some(path => req.path === path || req.path.startsWith(path + '/'));
    if (isPublicPath) return next();

    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];
    const nonce = req.headers['x-nonce']; // Random string để chống replay
    const sessionKey = req.cookies?.sessionKey;

    // Nếu không có sessionKey cookie → chưa đăng nhập → cho qua (authenticate middleware sẽ chặn)
    if (!sessionKey) return next();

    // Nếu có sessionKey nhưng thiếu signature → reject
    if (!timestamp || !signature || !nonce) {
        return res.status(403).json({
            success: false,
            message: 'Thiếu thông tin xác thực'
        });
    }

    // Kiểm tra timestamp (chỉ cho phép request trong 30 giây - giảm từ 60s)
    const now = Date.now();
    const requestTime = parseInt(timestamp, 10);
    if (isNaN(requestTime) || Math.abs(now - requestTime) > 30000) {
        return res.status(403).json({
            success: false,
            message: 'Request đã hết hạn'
        });
    }

    // Lấy path từ originalUrl, bỏ prefix /api để match với frontend
    const fullPath = req.originalUrl.split('?')[0]; // Bỏ query string
    const apiPath = fullPath.replace(/^\/api/, ''); // Bỏ /api prefix

    // Tạo payload bao gồm: timestamp + method + path + nonce
    const payload = `${timestamp}:${req.method}:${apiPath}:${nonce}`;

    // Verify signature
    const expectedSignature = crypto
        .createHmac('sha256', sessionKey)
        .update(payload)
        .digest('hex');

    if (signature !== expectedSignature) {
        return res.status(403).json({
            success: false,
            message: 'Không hợp lệ'
        });
    }

    next();
}

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


// ================= API v2 - Public API (cho phép gọi từ bất kỳ nguồn nào) =================
const apiv2Controller = require('@/controllers/document/apiController');
const rechargeCardController = require('@/controllers/tool/RechargeCardController');
const blockedIPs = new Map();

const apiV2DetectSpam = rateLimit({
    windowMs: 60 * 1000,
    limit: 200, // 200 requests mỗi phút
    standardHeaders: true,
    legacyHeaders: false,

    handler: (req, res) => {
        blockedIPs.set(req.ip, Date.now() + 5 * 60 * 1000);
        return res.status(429).json({
            success: false,
            message: 'IP đã bị chặn 5 phút do spam'
        });
    }
});


// middleware check block
function checkBlocked(req, res, next) {
    const until = blockedIPs.get(req.ip);

    if (until) {
        if (Date.now() < until) {
            return res.status(429).json({
                success: false,
                message: 'IP đang bị chặn tạm thời'
            });
        }
        // Hết thời gian block → xóa
        blockedIPs.delete(req.ip);
    }

    next();
}


// CORS mở cho API v2 - cho phép tất cả origins
const corsV2Options = {
    origin: '*', // Cho phép tất cả origins
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false // Không cần credentials cho public API
};
// Multer middleware để parse form-data (chỉ text fields, không cho phép file)
const parseFormData = multer().none();

// Middleware merge query params vào body (query có độ ưu tiên thấp hơn body)
function mergeParamsToBody(req, res, next) {
    req.body = { ...req.query, ...req.body };
    next();
}

app.post(
    '/api/v2',
    cors(corsV2Options),
    checkBlocked, // phát hiện spam
    apiV2DetectSpam,// block 5 phút
    parseFormData, // Parse form-data và x-www-form-urlencoded
    mergeParamsToBody, // Merge query params vào body
    apiv2Controller.routeRequest
);
app.post('/api/charge/callback',
    cors(corsV2Options),
    checkBlocked,
    apiV2DetectSpam,
    parseFormData,
    mergeParamsToBody,
    rechargeCardController.handleCallback
);

// Route API v2 - chỉ có rate limiting, không có allowFrontendOnly hay verifySignature
app.get('/api/v2', checkBlocked, apiV2DetectSpam, (req, res) => {
    res.send('Vui lòng sử dụng POST /api/v2 để truy cập API');
});

// ================= API chính - Chỉ cho phép từ frontend =================
// Sử dụng routes cho API
app.use(
    '/api',
    allowFrontendOnly,
    cors(corsOptions),
    verifySignature,
    generalLimiter,
    api
);

app.use(
    '/api/noti',
    allowFrontendOnly,
    cors(corsOptions),
    // verifySignature đã được apply ở /api route
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


