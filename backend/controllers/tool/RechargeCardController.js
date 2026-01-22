const crypto = require("crypto");
const RechargeCard = require("../../models/RechangeCard");
const Transaction = require("../../models/History");
const User = require("../../models/User");
const axios = require("axios");
const FormData = require("form-data");
const cardModel = require("../../models/Card");
const ConfigCard = require("../../models/ConfigCard"); // Import mô hình ConfigCard
const Telegram = require('../../models/Telegram');
const Configweb = require('../../models/Configweb');
const { emitDepositSuccess } = require('../../utils/socket');

/**
 * Controller cập nhật trạng thái thẻ cào
 */
exports.rechargeCardStatus = async () => {
    try {
        console.log("🔄 Đang kiểm tra và cập nhật trạng thái thẻ cào...");

        // Lấy tất cả các thẻ cào có trạng thái 'pending'
        const pendingCards = await RechargeCard.find({ status: "pending" });
        if (!pendingCards.length) {
            console.log("Không có thẻ cào nào đang chờ xử lý.");
            return;
        }
        // Lấy cấu hình từ ConfigCard
        const configCard = await ConfigCard.findOne();
        if (!configCard) {
            console.error("Cấu hình thẻ nạp không tồn tại");
            return;
        }
        // Lấy cấu hình đối tác từ biến môi trường
        const partner_id = configCard.PARTNER_ID;
        const partner_key = configCard.PARTNER_KEY;
        const apiUrl = `${configCard.API_URLCARD}/chargingws/v2`;
        // console.log("Cấu hình đối tác:", {
        //     partner_id,
        //     partner_key,
        //     apiUrl
        // });
        for (const card of pendingCards) {
            try {
                // Kiểm tra nếu card không tồn tại hoặc thiếu thông tin cần thiết
                if (!card || !card.code || !card.serial) {
                    console.error(`Thẻ không hợp lệ hoặc thiếu thông tin: ${JSON.stringify(card)}`);
                    continue;
                }

                // Tạo chữ ký MD5: partner_key + card.code + card.serial
                const sign = crypto
                    .createHash("md5")
                    .update(partner_key + card.code + card.serial)
                    .digest("hex");
                const command = "check";
                // Tạo form-data để gửi đến API đối tác
                const formdata = new FormData();
                formdata.append("telco", card.type);
                formdata.append("code", card.code);
                formdata.append("serial", card.serial);
                formdata.append("amount", card.amount);
                formdata.append("request_id", card.request_id);
                formdata.append("partner_id", partner_id);
                formdata.append("sign", sign);
                formdata.append("command", command);
                // Gửi yêu cầu lên API đối tác
                const statusCard = await axios.post(apiUrl, formdata, {
                    headers: formdata.getHeaders(),
                    timeout: 15000,
                });
                console.log("Trạng thái trả về từ API đối tác:", statusCard.data);

                // Kiểm tra kết quả trả về từ API dựa trên status code
                const apiStatus = statusCard.data.status;
                const errorMessage = statusCard.data.message || "";

                if (typeof apiStatus !== "undefined") {
                    if (apiStatus === 1) {
                        // 1: Thẻ thành công đúng mệnh giá
                        const userData = await User.findOne({ username: card.username });
                        if (!userData) {
                            console.error(`Không tìm thấy người dùng: ${card.username}`);
                            continue;
                        }

                        // Lấy phí của thẻ theo telco và mệnh giá
                        const cardInfo = await cardModel.findOne({ telco: card.type, value: card.amount });
                        if (!cardInfo) {
                            console.error(`Không tìm thấy thông tin phí cho nhà mạng: ${card.type}, mệnh giá: ${card.amount}`);
                            continue;
                        }

                        const percent_card = Number(cardInfo.fees) || 0;
                        const chietkhau = card.amount - (card.amount * percent_card) / 100;

                        const note = `Hệ thống nạp thẻ nạp tiền tự động cho bạn số tiền ${chietkhau.toLocaleString("vi-VN")} của thẻ cào số seri ${card.serial}`;

                        // Cập nhật thẻ cào
                        card.real_amount = chietkhau;
                        card.status = "success";
                        await card.save();

                        // Cập nhật số dư bằng atomic operation để tránh race condition
                        const tiencu = userData.balance;
                        const updatedUser = await User.findOneAndUpdate(
                            { username: userData.username },
                            {
                                $inc: {
                                    balance: chietkhau,
                                    tongnap: chietkhau,
                                    tongnapthang: chietkhau
                                }
                            },
                            { new: true }
                        );

                        if (!updatedUser) {
                            console.error(`Không thể cập nhật số dư cho user: ${userData.username}`);
                            continue;
                        }

                        // Xếp hạng cấp bậc dựa trên tổng nạp và cấu hình
                        try {
                            const cfg = await Configweb.findOne();
                            const vipThreshold = Number(cfg?.daily) || 0;
                            const distributorThreshold = Number(cfg?.distributor) || 0;
                            if (updatedUser.tongnap >= distributorThreshold) {
                                updatedUser.capbac = 'distributor';
                                await updatedUser.save();
                            } else if (updatedUser.tongnap >= vipThreshold) {
                                updatedUser.capbac = 'vip';
                                await updatedUser.save();
                            }
                        } catch (cfgErr) {
                            console.error('Không thể đọc Configweb để xét cấp bậc:', cfgErr.message);
                        }

                        // Tạo giao dịch mới (HistoryUser)
                        await Transaction.create({
                            username: userData.username,
                            madon: " ",
                            hanhdong: "nạp tiền thẻ cào",
                            tongtien: chietkhau,
                            tienhientai: tiencu,
                            tienconlai: updatedUser.balance,
                            mota: note,
                        });
                        emitDepositSuccess(userData.username, {
                            username: userData.username,
                            newBalance: updatedUser.balance,
                            message: `Nạp tiền thành công ${Number(Math.floor(Number(chietkhau))).toLocaleString("en-US")} VNĐ từ thẻ cào`,
                            timestamp: new Date(),
                        });
                        // Gửi thông báo Telegram nếu có cấu hình
                        const teleConfig = await Telegram.findOne();
                        const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
                        if (teleConfig && (teleConfig.bot_notify || teleConfig.botToken)) {
                            const adminChatId = teleConfig.chatidnaptien;
                            const adminbottoken = teleConfig.botToken;
                            const userbotToken = teleConfig.bot_notify;
                            const telegramMessage =
                                `📌 *NẠP TIỀN THẺ CÀO!*\n` +
                                `👤 *Khách hàng:* ${card.username}\n` +
                                `👤 *Cộng tiền:* nạp thẻ thành công số tiền ${chietkhau}.\n` +
                                `🔹 *Số dư mới:* ${Number(Math.floor(Number(updatedUser.balance))).toLocaleString("en-US")} VNĐ\n` +
                                `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
                                    day: "2-digit",
                                    month: "2-digit",
                                    year: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                })}\n`;
                            try {
                                // Gửi admin/kênh
                                if (adminChatId) {
                                    await axios.post(`https://api.telegram.org/bot${adminbottoken}/sendMessage`, {
                                        chat_id: adminChatId,
                                        text: telegramMessage,
                                    });
                                }
                                // Gửi riêng cho user nếu đã liên kết Telegram
                                if (updatedUser.telegramChatId) {
                                    const userMessage =
                                        `🎉 Nạp thẻ thành công!\n` +
                                        `💳 Mệnh giá: ${card.amount.toLocaleString()}\n` +
                                        `✅ Cộng vào tài khoản: ${chietkhau.toLocaleString()}\n` +
                                        `💼 Số dư mới: ${Number(Math.floor(Number(updatedUser.balance))).toLocaleString("en-US")} VNĐ\n` +
                                        `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                                            day: "2-digit", month: "2-digit", year: "numeric",
                                            hour: "2-digit", minute: "2-digit", second: "2-digit",
                                        })}`;
                                    await axios.post(`https://api.telegram.org/bot${userbotToken}/sendMessage`, {
                                        chat_id: userData.telegramChatId,
                                        text: userMessage,
                                    });
                                }
                                console.log('Thông báo Telegram đã được gửi.');
                            } catch (telegramError) {
                                console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                            }
                        }
                    } else if (apiStatus === 2) {
                        // 2: Thẻ thành công sai mệnh giá
                        const userData = await User.findOne({ username: card.username });
                        if (!userData) {
                            console.error(`Không tìm thấy người dùng: ${card.username}`);
                            continue;
                        }

                        // Lấy phí của thẻ theo telco và mệnh giá thực tế từ API
                        const cardInfo = await cardModel.findOne({ telco: card.type, value: statusCard.data.value });
                        const percent_card = cardInfo ? Number(cardInfo.fees) : 0;

                        // Tính chiết khấu cho trường hợp sai mệnh giá
                        const chietkhau2 = (statusCard.data.value - (statusCard.data.value * percent_card / 100)) * 0.5;

                        const note = `Thẻ cào thành công nhưng sai mệnh giá. Chỉ nhận ${chietkhau2.toLocaleString("vi-VN")} VNĐ.`;

                        card.real_amount = chietkhau2;
                        card.status = "warning";
                        await card.save();

                        // Cập nhật số dư bằng atomic operation để tránh race condition
                        const tiencu = userData.balance;
                        const updatedUser = await User.findOneAndUpdate(
                            { username: userData.username },
                            {
                                $inc: {
                                    balance: chietkhau2,
                                    tongnap: chietkhau2,
                                    tongnapthang: chietkhau2
                                }
                            },
                            { new: true }
                        );

                        if (!updatedUser) {
                            console.error(`Không thể cập nhật số dư cho user: ${userData.username}`);
                            continue;
                        }

                        // Xếp hạng cấp bậc dựa trên tổng nạp và cấu hình
                        try {
                            const cfg = await Configweb.findOne();
                            const vipThreshold = Number(cfg?.daily) || 0;
                            const distributorThreshold = Number(cfg?.distributor) || 0;
                            if (updatedUser.tongnap >= distributorThreshold) {
                                updatedUser.capbac = 'distributor';
                                await updatedUser.save();
                            } else if (updatedUser.tongnap >= vipThreshold) {
                                updatedUser.capbac = 'vip';
                                await updatedUser.save();
                            }
                        } catch (cfgErr) {
                            console.error('Không thể đọc Configweb để xét cấp bậc:', cfgErr.message);
                        }

                        await Transaction.create({
                            username: userData.username,
                            madon: " ",
                            hanhdong: "nạp tiền thẻ cào - sai mệnh giá",
                            tongtien: chietkhau2,
                            tienhientai: tiencu,
                            tienconlai: updatedUser.balance,
                            mota: note,
                        });
                        emitDepositSuccess(userData.username, {
                            username: userData.username,
                            newBalance: updatedUser.balance,
                            message: `Nạp tiền thành công ${Number(Math.floor(Number(chietkhau2))).toLocaleString("en-US")} VNĐ từ thẻ cào (sai mệnh giá)`,
                            timestamp: new Date(),
                        });
                        // Gửi thông báo Telegram nếu có cấu hình
                        const teleConfig = await Telegram.findOne();
                        const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
                        if (teleConfig && (teleConfig.bot_notify || teleConfig.botToken)) {
                            const adminChatId = teleConfig.chatidnaptien;
                            const adminbottoken = teleConfig.botToken;
                            const userbotToken = teleConfig.bot_notify;
                            const telegramMessage =
                                `📌 *NẠP TIỀN THẺ CÀO!*\n` +
                                `👤 *Khách hàng:* ${card.username}\n` +
                                `👤 *Cộng tiền:*  nạp thẻ thành công số tiền  ${chietkhau2} và sai mệnh giá.\n` +
                                `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
                                    day: "2-digit",
                                    month: "2-digit",
                                    year: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                })}\n`;
                            try {
                                // Gửi admin/kênh
                                if (adminChatId) {
                                    await axios.post(`https://api.telegram.org/bot${adminbottoken}/sendMessage`, {
                                        chat_id: adminChatId,
                                        text: telegramMessage,
                                    });
                                }
                                // Gửi riêng cho user nếu đã liên kết Telegram
                                const userData = await User.findOne({ username: card.username });
                                if (userData?.telegramChatId) {
                                    const userMessage =
                                        `⚠️ Nạp thẻ sai mệnh giá\n` +
                                        `💳 Giá trị thẻ: ${statusCard.data.value.toLocaleString()}\n` +
                                        `✅ Cộng vào tài khoản: ${chietkhau2.toLocaleString()}\n` +
                                        `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                                            day: "2-digit", month: "2-digit", year: "numeric",
                                            hour: "2-digit", minute: "2-digit", second: "2-digit",
                                        })}`;
                                    await axios.post(`https://api.telegram.org/bot${userbotToken}/sendMessage`, {
                                        chat_id: userData.telegramChatId,
                                        text: userMessage,
                                    });
                                }
                                console.log('Thông báo Telegram đã được gửi.');
                            } catch (telegramError) {
                                console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                            }
                        }
                    } else if (apiStatus === 3 || apiStatus === 101) {
                        // 3: Thẻ lỗi
                        card.status = "failed";
                        card.real_amount = 0;
                        await card.save();
                    } else if (apiStatus === 4) {
                        // 4: Hệ thống bảo trì
                        card.status = "maintenance";
                        await card.save();
                    } else if (apiStatus === 99) {
                        // 99: Thẻ chờ xử lý - giữ nguyên trạng thái pending
                        console.log(`Thẻ ${card.code} đang chờ xử lý.`);
                    } else if (apiStatus === 100) {
                        // 100: Gửi thẻ thất bại - có lý do đi kèm
                        card.status = "failed";
                        card.real_amount = 0;
                        card.mota = `Gửi thẻ thất bại: ${errorMessage}`;
                        await card.save();
                    } else {
                        card.status = "failed";
                        card.real_amount = 0;
                        card.mota = `Gửi thẻ thất bại: ${errorMessage}`;
                        await card.save();
                    }
                }
            } catch (err) {
                console.error(`Lỗi xử lý thẻ ${card.code}:`, err.message);
            }
        }

        console.log("✅ Cập nhật trạng thái thẻ cào hoàn tất");
    } catch (error) {
        console.error("⚠ Lỗi cập nhật trạng thái thẻ cào:", error.message);
    }
};

