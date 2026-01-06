const express = require('express');
const router = express.Router();

const user = require("@/controllers/user/userControlll"); // Đường dẫn đúng đến file userController
const authenticate = require('@/controllers/Middleware/authenticate'); // Đường dẫn đúng đến file middleware
const smm = require('@/controllers/Smm/smmController')
const toolController = require("@/controllers/tool/getuid");
const { getStatistics } = require('@/controllers/website/thongkeController');
const { addOrder, deleteOrder, getOrders } = require('@/controllers/order/orderController');
const { updateOrderStatus } = require('@/controllers/order/orderController');
const card = require('@/controllers/thecao/CardController');
const server = require('@/controllers/server/ServerController');
const banking = require('../controllers/Banking/BankingController'); // Đường dẫn đúng đến bankingController
const catagory = require('@/controllers/server/CatagoryController'); // Đường dẫn đúng đến CatagoryController
const platform = require('@/controllers/server/PlatformController'); // Đường dẫn đúng đến PlatformController
const configwebController = require("../controllers/website/ConfigwebController");
const configCardController = require("../controllers/website/configCardController");
const { createPromotion, updatePromotion, deletePromotion, getPromotions } = require('../controllers/Khuyenmai/KhuyenmaiController');
const rateLimit = require('express-rate-limit');

const scheduledController = require('@/controllers/order/scheduledController');

const SmmController = require('../controllers/Smm/Smm');
const refillCancelController = require('../controllers/order/RefilandCancelController');
const captchaController = require('@/controllers/captcha/captchaController'); // CAPTCHA controller

const refund = require('@/controllers/order/refundController');
const chatController = require('../controllers/chat/chatController');
router.get('/refund', authenticate.authenticateAdmin, refund.getRefunds);
router.post('/refund/approve', authenticate.authenticateAdmin, refund.adminApproveRefund);
router.delete('/refund', authenticate.authenticateAdmin, refund.adminDeleteRefunds);
router.post('/refill', authenticate.authenticateUser, refillCancelController.refillOrder); // ok Thực hiện refill đơn hàng
router.post('/cancel', authenticate.authenticateUser, refillCancelController.cancelOrder); // ok Thực hiện hủy đơn hàng
//auth
// Cấu hình rate-limit
const recaptchaLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 phút
  max: 20,              // tối đa 20 request / IP / 1 phút
  message: {
    error: "Bạn gửi quá nhiều request, vui lòng thử lại sau."
  }
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 đơn / phút
  message: { error: 'Bạn thao tác quá nhanh với đơn hàng' }
});

const WebLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 đơn / phút
  message: { error: 'Bạn thao tác quá nhanh với đơn hàng' }
});


// Route lấy site key với rate-limit
router.get('/recaptcha-site-key', recaptchaLimiter, captchaController.getSiteKey);
router.post('/login', recaptchaLimiter, user.login);//ok
router.post('/register', recaptchaLimiter, user.register);//ok
// 2FA routes
router.post('/2fa/setup', orderLimiter, authenticate.authenticateUser, user.setup2FA); // Tạo secret tạm & QR
router.post('/2fa/verify', orderLimiter, authenticate.authenticateUser, user.verify2FA); // Xác minh & bật 2FA
router.post('/2fa/disable', orderLimiter, authenticate.authenticateUser, user.disable2FA); // Tắt 2FA
// noti

