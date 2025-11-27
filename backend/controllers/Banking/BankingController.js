const Bank = require('../../models/Bankking');
const TransactionBanking = require('../../models/TransactionBanking');

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
            banks = await Bank.find().select("-bank_account -bank_password -token -url_api -code");
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
        const { page = 1, limit = 10, username, transactionID } = req.query;

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

        if ( transactions.length === 0) {
            return res.status(404).json({ message: 'không có' });
        }

        // Trả về kết quả
        res.json(transactions);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};