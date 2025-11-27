const Promotion = require('../../models/Promotion');

// Thêm một chương trình khuyến mãi mới
exports.createPromotion = async (req, res) => {
    try {
        const { name, description, percentBonus, startDate, minAmount, endDate, repeatMonthly } = req.body;


        // Kiểm tra nếu đã tồn tại một chương trình khuyến mãi
        const existingPromotion = await Promotion.findOne({ name });
        if (existingPromotion) {
            return res.status(400).json({ message: 'Chương trình khuyến mãi đã tồn tại' });
        }

        // Chuyển đổi startDate và endDate thành startTime và endTime
        const startTime = new Date(startDate);
        const endTime = new Date(endDate);

        // Kiểm tra tính hợp lệ của ngày giờ
        if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
            return res.status(400).json({ message: 'startDate và endDate phải là ngày giờ hợp lệ (ISO 8601)' });
        }

        const promotion = new Promotion({
            name,
            description,
            minAmount: Number(minAmount), // Chuyển đổi minAmount sang kiểu Number
            percentBonus: Number(percentBonus), // Chuyển đổi percentBonus sang kiểu Number
            startTime,
            endTime,
            repeatMonthly: repeatMonthly || false, // Mặc định là false nếu không có giá trị
        });

        await promotion.save();
        res.status(201).json({ message: 'Thêm chương trình khuyến mãi thành công', promotion });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi khi thêm chương trình khuyến mãi', error: error.message });
    }
};

exports.updatePromotion = async (req, res) => {
    try {
        const { id } = req.params; // Lấy ID từ URL
        const updates = req.body; // Lấy dữ liệu cần cập nhật từ body

        // Chuyển đổi startDate và endDate thành startTime và endTime
        if (updates.startDate) {
            updates.startTime = new Date(updates.startDate);
            delete updates.startDate; // Xóa trường startDate để tránh lỗi
        }
        if (updates.endDate) {
            updates.endTime = new Date(updates.endDate);
            delete updates.endDate; // Xóa trường endDate để tránh lỗi
        }

        const promotion = await Promotion.findByIdAndUpdate(id, updates, { new: true });
        if (!promotion) {
            return res.status(404).json({ message: 'Không tìm thấy chương trình khuyến mãi' });
        }

        res.status(200).json({ message: 'Cập nhật chương trình khuyến mãi thành công', promotion });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi khi cập nhật chương trình khuyến mãi', error: error.message });
    }
};

// Xóa một chương trình khuyến mãi
exports.deletePromotion = async (req, res) => {
    try {
        const { id } = req.params; // Lấy ID từ URL

        const promotion = await Promotion.findByIdAndDelete(id);
        if (!promotion) {
            return res.status(404).json({ message: 'Không tìm thấy chương trình khuyến mãi để xóa' });
        }

        res.status(200).json({ message: 'Xóa chương trình khuyến mãi thành công', promotion });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi khi xóa chương trình khuyến mãi', error: error.message });
    }
};