// banking
router.get('/banking', authenticate.authenticateUser, banking.getBank); // ok Lấy thông tin ngân hàng của người dùng 
//thecao 
router.post('/thecao/recharge', WebLimiter, authenticate.authenticateUser, card.createTransaction); // ok Nạp thẻ cào
router.get('/thecao', authenticate.authenticateUser, card.getCard); // ok Lấy  chiết khấu thẻ cào
router.get('/thecao/history', authenticate.authenticateUser, card.GetHistoryCard); // ok Lấy lịch sử nạp thẻ cào theo ID người dùng
//user 
router.get('/user', authenticate.authenticateUser, user.getMe);// lấy thông tin của mình
router.put('/user/changePassword/:id', authenticate.authenticateUser, user.changePassword); // ok cả admin và user
router.get('/user/history', authenticate.authenticateUser, user.getHistory); // Lấy lịch sử giao dịch của người dùng
router.get('/server', authenticate.authenticateUser, server.getServer); // Lấy thông tin lịch sử thẻ cào theo ID người dùng
router.get('/servers', authenticate.authenticateUser, server.getServerByTypeAndPath);
// admin services
router.post('/smm/create', authenticate.authenticateAdmin, smm.createPartner); // ok Thêm mới đối tác SMM
router.get('/smm', authenticate.authenticateAdmin, smm.getAllPartners); // ok Lấy danh sách tất cả đối tác SMM
router.post('/smm/:id', authenticate.authenticateAdmin, smm.updatePartnerPrices); // ok Cập nhật giá tất cả dịch vụ theo price_update của đối tác SMM (ID truyền vào)
router.put('/smm/update/:id', authenticate.authenticateAdmin, smm.updatePartner); // ok Cập nhật thông tin đối tác SMM
router.delete('/smm/delete/:id', authenticate.authenticateAdmin, smm.deletePartner); // ok Xóa đối tác SMM
// admin server
router.post('/server/create', authenticate.authenticateAdmin, server.addServer); // ok Thêm mới máy chủ
router.delete('/server/delete/:id', authenticate.authenticateAdmin, server.deleteServer); // ok Lấy thông tin một máy chủ theo ID
router.put('/server/update/:id', authenticate.authenticateAdmin, server.updateServer); // ok Cập nhật thông tin máy chủ
// order
router.post('/order/add', orderLimiter, authenticate.authenticateUser, addOrder); // ok Thêm đơn hàng mới
router.get('/order', authenticate.authenticateUser, getOrders); // ok Lấy danh sách đơn hàng của người dùng
router.put('/order/update/:Madon', authenticate.authenticateAdmin, updateOrderStatus); // Cập nhật trạng thái đơn hàng
router.get('/scheduled-orders', authenticate.authenticateUser, scheduledController.getScheduledOrders);
router.patch('/scheduled-orders/:id/reschedule', authenticate.authenticateUser, scheduledController.rescheduleScheduledOrder);
router.delete('/scheduled-orders/:id', authenticate.authenticateUser, scheduledController.cancelScheduledOrder);
// router admin
router.put('/user/update/:id', authenticate.authenticateAdmin, user.updateUser); // ok Cập nhật thông tin người dùng
router.post('/user/addbalance/:id', authenticate.authenticateAdmin, user.addBalance); //ok Thêm tiền vào tài khoản người dùng
router.post('/user/deductbalance/:id', authenticate.authenticateAdmin, user.deductBalance); // Trừ tiền từ tài khoản người dùng
router.delete('/user/delete/:id', authenticate.authenticateAdmin, user.deleteUser); // Xóa người dùng
router.get('/users', authenticate.authenticateAdmin, user.getUsers); // Lấy danh sách tất cả người dùng
router.get('/thongke', authenticate.authenticateAdmin, getStatistics); // Lấy thông tin người dùng theo ID
router.delete('/order/delete/:orderId', authenticate.authenticateAdmin, deleteOrder); // ok Xóa đơn hàng (chỉ admin)
router.put('/banking/update/:id', authenticate.authenticateAdmin, banking.updateBank); // ok Cập nhật thông tin ngân hàng
router.delete('/banking/delete/:id', authenticate.authenticateAdmin, banking.deleteBank); // ok Xóa thông tin ngân hàng
router.post('/banking/create', authenticate.authenticateAdmin, banking.createBank); // ok Tạo mới thông tin ngân hàng
// Category routes
router.post('/categories', authenticate.authenticateAdmin, catagory.addCategory); // Thêm mới category (chỉ admin)
router.put('/categories/:id', authenticate.authenticateAdmin, catagory.updateCategory); // Cập nhật category (chỉ admin)
router.delete('/categories/:id', authenticate.authenticateAdmin, catagory.deleteCategory); // Xóa category (chỉ admin)
router.get('/categories', authenticate.authenticateUser, catagory.getCategories); // Lấy danh sách category (không cần admin)

