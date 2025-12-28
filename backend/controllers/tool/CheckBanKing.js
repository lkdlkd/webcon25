const axios = require('axios');
const cron = require('node-cron');
const Banking = require('../../models/Bankking');
const Transaction = require('../../models/TransactionBanking');
const User = require('../../models/User');
const Promotion = require('../../models/Promotion');
const HistoryUser = require('../../models/History');
const Telegram = require('../../models/Telegram');
const { emitDepositSuccess } = require('../../utils/socket');

// Biến chống chồng lệnh cron
let isRunning = false;

// Hàm tạo URL API tương ứng với loại ngân hàng
function getBankApiUrl(bank) {
    const { code, bank_password, account_number, token, url_api } = bank;

    if (!url_api) return null;

    switch (code) {
        case 'ACB':
            return `${url_api}/historyapiacbv3/${bank_password}/${account_number}/${token}`;
        case 'VCB':
            return `${url_api}/historyapivcbv3/${bank_password}/${account_number}/${token}`;
        case 'TCB':
            return `${url_api}/historyapitcbv3/${bank_password}/${account_number}/${token}`;
        case 'MB':
            return `${url_api}/historyapimbv3/${bank_password}/${account_number}/${token}`;
        case 'BIDV':
            return `${url_api}/historyapibidvv3/${bank_password}/${account_number}/${token}`;
        case 'ICB':
            return `${url_api}/historyapiviettinv3/${bank_password}/${account_number}/${token}`;
        case 'TPB':
            return `${url_api}/historyapitpbv3/${bank_password}/${account_number}/${token}`;
        case 'SEAB':
            return `${url_api}/historyapiseabankv3/${bank_password}/${account_number}/${token}`;
        default:
            return null;
    }
}

// Hàm trích xuất username từ mô tả kiểu "naptien username"
// function extractUsername(description) {
//     const match = description.match(/naptien\s+([a-zA-Z0-9_.]+)/i);
//     return match ? match[1] : null;
// }
const Configweb = require('../../models/Configweb');

// Hàm trích xuất username từ mô tả kiểu "cuphap username"
async function extractUsername(description) {
    try {
        // Lấy giá trị cuphap từ Configweb
        const config = await Configweb.findOne();
        const cuphap = config?.cuphap || "naptien"; // Sử dụng "naptien" làm giá trị mặc định nếu không có
        // console.log(`Cuphap: ${cuphap}`); // In ra giá trị cuphap để kiểm tra
        // console.log(`Mô tả: ${description}`); // In ra mô tả để kiểm tra

        // Tạo regex động dựa trên giá trị cuphap, chỉ lấy từ sau cuphap không chứa ký tự đặc biệt
        const regex = new RegExp(`${cuphap}\\s+([a-zA-Z0-9_]+)`, "i");
        const match = description.match(regex);
        // console.log(`Regex: ${regex}`); // In ra regex để kiểm tra
        // console.log(`Match: ${match}`); // In ra kết quả match để kiểm tra

        return match ? match[1] : null;
    } catch (error) {
        console.error("Lỗi khi lấy cuphap từ Configweb:", error.message);
        return null;
    }
}
// Hàm tính tiền thưởng khuyến mãi (nếu có)
async function calculateBonus(amount) {
    const now = new Date();
    const nowUtc = new Date(now.toISOString());

    // Lấy tất cả chương trình đang hoạt động và thỏa điều kiện amount
    const promos = await Promotion.find({
        startTime: { $lte: nowUtc },
        endTime: { $gte: nowUtc },
        minAmount: { $lte: amount }
    }).sort({ minAmount: -1 }); // Lấy minAmount cao nhất

    if (!promos || promos.length === 0) {
        console.log("⚠️ Không có chương trình khuyến mãi phù hợp");
        return { bonus: 0, promo: null };
    }

    const promo = promos[0]; // chọn chương trình tốt nhất

    const bonus = Math.floor((amount * promo.percentBonus) / 100);
    return { bonus, promo };
}


