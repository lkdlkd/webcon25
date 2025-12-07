const Refund = require('../../models/Refund');
const Order = require('../../models/Order');
const User = require('../../models/User');
const HistoryUser = require('../../models/History');
const Telegram = require('../../models/Telegram');
const axios = require('axios');

exports.getRefunds = async (req, res) => {
    try {
        const user = req.user;
        const { status, madon, username, page = 1, limit = 20 } = req.query;

        if (!user) {
            return res.status(401).json({ error: 'Không xác thực được người dùng' });
        }

        let filter = {};

        // Lọc theo status nếu có
        if (status !== undefined && status !== '') {
            filter.status = status === 'true' || status === true;
        }

        // Tìm theo mã đơn nếu có
        if (madon) {
            const madonNum = Number(madon);
            if (!isNaN(madonNum)) {
                filter.madon = madonNum;
            } else {
                filter.madon = madon;
            }
        }

        // Lọc theo username nếu có
        if (username) {
            filter.username = { $regex: username, $options: 'i' };
        }

        // Phân trang
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        const skip = (pageNum - 1) * limitNum;

        // Đếm tổng số và lấy dữ liệu
        const [total, refunds] = await Promise.all([
            Refund.countDocuments(filter),
            Refund.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum)
        ]);

        const totalPages = Math.ceil(total / limitNum);

        return res.status(200).json({
            success: true,
            data: refunds,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages,
                hasNext: pageNum < totalPages,
                hasPrev: pageNum > 1
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

// Controller: Admin cập nhật status hoàn tiền thành true (hỗ trợ nhiều mã đơn)
exports.adminApproveRefund = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Chỉ admin mới có quyền duyệt hoàn tiền.' });
        }

        // Cho phép nhận 1 hoặc nhiều mã đơn trong req.body.madon (string hoặc array)
        let { madons } = req.body;
        console.log(req.body);
        let codes = [];
        if (Array.isArray(madons)) {
            codes = madons.map(c => (c || '').toString().trim()).filter(Boolean);
        } else if (typeof madons === 'string') {
            codes = madons.split(/[\s,]+/).map(c => c.trim()).filter(Boolean);
        }
        if (!codes.length) {
            return res.status(400).json({ error: 'Thiếu mã đơn.' });
        }

        const teleConfig = await Telegram.findOne();
        const successes = [];
        const failures = [];

        for (const code of codes) {
            try {
                const refund = await Refund.findOne({ madon: code });
                if (!refund) {
                    failures.push({ madon: code, reason: 'Không tìm thấy đơn hoàn tiền.' });
                    continue;
                }
                if (refund.status === true) {
                    failures.push({ madon: code, reason: 'Đơn đã được duyệt hoàn tiền.' });
                    continue;
                }

                const targetUser = await User.findOne({ username: refund.username });
                if (!targetUser) {
                    failures.push({ madon: code, reason: 'Không tìm thấy người dùng.' });
                    continue;
                }

                const soTienHoan = Number(refund.tonghoan || 0);

                // Cập nhật số dư bằng atomic operation để tránh race condition
                const updatedUser = await User.findOneAndUpdate(
                    { username: refund.username },
                    { $inc: { balance: soTienHoan } },
                    { new: true }
                );
                
                if (!updatedUser) {
                    failures.push({ madon: code, reason: 'Không thể cập nhật số dư người dùng.' });
                    continue;
                }
                
                const tiencu = updatedUser.balance - soTienHoan;

                refund.status = true;
                await refund.save();

                // Cập nhật Order: iscancel = false (đánh dấu đã xử lý)
                await Order.updateOne(
                    { Madon: refund.madon },
                    { $set: { iscancel: false } }
                );

                // Lưu lịch sử hoàn tiền
                const historyData = new HistoryUser({
                    username: refund.username,
                    madon: refund.madon,
                    hanhdong: 'Hoàn tiền',
                    link: refund.link || '',
                    tienhientai: tiencu,
                    tongtien: soTienHoan,
                    tienconlai: updatedUser.balance,
                    createdAt: new Date(),
                    mota: `${refund.noidung}`,
                });
                await historyData.save();

                // Gửi thông báo Telegram theo định dạng cũ (mỗi đơn 1 tin nhắn)
                if (teleConfig && teleConfig.botToken && teleConfig.chatidnaptien) {
                    const soTienHoanFormatted = Number(Math.round(soTienHoan)).toLocaleString('en-US');
                    const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
                    const telegramMessage =
                        `📌 *THÔNG BÁO HOÀN TIỀN!*\n` +
                        `👤 *Khách hàng:* ${refund.username}\n` +
                        `🆔 *Mã đơn:* ${refund.madon}\n` +
                        `💰 *Số tiền hoàn:* ${soTienHoanFormatted}\n` +
                        `🔹 *Số lượng chưa chạy:* ${refund.chuachay} - Rate: ${refund.giatien}\n` +
                        `🔸 *Dịch vụ:* ${refund.server}\n` +
                        `⏰ *Thời gian:* ${taoluc.toLocaleString('vi-VN', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                        })}\n`;
                    try {
                        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
                            chat_id: teleConfig.chatidnaptien,
                            text: telegramMessage,
                            parse_mode: 'Markdown',
                        });
                    } catch (telegramError) {
                        console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                    }
                }

                successes.push({ madon: refund.madon, username: refund.username, amount: soTienHoan });
            } catch (err) {
                failures.push({ madon: code, reason: err.message || 'Lỗi không xác định' });
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Đã xử lý duyệt hoàn tiền.',
            approved: successes.length,
            failed: failures.length,
            successes,
            failures,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Controller: Admin xóa các đơn hoàn chưa duyệt
exports.adminDeleteRefunds = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Chỉ admin mới có quyền xóa đơn hoàn.' });
        }

        // Nhận madon/madons từ body hoặc query, hỗ trợ string/array
        let { madon, madons } = req.body && Object.keys(req.body).length ? req.body : req.query;
        let codes = [];
        if (Array.isArray(madon)) codes.push(...madon);
        else if (typeof madon === 'string') codes.push(...madon.split(/[\s,]+/));
        if (Array.isArray(madons)) codes.push(...madons);
        else if (typeof madons === 'string') codes.push(...madons.split(/[\s,]+/));
        codes = codes.map(c => (c || '').toString().trim()).filter(Boolean);
        // unique
        codes = Array.from(new Set(codes));

        if (!codes.length) {
            return res.status(400).json({ error: 'Thiếu mã đơn để xóa.' });
        }

        const successes = [];
        const failures = [];

        for (const code of codes) {
            try {
                const refund = await Refund.findOne({ madon: code });
                if (!refund) {
                    failures.push({ madon: code, reason: 'Không tìm thấy đơn hoàn.' });
                    continue;
                }
                if (refund.status === true) {
                    failures.push({ madon: code, reason: 'Đơn đã duyệt, không thể xóa.' });
                    continue;
                }
                await Refund.deleteOne({ _id: refund._id });
                // Cập nhật Order: iscancel = false (đánh dấu đã xử lý)
                await Order.updateOne(
                    { Madon: refund.madon },
                    { $set: { iscancel: false } }
                );

                successes.push({ madon: code });
            } catch (err) {
                failures.push({ madon: code, reason: err.message || 'Lỗi không xác định' });
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Đã xử lý xóa đơn hoàn chưa duyệt.',
            deleted: successes.length,
            failed: failures.length,
            successes,
            failures,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};
