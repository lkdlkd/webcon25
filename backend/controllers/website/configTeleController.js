const Telegram = require('../../models/Telegram');

// Lấy thông tin Telegram config (lấy bản active đầu tiên)
exports.getTelegramConfig = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Chỉ admin mới có quyền truy cập' });
        }
        let config = await Telegram.findOne();
        // Nếu chưa có cấu hình, trả về dữ liệu rỗng
        if (!config) {
            config = {
                botToken: "",
                chatId: "", // chat ID đơn hàng chính
                chatiddontay: "", // chat ID đơn tay
                chatidnaptien: "", // chat ID nạp tiền
                chatidthaydoigoi: "", // chat ID thay đổi gói
                chatidsdnguon: "", // chat ID số dư ngưồn
                bot_notify : "", // bot người dùng
            };
        }
        res.status(200).json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi server', error: error.message });
    }
};

// Cập nhật hoặc tạo mới Telegram config (chỉ 1 bản active)
exports.updateTelegramConfig = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Chỉ admin mới có quyền cập nhật' });
        }
        const { botToken, chatId ,chatiddontay, bot_notify , chatidnaptien, chatidthaydoigoi, chatidsdnguon } = req.body;
        let config = await Telegram.findOne();
        if (config) {
            config.botToken = botToken;
            config.chatId = chatId; 
            config.chatiddontay = chatiddontay;
            config.chatidnaptien = req.body.chatidnaptien;
            config.chatidthaydoigoi = req.body.chatidthaydoigoi;
            config.chatidsdnguon = req.body.chatidsdnguon;
            config.bot_notify = bot_notify;
            await config.save();
        } else {
            config = await Telegram.create({ botToken, chatId, chatiddontay, bot_notify, chatidnaptien, chatidthaydoigoi, chatidsdnguon });
        }
        res.json({ message: 'Cập nhật cấu hình Telegram thành công', config });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi server', error: error.message });
    }
};