// Platform routes
router.post('/platforms', authenticate.authenticateAdmin, platform.addPlatform); // Thêm mới platform (chỉ admin)
router.put('/platforms/:id', authenticate.authenticateAdmin, platform.updatePlatform); // Cập nhật platform (chỉ admin)
router.delete('/platforms/:id', authenticate.authenticateAdmin, platform.deletePlatform); // Xóa platform (chỉ admin)
router.get('/platforms', authenticate.authenticateUser, platform.getPlatforms); // Lấy danh sách platform (không cần admin)
// Định nghĩa route POST cho /api/tool/getUid
router.post("/getUid", toolController.getUid);
// Config web routes
router.get("/configweb", authenticate.authenticateUser, configwebController.getConfigweb); // Lấy cấu hình website
router.put("/configweb", authenticate.authenticateAdmin, configwebController.updateConfigweb); // Cập nhật cấu hình website
router.get("/configweblogo", recaptchaLimiter, configwebController.getConfigwebLogo); // Lấy logo website
// Config card routes
router.get("/config-card", authenticate.authenticateAdmin, configCardController.getConfigCard); // Lấy cấu hình thẻ nạp
router.put("/config-card", authenticate.authenticateAdmin, configCardController.updateConfigCard); // Cập nhật cấu hình thẻ nạp
const configTeleController = require('../controllers/website/configTeleController');

// Lấy cấu hình Telegram
router.get('/configtele', authenticate.authenticateAdmin, configTeleController.getTelegramConfig);
// Cập nhật cấu hình Telegram
router.put('/configtele', authenticate.authenticateAdmin, configTeleController.updateTelegramConfig);

// Route để lấy số dư từ SMM
// router.get('/getbalance/:id', authenticate.authenticateAdmin, SmmController.getBalance);
// Route để lấy danh sách dịch vụ từ SMM
router.get('/getservices/:id', authenticate.authenticateAdmin, SmmController.getServices);
router.get('/transactions', authenticate.authenticateUser, banking.getTransactions);
// Telegram linking
// router.post('/user/telegram/link/start', authenticate.authenticateUser, user.startTelegramLink);

// Sync services from SMM API
const { syncAllServices } = require('@/controllers/tool/syncServicesFromSmm');
router.post('/admin/sync-services', authenticate.authenticateAdmin, async (req, res) => {
  try {
    await syncAllServices();
    res.json({ success: true, message: 'Đồng bộ services thành công' });
  } catch (error) {
    console.error('Lỗi đồng bộ services:', error);
    res.status(500).json({ success: false, message: 'Lỗi khi đồng bộ services', error: error.message });
  }
});

router.get('/promotions', authenticate.authenticateUser, getPromotions);
router.post('/promotions', authenticate.authenticateAdmin, createPromotion);
// Route để sửa chương trình khuyến mãi
router.put('/promotions/:id', authenticate.authenticateAdmin, updatePromotion);
// Route để xóa chương trình khuyến mãi
router.delete('/promotions/:id', authenticate.authenticateAdmin, deletePromotion);

// Chat routes
router.get('/chat/list', authenticate.authenticateAdmin, chatController.getChatList);
router.get('/chat/unread/count', authenticate.authenticateUser, chatController.getUnreadCount);
router.get('/chat/:username', authenticate.authenticateUser, chatController.getChatDetail);
router.post('/chat/send', WebLimiter, authenticate.authenticateUser, chatController.sendMessage);
router.put('/chat/:username/read', authenticate.authenticateUser, chatController.markAsRead);
router.delete('/chat/:username', authenticate.authenticateAdmin, chatController.deleteChat);
module.exports = router;