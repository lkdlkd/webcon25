const Bank = require('../../models/Bankking');
const TransactionBanking = require('../../models/TransactionBanking');
const { emitDepositSuccess } = require('../../utils/socket');
const axios = require('axios');
const Telegram = require('../../models/Telegram');
// Tạo bank (chỉ admin)
exports.createBank = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ error: 'Chỉ admin mới có quyền sử dụng chức năng này' });
        }
        const bank = new Bank(req.body);
        await bank.save();
        res.status(201).json(bank);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Cập nhật bank (chỉ admin)
exports.updateBank = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ error: 'Chỉ admin mới có quyền sử dụng chức năng này' });
        }
        const bank = await Bank.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!bank) return res.status(404).json({ message: 'Bank not found' });
        res.json(bank);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Xóa bank (chỉ admin)
exports.deleteBank = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ error: 'Chỉ admin mới có quyền sử dụng chức năng này' });
        }
        const bank = await Bank.findByIdAndDelete(req.params.id);
        if (!bank) return res.status(404).json({ message: 'Bank not found' });
        res.json({ message: 'Bank deleted successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Lấy danh sách bank
exports.getBank = async (req, res) => {
    try {
        const user = req.user;
        let banks;
        // Nếu là admin, hiển thị tất cả các trường
        if (user && user.role === "admin") {
            banks = await Bank.find();
        } else {
            // User thường: ẩn các trường nhạy cảm
            banks = await Bank.find({ status: true }).select("-bank_account -bank_password -token -url_api -code");
        }
        if (!banks || banks.length === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }
        res.json(banks);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};
exports.getTransactions = async (req, res) => {
    try {
        const user = req.user;
        let transactions;

        // Lấy các tham số truy vấn
        const { page = 1, limit = 10, username, transactionID, code } = req.query;

        if (user && user.role === "admin") {
            // Admin: Hiển thị tất cả các giao dịch, có thể tìm kiếm và phân trang
            const query = {};

            // Tìm kiếm theo username
            if (username) {
                query.username = { $regex: username, $options: "i" }; // Tìm kiếm không phân biệt hoa thường
            }

            // Tìm kiếm theo transactionID
            if (transactionID) {
                query.transactionID = { $regex: transactionID, $options: "i" }; // Tìm kiếm không phân biệt hoa thường
            }

            // Tìm kiếm theo mã nạp tiền (code)
            if (code) {
                query.code = { $regex: code, $options: "i" };
            }

            // Lấy danh sách giao dịch theo điều kiện, phân trang và sắp xếp
            transactions = await TransactionBanking.find(query)
                .sort({ createdAt: -1 }) // Sắp xếp theo thời gian mới nhất
                .skip((page - 1) * limit) // Bỏ qua các bản ghi trước đó
                .limit(parseInt(limit)); // Giới hạn số lượng bản ghi trả về
        } else {
            // User thường: Chỉ hiển thị giao dịch của chính họ, có phân trang
            transactions = await TransactionBanking.find({ username: user.username })
                .select("username transactionDate note amount createdAt")
                .sort({ createdAt: -1 }) // Sắp xếp theo thời gian mới nhất
                .skip((page - 1) * limit) // Bỏ qua các bản ghi trước đó
                .limit(parseInt(limit)); // Giới hạn số lượng bản ghi trả về
        }

        if (transactions.length === 0) {
            return res.status(200).json(transactions = []);
        }

        // Trả về kết quả
        res.json(transactions);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};
// Helper: Format tiền
function formatMoney(amount) {
    return Number(Math.floor(Number(amount))).toLocaleString("en-US");
}
// Manual deposit - Admin cộng tiền thủ công theo mã nạp tiền
exports.manualDeposit = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ success: false, message: 'Chỉ admin mới có quyền sử dụng chức năng này' });
        }

        const { depositCode, amount } = req.body;

        if (!depositCode || !amount) {
            return res.status(400).json({ success: false, message: 'Vui lòng nhập mã nạp tiền và số tiền' });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: 'Số tiền không hợp lệ' });
        }

        // Kiểm tra mã đã được cộng chưa
        const existingTransaction = await TransactionBanking.findOne({
            code: depositCode.toUpperCase(),
            status: 'COMPLETED'
        });
        if (existingTransaction) {
            return res.status(400).json({
                success: false,
                message: `Mã ${depositCode} đã được cộng tiền cho user ${existingTransaction.username} vào lúc ${new Date(existingTransaction.createdAt).toLocaleString('vi-VN')}`
            });
        }
        // Tìm user theo depositCode
        const User = require('../../models/User');
        const targetUser = await User.findOne({ depositCode: depositCode.toUpperCase() });
        if (!targetUser) {
            return res.status(404).json({ success: false, message: `Không tìm thấy user với mã nạp tiền: ${depositCode}` });
        }
        const username = targetUser.username;

        // Tạo mã nạp tiền mới với retry khi duplicate
        const crypto = require('crypto');
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const codeLength = 6;
        const maxRetries = 10;
        const oldDepositCode = targetUser.depositCode;
        let newDepositCode = '';
        let updatedUser = null;

        // Retry loop - chỉ retry khi duplicate key error
        for (let retry = 0; retry < maxRetries; retry++) {
            try {
                let code = '';
                for (let i = 0; i < codeLength; i++) {
                    code += characters.charAt(Math.floor(Math.random() * characters.length));
                }
                newDepositCode = code;

                // ATOMIC UPDATE by depositCode
                updatedUser = await User.findOneAndUpdate(
                    { depositCode: oldDepositCode },
                    {
                        $inc: { balance: amountNum, tongnap: amountNum, tongnapthang: amountNum },
                        $set: { depositCode: newDepositCode }
                    },
                    { new: true }
                );
                break; // Thành công
            } catch (updateErr) {
                if (updateErr.code === 11000) {
                    console.log(`⚠️ Mã ${newDepositCode} đã tồn tại, retry ${retry + 1}/${maxRetries}...`);
                    continue;
                }
                throw updateErr;
            }
        }

        // Fallback: dùng timestamp nếu tất cả retry đều trùng
        if (!updatedUser) {
            try {
                const timestamp = Date.now().toString(36).toUpperCase();
                const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 6 - timestamp.length);
                newDepositCode = (timestamp + randomPart).substring(0, 6);

                updatedUser = await User.findOneAndUpdate(
                    { depositCode: oldDepositCode },
                    {
                        $inc: { balance: amountNum, tongnap: amountNum, tongnapthang: amountNum },
                        $set: { depositCode: newDepositCode }
                    },
                    { new: true }
                );
                console.log(`✅ Fallback timestamp code: ${newDepositCode}`);
            } catch (fallbackErr) {
                return res.status(500).json({ success: false, message: 'Không thể cập nhật số dư user' });
            }
        }

        if (!updatedUser) {
            return res.status(500).json({ success: false, message: 'Không thể cập nhật số dư user' });
        }

        // Lưu transaction
        const newTransaction = new TransactionBanking({
            transactionID: `MANUAL_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
            typeBank: 'MANUAL',
            accountNumber: 'ADMIN',
            code: oldDepositCode,
            username: username,
            transactionDate: new Date(),
            amount: amountNum,
            description: `nạp tiền bằng check cú pháp ${depositCode} số tiền ${amountNum.toLocaleString('en-US')} vào lúc ${new Date().toLocaleString('vi-VN')}`,
            type: 'IN',
            status: 'COMPLETED',
            note: `Nạp tiền thành công ${formatMoney(amountNum)} VNĐ mã giao dịch ${oldDepositCode}`
        });
        await newTransaction.save();

        // Tạo history
        const HistoryUser = require('../../models/History');
        const historyData = new HistoryUser({
            username: username,
            madon: oldDepositCode,
            hanhdong: "Cộng tiền",
            link: "",
            tienhientai: updatedUser.balance - amountNum,
            tongtien: amountNum,
            tienconlai: updatedUser.balance,
            createdAt: new Date(),
            mota: `Nạp tiền thành công ${formatMoney(amountNum)} VNĐ mã giao dịch ${oldDepositCode}`,
        });
        await historyData.save();

        emitDepositSuccess(username, {
            newDepositCode,
            username: username,
            newBalance: updatedUser.balance,
            message: `Nạp tiền thành công ${formatMoney(amountNum)} VNĐ mã giao dịch ${oldDepositCode}`,
            timestamp: new Date(),
        });

        // Thông báo Telegram

        const teleConfig = await Telegram.findOne();
        const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
        const newBalance = updatedUser.balance;

        if (teleConfig && teleConfig.botToken && teleConfig.chatidnaptien) {
            const telegramMessage =
                `📌 NẠP TIỀN THỦ CÔNG THÀNH CÔNG!\n` +
                `👤 Khách hàng: ${username}\n` +
                `💰 Số tiền nạp: ${formatMoney(amountNum)}\n` +
                `📖 Nội dung: Nạp tiền thủ công ${formatMoney(amountNum)} VNĐ mã giao dịch ${oldDepositCode}\n` +
                `🔹 Số dư: ${formatMoney(newBalance)} VNĐ\n` +
                `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                })}`;
            try {
                await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
                    chat_id: teleConfig.chatidnaptien,
                    text: telegramMessage,
                });
                console.log("Thông báo Telegram admin đã được gửi.");
            } catch (telegramError) {
                console.error("Lỗi gửi thông báo Telegram admin:", telegramError.message);
            }
        }

        // Gửi thông báo cho user nếu có telegramChatId
        if (teleConfig && teleConfig.bot_notify && updatedUser.telegramChatId) {
            const userMessage =
                `🎉 Bạn vừa được nạp tiền thành công!\n` +
                `💰 Số tiền: ${formatMoney(amountNum)} VNĐ\n` +
                `💼 Số dư mới: ${formatMoney(newBalance)} VNĐ\n` +
                `📖 Nội dung: Nạp tiền thủ công ${formatMoney(amountNum)} VNĐ mã giao dịch ${oldDepositCode}\n` +
                `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                    day: "2-digit", month: "2-digit", year: "numeric",
                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                })}`;
            try {
                await axios.post(`https://api.telegram.org/bot${teleConfig.bot_notify}/sendMessage`, {
                    chat_id: updatedUser.telegramChatId,
                    text: userMessage,
                });
                console.log("Thông báo Telegram user đã được gửi.");
            } catch (telegramError) {
                console.error("Lỗi gửi thông báo Telegram user:", telegramError.message);
            }
        }

        res.json({
            success: true,
            message: `Đã cộng ${amountNum.toLocaleString('en-US')} VNĐ cho ${username}`,
            data: {
                username: username,
                amount: amountNum,
                newBalance: updatedUser.balance,
                oldDepositCode: oldDepositCode,
                newDepositCode: newDepositCode
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};