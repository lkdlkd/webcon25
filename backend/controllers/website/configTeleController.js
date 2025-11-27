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
                chatId: "",
                bot_notify : "",
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
        const { botToken, chatId , bot_notify } = req.body;
        let config = await Telegram.findOne();
        if (config) {
            config.botToken = botToken;
            config.chatId = chatId;
            config.bot_notify = bot_notify;
            await config.save();
        } else {
            config = await Telegram.create({ botToken, chatId, bot_notify });
        }
        res.json({ message: 'Cập nhật cấu hình Telegram thành công', config });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi server', error: error.message });
    }
};