exports.getPromotions = async (req, res) => {
    try {
        const user = req.user; // Lấy thông tin người dùng từ middleware xác thực
        let promotions;

        if (user && user.role === "admin") {
            // Admin: Hiển thị tất cả các trường
            promotions = await Promotion.find();
        } else {
            // User thường: Chỉ hiển thị các trường cụ thể
            promotions = await Promotion.find().select("name description percentBonus startTime endTime minAmount");
        }

        if (!promotions || promotions.length === 0) {
            return res.status(404).json({ message: 'No promotions found' });
        }

        res.status(200).json(promotions);
    } catch (error) {
        res.status(500).json({ message: 'Lỗi khi lấy danh sách khuyến mãi', error: error.message });
    }
};
/*
exports.updateMonthlyPromotions = async () => {
    try {
        const now = new Date();

        // Lấy tất cả các chương trình khuyến mãi có repeatMonthly = true
        const promotions = await Promotion.find({ repeatMonthly: true });
        if (!promotions || promotions.length === 0) {
            console.log("Không có chương trình khuyến mãi nào cần cập nhật.");
            return;
        }

        for (const promo of promotions) {
            try {
                // Logic cập nhật thời gian
                if (promo.endTime < now) {
                    let startTime = new Date(promo.startTime);
                    let endTime = new Date(promo.endTime);

                    // Cộng thêm 1 tháng cho startTime và giữ nguyên ngày
                    startTime.setMonth(startTime.getMonth() + 1);

                    // Cộng thêm 1 tháng cho endTime và đặt ngày cụ thể
                    endTime.setMonth(endTime.getMonth() + 1);

                    // Đặt ngày cụ thể cho endTime
                    const setSpecificDateForEndTime = (date) => {
                        const month = date.getMonth(); // Lấy tháng (0 = tháng 1, 1 = tháng 2, ...)
                        switch (month) {
                            case 0: // Tháng 1
                                date.setDate(31);
                                break;
                            case 1: // Tháng 2
                                date.setDate(28);
                                break;
                            case 2: // Tháng 3
                                date.setDate(31);
                                break;
                            case 3: // Tháng 4
                                date.setDate(30);
                                break;
                            case 4: // Tháng 5
                                date.setDate(31);
                                break;
                            case 5: // Tháng 6
                                date.setDate(30);
                                break;
                            case 6: // Tháng 7
                                date.setDate(31);
                                break;
                            case 7: // Tháng 8
                                date.setDate(31);
                                break;
                            case 8: // Tháng 9
                                date.setDate(30);
                                break;
                            case 9: // Tháng 10
                                date.setDate(31);
                                break;
                            case 10: // Tháng 11
                                date.setDate(30);
                                break;
                            case 11: // Tháng 12
                                date.setDate(31);
                                break;
                        }
                    };

                    // Đặt ngày cụ thể cho endTime
                    setSpecificDateForEndTime(endTime);

                    // Cập nhật thời gian mới
                    promo.startTime = startTime;
                    promo.endTime = endTime;

                    await promo.save();
                    console.log(`✅ Đã cập nhật thời gian cho chương trình khuyến mãi: ${promo.name}`);
                }
            } catch (error) {
                console.error(`❌ Lỗi khi cập nhật chương trình khuyến mãi: ${promo.name}`, error.message);
            }
        }
    } catch (error) {
        console.error(`❌ Lỗi khi cập nhật chương trình khuyến mãi hàng tháng: ${error.message}`);
    }
};
*/

exports.updateMonthlyPromotions = async () => {
    try {
        const now = new Date();

        // Lấy tất cả các chương trình khuyến mãi có repeatMonthly = true
        const promotions = await Promotion.find({ repeatMonthly: true });
        if (!promotions || promotions.length === 0) {
            console.log("Không có chương trình khuyến mãi nào cần cập nhật.");
            return;
        }

        // Helper: cộng thêm 1 tháng theo local time và clamp ngày nếu tháng mới không có ngày tương ứng
        // VN không có DST nên local time an toàn để giữ nguyên mốc giờ thực tế (00:00, 22:30, ...)
        const addOneMonthClampedLocal = (date) => {
            const y = date.getFullYear();
            const m = date.getMonth();
            const d = date.getDate();
            const hr = date.getHours();
            const mi = date.getMinutes();
            const sc = date.getSeconds();
            const ms = date.getMilliseconds();
            const daysInNextMonth = new Date(y, m + 2, 0).getDate();
            const targetDay = Math.min(d, daysInNextMonth);
            return new Date(y, m + 1, targetDay, hr, mi, sc, ms);
        };

        for (const promo of promotions) {
            try {
                if (promo.endTime < now) {
                    let startTime = new Date(promo.startTime);
                    let endTime = new Date(promo.endTime);

                    // Nếu job bị trễ nhiều tháng, lặp đến khi endTime vượt qua hiện tại
                    // do {
                        startTime = addOneMonthClampedLocal(startTime);
                        endTime = addOneMonthClampedLocal(endTime);
                    // } while (endTime < now);

                    // Gán lại thời gian mới
                    promo.startTime = startTime;
                    promo.endTime = endTime;

                    await promo.save();
                    console.log(promo.endTime, now);
                    console.log(`✅ Đã cập nhật thời gian cho chương trình khuyến mãi: ${promo.name}`);
                }
            } catch (error) {
                console.error(`❌ Lỗi khi cập nhật chương trình khuyến mãi: ${promo.name}`, error.message);
            }
        }
    } catch (error) {
        console.error(`❌ Lỗi khi cập nhật chương trình khuyến mãi hàng tháng: ${error.message}`);
    }
};