/**
 * Controller xử lý callback từ API đối tác
 * Nhận POST JSON với chữ ký: md5(partner_key + code + serial)
 */
exports.handleCallback = async (req, res) => {
    try {
        console.log("📥 Nhận callback từ API đối tác:", req.body);

        const {
            status,
            message,
            request_id,
            declared_value,
            value,
            amount,
            code,
            serial,
            telco,
            trans_id,
            callback_sign
        } = req.body;

        // Kiểm tra các trường bắt buộc
        if (!request_id || !code || !serial || !callback_sign) {
            console.error("Callback thiếu thông tin bắt buộc");
            return res.status(400).json({
                success: false,
                message: "Thiếu thông tin bắt buộc"
            });
        }

        // Lấy cấu hình từ ConfigCard để xác thực chữ ký
        const configCard = await ConfigCard.findOne();
        if (!configCard) {
            console.error("Cấu hình thẻ nạp không tồn tại");
            return res.status(500).json({
                success: false,
                message: "Lỗi cấu hình hệ thống"
            });
        }

        const partner_key = configCard.PARTNER_KEY;

        // Xác thực chữ ký: md5(partner_key + code + serial)
        const expectedSign = crypto
            .createHash("md5")
            .update(partner_key + code + serial)
            .digest("hex");

        if (callback_sign !== expectedSign) {
            console.error("Chữ ký callback không hợp lệ");
            console.error("Expected:", expectedSign, "Received:", callback_sign);
            return res.status(403).json({
                success: false,
                message: "Chữ ký không hợp lệ"
            });
        }

        // Tìm thẻ cào theo request_id
        const card = await RechargeCard.findOne({ request_id: request_id });
        if (!card) {
            console.error(`Không tìm thấy thẻ với request_id: ${request_id}`);
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy giao dịch"
            });
        }

        // Kiểm tra nếu thẻ đã được xử lý
        if (card.status !== "pending") {
            console.log(`Thẻ ${request_id} đã được xử lý trước đó với trạng thái: ${card.status}`);
            return res.json({
                success: true,
                message: "Giao dịch đã được xử lý trước đó"
            });
        }

        // Xử lý theo status từ callback
        if (status === 1) {
            // 1: Thẻ thành công đúng mệnh giá
            const userData = await User.findOne({ username: card.username });
            if (!userData) {
                console.error(`Không tìm thấy người dùng: ${card.username}`);
                return res.status(404).json({
                    success: false,
                    message: "Không tìm thấy người dùng"
                });
            }

            // Lấy phí của thẻ theo telco và mệnh giá
            const cardInfo = await cardModel.findOne({ telco: telco || card.type, value: value || card.amount });
            if (!cardInfo) {
                console.error(`Không tìm thấy thông tin phí cho nhà mạng: ${telco}, mệnh giá: ${value}`);
                return res.status(404).json({
                    success: false,
                    message: "Không tìm thấy cấu hình phí"
                });
            }

            const percent_card = Number(cardInfo.fees) || 0;
            const chietkhau = value - (value * percent_card) / 100;

            const note = `Hệ thống nạp thẻ nạp tiền tự động cho bạn số tiền ${chietkhau.toLocaleString("vi-VN")} của thẻ cào số seri ${serial}`;

            // Cập nhật thẻ cào
            card.real_amount = chietkhau;
            card.status = "success";
            await card.save();

            // Cập nhật số dư bằng atomic operation để tránh race condition
            const tiencu = userData.balance;
            const updatedUser = await User.findOneAndUpdate(
                { username: userData.username },
                {
                    $inc: {
                        balance: chietkhau,
                        tongnap: chietkhau,
                        tongnapthang: chietkhau
                    }
                },
                { new: true }
            );

            if (!updatedUser) {
                console.error(`Không thể cập nhật số dư cho user: ${userData.username}`);
                return res.status(500).json({
                    success: false,
                    message: "Lỗi cập nhật số dư"
                });
            }

            // Xếp hạng cấp bậc dựa trên tổng nạp và cấu hình
            try {
                const cfg = await Configweb.findOne();
                const vipThreshold = Number(cfg?.daily) || 0;
                const distributorThreshold = Number(cfg?.distributor) || 0;
                if (updatedUser.tongnap >= distributorThreshold) {
                    updatedUser.capbac = 'distributor';
                    await updatedUser.save();
                } else if (updatedUser.tongnap >= vipThreshold) {
                    updatedUser.capbac = 'vip';
                    await updatedUser.save();
                }
            } catch (cfgErr) {
                console.error('Không thể đọc Configweb để xét cấp bậc:', cfgErr.message);
            }

            // Tạo giao dịch mới (HistoryUser)
            await Transaction.create({
                username: userData.username,
                madon: " ",
                hanhdong: "nạp tiền thẻ cào",
                tongtien: chietkhau,
                tienhientai: tiencu,
                tienconlai: updatedUser.balance,
                mota: note,
            });

            emitDepositSuccess(userData.username, {
                username: userData.username,
                newBalance: updatedUser.balance,
                message: `Nạp tiền thành công ${Number(Math.floor(Number(chietkhau))).toLocaleString("en-US")} VNĐ từ thẻ cào`,
                timestamp: new Date(),
            });

            // Gửi thông báo Telegram nếu có cấu hình
            const teleConfig = await Telegram.findOne();
            const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
            if (teleConfig && (teleConfig.bot_notify || teleConfig.botToken)) {
                const adminChatId = teleConfig.chatidnaptien;
                const adminbottoken = teleConfig.botToken;
                const userbotToken = teleConfig.bot_notify;
                const telegramMessage =
                    `📌 *NẠP TIỀN THẺ CÀO (CALLBACK)!*\n` +
                    `👤 *Khách hàng:* ${card.username}\n` +
                    `👤 *Cộng tiền:* nạp thẻ thành công số tiền ${chietkhau}.\n` +
                    `🔹 *Số dư mới:* ${Number(Math.floor(Number(updatedUser.balance))).toLocaleString("en-US")} VNĐ\n` +
                    `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                    })}\n`;
                try {
                    if (adminChatId) {
                        await axios.post(`https://api.telegram.org/bot${adminbottoken}/sendMessage`, {
                            chat_id: adminChatId,
                            text: telegramMessage,
                        });
                    }
                    if (updatedUser.telegramChatId) {
                        const userMessage =
                            `🎉 Nạp thẻ thành công!\n` +
                            `💳 Mệnh giá: ${value.toLocaleString()}\n` +
                            `✅ Cộng vào tài khoản: ${chietkhau.toLocaleString()}\n` +
                            `💼 Số dư mới: ${Number(Math.floor(Number(updatedUser.balance))).toLocaleString("en-US")} VNĐ\n` +
                            `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                                day: "2-digit", month: "2-digit", year: "numeric",
                                hour: "2-digit", minute: "2-digit", second: "2-digit",
                            })}`;
                        await axios.post(`https://api.telegram.org/bot${userbotToken}/sendMessage`, {
                            chat_id: updatedUser.telegramChatId,
                            text: userMessage,
                        });
                    }
                    console.log('Thông báo Telegram đã được gửi.');
                } catch (telegramError) {
                    console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                }
            }

            console.log(`✅ Callback xử lý thành công cho thẻ ${request_id}`);
            return res.json({ success: true, message: "Xử lý thành công" });

        } else if (status === 2) {
            // 2: Thẻ thành công sai mệnh giá
            const userData = await User.findOne({ username: card.username });
            if (!userData) {
                console.error(`Không tìm thấy người dùng: ${card.username}`);
                return res.status(404).json({
                    success: false,
                    message: "Không tìm thấy người dùng"
                });
            }

            const cardInfo = await cardModel.findOne({ telco: telco || card.type, value: value });
            const percent_card = cardInfo ? Number(cardInfo.fees) : 0;
            const chietkhau2 = (value - (value * percent_card / 100)) * 0.5;

            const note = `Thẻ cào thành công nhưng sai mệnh giá. Chỉ nhận ${chietkhau2.toLocaleString("vi-VN")} VNĐ.`;

            card.real_amount = chietkhau2;
            card.status = "warning";
            await card.save();

            const tiencu = userData.balance;
            const updatedUser = await User.findOneAndUpdate(
                { username: userData.username },
                {
                    $inc: {
                        balance: chietkhau2,
                        tongnap: chietkhau2,
                        tongnapthang: chietkhau2
                    }
                },
                { new: true }
            );

            if (!updatedUser) {
                console.error(`Không thể cập nhật số dư cho user: ${userData.username}`);
                return res.status(500).json({
                    success: false,
                    message: "Lỗi cập nhật số dư"
                });
            }

            try {
                const cfg = await Configweb.findOne();
                const vipThreshold = Number(cfg?.daily) || 0;
                const distributorThreshold = Number(cfg?.distributor) || 0;
                if (updatedUser.tongnap >= distributorThreshold) {
                    updatedUser.capbac = 'distributor';
                    await updatedUser.save();
                } else if (updatedUser.tongnap >= vipThreshold) {
                    updatedUser.capbac = 'vip';
                    await updatedUser.save();
                }
            } catch (cfgErr) {
                console.error('Không thể đọc Configweb để xét cấp bậc:', cfgErr.message);
            }

            await Transaction.create({
                username: userData.username,
                madon: " ",
                hanhdong: "nạp tiền thẻ cào - sai mệnh giá",
                tongtien: chietkhau2,
                tienhientai: tiencu,
                tienconlai: updatedUser.balance,
                mota: note,
            });

            emitDepositSuccess(userData.username, {
                username: userData.username,
                newBalance: updatedUser.balance,
                message: `Nạp tiền thành công ${Number(Math.floor(Number(chietkhau2))).toLocaleString("en-US")} VNĐ từ thẻ cào (sai mệnh giá)`,
                timestamp: new Date(),
            });

            // Gửi thông báo Telegram
            const teleConfig = await Telegram.findOne();
            const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
            if (teleConfig && (teleConfig.bot_notify || teleConfig.botToken)) {
                const adminChatId = teleConfig.chatidnaptien;
                const adminbottoken = teleConfig.botToken;
                const userbotToken = teleConfig.bot_notify;
                const telegramMessage =
                    `📌 *NẠP TIỀN THẺ CÀO (CALLBACK)!*\n` +
                    `👤 *Khách hàng:* ${card.username}\n` +
                    `👤 *Cộng tiền:* nạp thẻ thành công số tiền ${chietkhau2} và sai mệnh giá.\n` +
                    `🔹 *Tạo lúc:* ${taoluc.toLocaleString("vi-VN", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                    })}\n`;
                try {
                    if (adminChatId) {
                        await axios.post(`https://api.telegram.org/bot${adminbottoken}/sendMessage`, {
                            chat_id: adminChatId,
                            text: telegramMessage,
                        });
                    }
                    if (updatedUser.telegramChatId) {
                        const userMessage =
                            `⚠️ Nạp thẻ sai mệnh giá\n` +
                            `💳 Giá trị thẻ: ${value.toLocaleString()}\n` +
                            `✅ Cộng vào tài khoản: ${chietkhau2.toLocaleString()}\n` +
                            `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                                day: "2-digit", month: "2-digit", year: "numeric",
                                hour: "2-digit", minute: "2-digit", second: "2-digit",
                            })}`;
                        await axios.post(`https://api.telegram.org/bot${userbotToken}/sendMessage`, {
                            chat_id: updatedUser.telegramChatId,
                            text: userMessage,
                        });
                    }
                    console.log('Thông báo Telegram đã được gửi.');
                } catch (telegramError) {
                    console.error('Lỗi gửi thông báo Telegram:', telegramError.message);
                }
            }

            console.log(`✅ Callback xử lý thành công (sai mệnh giá) cho thẻ ${request_id}`);
            return res.json({ success: true, message: "Xử lý thành công - sai mệnh giá" });

        } else if (status === 3 || status === 101) {
            // 3: Thẻ lỗi
            card.status = "failed";
            card.real_amount = 0;
            card.mota = message || "Thẻ lỗi";
            await card.save();

            console.log(`❌ Callback: Thẻ ${request_id} thất bại`);
            return res.json({ success: true, message: "Đã cập nhật trạng thái thất bại" });

        } else if (status === 4) {
            // 4: Hệ thống bảo trì
            card.status = "maintenance";
            await card.save();

            console.log(`🔧 Callback: Thẻ ${request_id} - hệ thống bảo trì`);
            return res.json({ success: true, message: "Đã cập nhật trạng thái bảo trì" });

        } else if (status === 99) {
            // 99: Thẻ chờ xử lý - giữ nguyên trạng thái pending
            console.log(`⏳ Callback: Thẻ ${request_id} đang chờ xử lý`);
            return res.json({ success: true, message: "Thẻ đang chờ xử lý" });

        } else if (status === 100) {
            // 100: Gửi thẻ thất bại
            card.status = "failed";
            card.real_amount = 0;
            card.mota = `Gửi thẻ thất bại: ${message}`;
            await card.save();

            console.log(`❌ Callback: Thẻ ${request_id} gửi thất bại - ${message}`);
            return res.json({ success: true, message: "Đã cập nhật trạng thái gửi thất bại" });

        } else {
            // Các status khác
            card.status = "failed";
            card.real_amount = 0;
            card.mota = `Trạng thái không xác định: ${status} - ${message}`;
            await card.save();

            console.log(`❓ Callback: Thẻ ${request_id} trạng thái không xác định: ${status}`);
            return res.json({ success: true, message: "Đã cập nhật trạng thái" });
        }

    } catch (error) {
        console.error("⚠ Lỗi xử lý callback:", error.message);
        return res.status(500).json({
            success: false,
            message: "Lỗi hệ thống"
        });
    }
};

// // Cron job: kiểm tra trạng thái thẻ cào mỗi 30 giây
// setInterval(async () => {
//     console.log("⏳ Chạy cron job kiểm tra thẻ cào...");
//     try {
//         await exports.rechargeCardStatus();
//     } catch (error) {
//         console.error("Lỗi khi chạy rechargeCardStatus:", error);
//     }
// }, 30000); // 30,000 milliseconds = 30 seconds