// Cron job mỗi 30 giây
cron.schedule('*/15 * * * * *', async () => {
    // Chống chồng lệnh cron
    if (isRunning) {
        console.log('⚠️ Cron đang chạy, bỏ qua lần này...');
        return;
    }
    isRunning = true;

    console.log('⏳ Đang chạy cron job...');

    try {
        const banks = await Banking.find({ status: true }); // Chỉ lấy các ngân hàng đang hoạt động

        for (const bank of banks) {
            const apiUrl = getBankApiUrl(bank);
            if (!apiUrl) {
                console.log(`❌ Không hỗ trợ ngân hàng: ${bank.bank_name}`);
                continue;
            }

            try {
                const res = await axios.get(apiUrl);
                let { transactions } = res.data;

                if (!transactions || transactions.length === 0) {
                    console.log(`⚠️ Không có giao dịch mới cho ngân hàng: ${bank.bank_name}`);
                    continue;
                }

                // Chỉ xử lý 20 giao dịch gần nhất
                transactions = transactions.slice(0, 20);

                for (const trans of transactions) {
                    // Xử lý mọi giao dịch, không chỉ IN
                    const exists = await Transaction.findOne({
                        transactionID: trans.transactionID,
                        typeBank: bank.bank_name,
                        accountNumber: bank.account_number
                    });
                    if (exists) {
                        console.log(`⚠️ Giao dịch đã tồn tại: ${trans.transactionID}`);
                        continue; // Bỏ qua nếu giao dịch đã được xử lý
                    }

                    const usernameRaw = await extractUsername(trans.description);
                    const username = usernameRaw ? usernameRaw.toLowerCase() : null;
                    let user = null;
                    let bonus = 0;
                    let totalAmount = 0;
                    let promo = null;
                    const amount = parseFloat(trans.amount); // Đảm bảo là Number

                    if (trans.type === 'IN' && username) {
                        user = await User.findOne({ username });
                        if (user) {
                            const bonusResult = await calculateBonus(amount);
                            bonus = bonusResult.bonus || 0;
                            promo = bonusResult.promo;
                            totalAmount = amount + bonus;
                            console.log(bonusResult);
                            console.log(`Giao dịch: ${trans.transactionID}, Amount: ${amount}, Bonus: ${bonus}, Total: ${totalAmount}`);
                        } else {
                            console.log(`⚠️ Không tìm thấy user: ${username}`);
                        }
                    } else if (trans.type !== 'IN') {
                        if (!username) {
                            console.log(`⚠️ Không tìm thấy username trong mô tả: ${trans.description}`);
                        }
                    }

                    // 2) Ghi nhận giao dịch với upsert theo bộ khóa duy nhất
                    const datetime = new Date().toISOString();
                    const transactionStatus = (trans.type === 'IN' && user) ? 'COMPLETED' : 'FAILED';
                    const filter = {
                        typeBank: bank.bank_name,
                        accountNumber: bank.account_number,
                        transactionID: trans.transactionID,
                    };
                    const noteText = (trans.type === 'IN' && user)
                        ? (bonus > 0
                            ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${amount} và áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                            : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${amount}`)
                        : `Hệ thống ${bank.bank_name} không thể cộng tiền vì không tìm thấy người dùng hoặc không phải giao dịch nạp tiền`;

                    const upsertResult = await Transaction.updateOne(
                        filter,
                        {
                            $setOnInsert: {
                                typeBank: bank.bank_name,
                                accountNumber: bank.account_number,
                                transactionID: trans.transactionID,
                                username: username || "unknown",
                                amount: amount,
                                description: trans.description,
                                transactionDate: trans.transactionDate,
                                type: trans.type,
                                status: transactionStatus,
                                note: noteText,
                            },
                        },
                        { upsert: true }
                    );

                    const inserted = (upsertResult.upsertedCount && upsertResult.upsertedCount > 0) || upsertResult.upsertedId;
                    if (!inserted) {
                        console.log(`⚠️ Giao dịch đã tồn tại: ${trans.transactionID}`);
                        continue; // Không cộng tiền/ gửi thông báo lại
                    }

                    // 3) Chỉ cộng tiền và tạo lịch sử khi vừa insert mới
                    if (user && trans.type === 'IN') {
                        // Cập nhật số dư bằng atomic operation để tránh race condition
                        const userUpdateResult = await User.findOneAndUpdate(
                            { username },
                            {
                                $inc: {
                                    balance: (totalAmount || amount),
                                    tongnap: (totalAmount || amount),
                                    tongnapthang: (totalAmount || amount)
                                }
                            },
                            { new: true }
                        );

                        if (!userUpdateResult) {
                            console.error(`⚠️ Không thể cập nhật số dư cho user: ${username}`);
                            continue;
                        }

                        const tiencu = userUpdateResult.balance - (totalAmount || amount);
                        const newBalance = userUpdateResult.balance;

                        try {
                            const cfg = await Configweb.findOne();
                            const vipThreshold = Number(cfg?.daily) || 0;
                            const distributorThreshold = Number(cfg?.distributor) || 0;
                            if (userUpdateResult.tongnap >= distributorThreshold) {
                                userUpdateResult.capbac = 'distributor';
                                await userUpdateResult.save();
                            } else if (userUpdateResult.tongnap >= vipThreshold) {
                                userUpdateResult.capbac = 'vip';
                                await userUpdateResult.save();
                            }
                        } catch (cfgErr) {
                            console.error('Không thể đọc Configweb để xét cấp bậc:', cfgErr.message);
                        }

                        const historyData = new HistoryUser({
                            username,
                            madon: "null",
                            hanhdong: "Cộng tiền",
                            link: "",
                            tienhientai: tiencu,
                            tongtien: (totalAmount || amount),
                            tienconlai: newBalance,
                            createdAt: new Date(),
                            mota: bonus > 0
                                ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ và áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                                : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ`,
                        });
                        await historyData.save();

                        // Emit Socket.IO event cho realtime notification
                        emitDepositSuccess(username, {
                            username,
                            newBalance,
                            message: bonus > 0
                                ? `Nạp tiền thành công ${Number(Math.floor(Number(amount))).toLocaleString("en-US")} VNĐ + ${Number(Math.floor(Number(bonus))).toLocaleString("en-US")} VNĐ khuyến mãi`
                                : `Nạp tiền thành công ${Number(Math.floor(Number(amount))).toLocaleString("en-US")} VNĐ`,
                            timestamp: new Date(),
                        });

                        // Thông báo Telegram
                        const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
                        const teleConfig = await Telegram.findOne();
                        if (teleConfig && teleConfig.botToken && teleConfig.chatidnaptien) {
                            const telegramMessage =
                                `📌 NẠP TIỀN THÀNH CÔNG!\n` +
                                `📌 Trans_id: ${trans.transactionID || "khong co"}\n` +
                                `👤 Khách hàng: ${username}\n` +
                                `💰 Số tiền nạp: ${Number(Math.floor(Number(amount))).toLocaleString("en-US")}\n` +
                                `🎁 Khuyến mãi: ${Number(Math.floor(Number(bonus))).toLocaleString("en-US")}\n` +
                                `📖 Nội dung: ${bonus > 0
                                    ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ và áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                                    : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ`}\n` +
                                `🔹 Tổng cộng: ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")}\n` +
                                `🔹 Số dư: ${Number(Math.floor(Number(newBalance))).toLocaleString("en-US")} VNĐ\n` +
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

                        // Gửi thông báo cho user
                        if (teleConfig && teleConfig.bot_notify && userUpdateResult.telegramChatId) {
                            const userMessage =
                                `🎉 Bạn vừa nạp tiền thành công!\n` +
                                `💰 Số tiền: ${Number(Math.floor(Number(amount))).toLocaleString("en-US")} VNĐ\n` +
                                (bonus > 0 ? `🎁 Khuyến mãi: +${Number(Math.floor(Number(bonus))).toLocaleString("en-US")} VNĐ\n` : '') +
                                `🔹 Tổng cộng: ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ\n` +
                                `💼 Số dư mới: ${Number(Math.floor(Number(newBalance))).toLocaleString("en-US")} VNĐ\n` +
                                `📖 Nội dung: ${bonus > 0
                                    ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ và áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                                    : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${Number(Math.floor(Number(totalAmount || amount))).toLocaleString("en-US")} VNĐ`}\n` +
                                `⏰ Thời gian: ${taoluc.toLocaleString("vi-VN", {
                                    day: "2-digit", month: "2-digit", year: "numeric",
                                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                                })}`;
                            try {
                                await axios.post(`https://api.telegram.org/bot${teleConfig.bot_notify}/sendMessage`, {
                                    chat_id: userUpdateResult.telegramChatId,
                                    text: userMessage,
                                });
                                console.log("Thông báo Telegram user đã được gửi.");
                            } catch (telegramError) {
                                console.error("Lỗi gửi thông báo Telegram user:", telegramError.message);
                            }
                        }
                        if (bonus > 0) {
                            console.log(`🎁 ${bank.bank_name.toUpperCase()}: +${amount} (+${bonus} KM) => ${username}`);
                        } else {
                            console.log(`✅ ${bank.bank_name.toUpperCase()}: +${amount} cho ${username}`);
                        }
                    } else {
                        console.log(`⚠️ Giao dịch được lưu nhưng không cộng tiền: ${trans.transactionID}`);
                    }
                }

            } catch (bankError) {
                console.error(`❌ Lỗi xử lý ${bank.bank_name}:`, bankError.message);
            }
        }

    } catch (error) {
        console.error('❌ Cron lỗi:', error.message);
    } finally {
        // Luôn reset flag khi hoàn thành
        isRunning = false;
    }
});
