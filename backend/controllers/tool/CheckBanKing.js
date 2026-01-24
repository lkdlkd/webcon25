const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const Banking = require('../../models/Bankking');
const Transaction = require('../../models/TransactionBanking');
const User = require('../../models/User');
const Promotion = require('../../models/Promotion');
const HistoryUser = require('../../models/History');
const Telegram = require('../../models/Telegram');
const Configweb = require('../../models/Configweb');
const { emitDepositSuccess } = require('../../utils/socket');

// Biến chống chồng lệnh cron
let isRunning = false;

// ============ CACHE SYSTEM ============
let cache = {
    configweb: null,
    telegram: null,
    promotions: [],
    lastUpdate: 0
};
const CACHE_TTL = 30 * 1000; // 30 seconds

async function refreshCache() {
    const now = Date.now();

    if (cache.lastUpdate > 0 && (now - cache.lastUpdate) < CACHE_TTL) {
        return cache;
    }
    try {
        const nowUtc = new Date();
        const [configweb, telegram, promotions] = await Promise.all([
            Configweb.findOne(),
            Telegram.findOne(),
            Promotion.find({
                startTime: { $lte: nowUtc },
                endTime: { $gte: nowUtc }
            }).sort({ minAmount: -1 })
        ]);

        cache = {
            configweb: configweb || null,
            telegram: telegram || null,
            promotions: promotions || [],
            lastUpdate: now
        };
        console.log(`🔄 Cache refreshed: ${(promotions || []).length} promotions`);
        return cache;
    } catch (error) {
        console.error('❌ Lỗi refresh cache:', error.message);
        // Trả về cache cũ nếu có, hoặc default values
        if (cache.lastUpdate > 0) {
            return cache;
        }
        return { configweb: null, telegram: null, promotions: [], lastUpdate: 0 };
    }
}

// Helper: Tạo mã nạp tiền mới (6 ký tự) - chỉ generate, caller xử lý duplicate
function generateNewDepositCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const codeLength = 6;
    let code = '';
    for (let i = 0; i < codeLength; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
}

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

// Hàm trích xuất mã nạp tiền - chỉ tìm chuỗi 6 ký tự, không query DB
function extractDepositCode(description, cuphap) {
    try {
        if (cuphap && cuphap.trim() !== "") {
            // Nếu có cuphap, tìm theo pattern "cuphap DEPOSITCODE"
            // Hỗ trợ trường hợp deposit code bị space (VD: "donate 2S2 RLX" -> "2S2RLX")
            // Match đúng 6 ký tự alphanumeric (có thể có space giữa chúng)
            // (?:[A-Z0-9]\s*){6} = 6 lần: [chữ/số] + [0 hoặc nhiều space]
            // (?:[^A-Z0-9]|$) = kết thúc bằng ký tự KHÔNG phải alphanumeric hoặc end (cho phép -, ., etc)
            const regex = new RegExp(`${cuphap}\\s+((?:[A-Z0-9]\\s*){6})(?:[^A-Z0-9]|$)`, "i");
            const match = description.match(regex);
            if (match) {
                // Loại bỏ tất cả space
                const code = match[1].replace(/\s+/g, '').toUpperCase();
                // Đảm bảo đúng 6 ký tự
                if (code.length === 6) {
                    return code;
                }
            }
            return null;
        } else {
            // Xử lý trường hợp CUSTOMER dính liền mã (VD: CUSTOMER39JX5D -> 39JX5D)
            let processedDesc = description;
            const customerMatch = description.match(/CUSTOMER([A-Z0-9]{6})/i);
            if (customerMatch) {
                // Thêm space để tách CUSTOMER ra
                processedDesc = description.replace(/CUSTOMER([A-Z0-9]{6})/gi, 'CUSTOMER $1');
            }

            // Tìm chuỗi 6 ký tự với word boundary
            // \b đảm bảo không match vào giữa chuỗi dài như mã giao dịch, checksum
            const regex = /\b[A-Z0-9]{6}\b/gi;
            const matches = processedDesc.match(regex);

            if (!matches || matches.length === 0) {
                return null;
            }

            // Trả về tất cả các mã tìm thấy để kiểm tra sau
            return matches.map(m => m.toUpperCase());
        }
    } catch (error) {
        console.error("Lỗi extractDepositCode:", error.message);
        return null;
    }
}

// Hàm tính tiền thưởng khuyến mãi - KHÔNG QUERY DB
function calculateBonus(amount, promotions) {
    if (!promotions || promotions.length === 0) {
        return { bonus: 0, promo: null };
    }

    // Tìm promo phù hợp nhất (minAmount cao nhất mà <= amount)
    const promo = promotions.find(p => p.minAmount <= amount);

    if (!promo) {
        console.log("⚠️ Không có chương trình khuyến mãi phù hợp");
        return { bonus: 0, promo: null };
    }

    const bonus = Math.floor((amount * promo.percentBonus) / 100);
    return { bonus, promo };
}

// Helper: Format tiền
function formatMoney(amount) {
    return Number(Math.floor(Number(amount))).toLocaleString("en-US");
}

// ============ AFFILIATE COMMISSION ============
const AffiliateCommission = require('../../models/AffiliateCommission');

// Hàm xử lý hoa hồng affiliate - CHỈ CẤP 1, CHỜ ADMIN DUYỆT
async function processAffiliateCommission(user, amount, configweb, teleConfig, depositCode) {
    try {
        // Kiểm tra affiliate có bật không
        if (!configweb || !configweb.affiliateEnabled) {
            console.log('⚠️ Affiliate chưa được bật');
            return;
        }

        // Kiểm tra mức nạp tối thiểu
        const minDeposit = configweb.affiliateMinDeposit || 50000;
        if (amount < minDeposit) {
            console.log(`⚠️ Số tiền nạp ${amount} < ${minDeposit}, không tính hoa hồng affiliate`);
            return;
        }

        // Kiểm tra user có người giới thiệu không
        if (!user.referredBy) {
            console.log('⚠️ User không có người giới thiệu');
            return;
        }

        // Lấy % hoa hồng từ cấu hình (mặc định 5%)
        const commissionPercent = configweb.affiliateCommissionPercent || 5;

        // Tìm người giới thiệu trực tiếp (cấp 1)
        const referrer = await User.findById(user.referredBy);
        if (!referrer) {
            console.log(`⚠️ Không tìm thấy referrer ID: ${user.referredBy}`);
            return;
        }

        // Tính hoa hồng
        const commission = Math.floor((amount * commissionPercent) / 100);
        if (commission <= 0) {
            console.log('⚠️ Hoa hồng = 0, bỏ qua');
            return;
        }

        // Tạo pending commission (chờ admin duyệt)
        const pendingCommission = new AffiliateCommission({
            referrer: referrer._id,
            referrerUsername: referrer.username,
            depositor: user._id,
            depositorUsername: user.username,
            depositAmount: amount,
            commissionPercent: commissionPercent,
            commissionAmount: commission,
            status: 'pending',
            depositCode: depositCode || ''
        });
        await pendingCommission.save();

        console.log(`✅ Tạo pending commission: ${referrer.username} nhận ${formatMoney(commission)} VNĐ (${commissionPercent}%) từ ${user.username} - CHỜ DUYỆT`);

        // Gửi thông báo Telegram cho referrer về hoa hồng chờ duyệt
        if (teleConfig && teleConfig.bot_notify && referrer.telegramChatId) {
            const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000);
            const affiliateMessage =
                `⏳ *Hoa hồng Affiliate - Chờ duyệt*\n` +
                `👤 *Từ:* ${user.username}\n` +
                `💰 *Số tiền nạp:* ${formatMoney(amount)} VNĐ\n` +
                `🎁 *Hoa hồng:* ${formatMoney(commission)} VNĐ (${commissionPercent}%)\n` +
                `📝 *Trạng thái:* Chờ Admin duyệt\n` +
                `⏰ *Thời gian:* ${taoluc.toLocaleString("vi-VN", {
                    day: "2-digit", month: "2-digit", year: "numeric",
                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                })}`;
            try {
                await axios.post(`https://api.telegram.org/bot${teleConfig.bot_notify}/sendMessage`, {
                    chat_id: referrer.telegramChatId,
                    text: affiliateMessage,
                    parse_mode: 'Markdown'
                });
                console.log(`📱 Đã gửi thông báo pending affiliate cho ${referrer.username}`);
            } catch (teleErr) {
                console.error('Lỗi gửi thông báo Telegram affiliate:', teleErr.message);
            }
        }

        console.log(`✅ Hoàn thành xử lý hoa hồng affiliate (chờ duyệt)`);
    } catch (error) {
        console.error('❌ Lỗi xử lý hoa hồng affiliate:', error.message);
    }
}

// Cron job mỗi 15 giây
cron.schedule('*/15 * * * * *', async () => {
    // Chống chồng lệnh cron
    if (isRunning) {
        console.log('⚠️ Cron đang chạy, bỏ qua lần này...');
        return;
    }
    isRunning = true;

    console.log('⏳ Đang chạy cron job...');

    try {
        // Refresh cache trước khi xử lý
        const { configweb, telegram: teleConfig, promotions } = await refreshCache();
        const cuphap = configweb?.cuphap || "";
        const vipThreshold = Number(configweb?.daily) || 0;
        const distributorThreshold = Number(configweb?.distributor) || 0;

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

                // BATCH: Lấy tất cả transactionID đã tồn tại trong 1 query
                const transactionIDs = transactions.map(t => t.transactionID);
                const existingTransactions = await Transaction.find({
                    transactionID: { $in: transactionIDs },
                    typeBank: bank.bank_name,
                    accountNumber: bank.account_number
                }, { transactionID: 1 });
                const existingSet = new Set(existingTransactions.map(t => t.transactionID));

                for (const trans of transactions) {
                    // Kiểm tra trong Set (O(1)) thay vì query DB
                    if (existingSet.has(trans.transactionID)) {
                        console.log(`⚠️ Giao dịch đã tồn tại: ${trans.transactionID}`);
                        continue; // Bỏ qua nếu giao dịch đã được xử lý
                    }

                    // Trích xuất depositCode từ description
                    const extractResult = extractDepositCode(trans.description, cuphap);
                    let depositCode = null;
                    let user = null;
                    let username = null;
                    let bonus = 0;
                    let totalAmount = 0;
                    let promo = null;
                    const amount = parseFloat(trans.amount); // Đảm bảo là Number

                    if (trans.type === 'IN' && extractResult) {
                        // extractResult có thể là string (khi có cuphap) hoặc array (khi không có cuphap)
                        const potentialCodes = Array.isArray(extractResult) ? extractResult : [extractResult];

                        // Tìm user với depositCode hợp lệ
                        for (const code of potentialCodes) {
                            const foundUser = await User.findOne({ depositCode: code });
                            if (foundUser) {
                                depositCode = code;
                                user = foundUser;
                                username = foundUser.username;
                                console.log(`✅ Tìm thấy mã nạp tiền hợp lệ: ${code}`);
                                break;
                            }
                        }

                        if (user) {
                            // Sử dụng helper với cached promotions (không query DB)
                            const bonusResult = calculateBonus(amount, promotions);
                            bonus = bonusResult.bonus || 0;
                            promo = bonusResult.promo;
                            totalAmount = amount + bonus;
                            console.log(bonusResult);
                            console.log(`Giao dịch: ${trans.transactionID}, DepositCode: ${depositCode}, User: ${username}, Amount: ${amount}, Bonus: ${bonus}, Total: ${totalAmount}`);
                        } else {
                            console.log(`⚠️ Không tìm thấy user với các mã: ${potentialCodes.join(', ')}`);
                        }
                    } else if (trans.type !== 'IN') {
                        if (!extractResult) {
                            console.log(`⚠️ Không tìm thấy mã nạp tiền trong mô tả: ${trans.description}`);
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
                                code: depositCode,
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
                        // ATOMIC: Cập nhật số dư bằng depositCode cũ để tránh race condition
                        const oldDepositCode = user.depositCode;
                        let newDepositCode;
                        let userUpdateResult = null;
                        const maxRetries = 10;

                        // Retry loop - chỉ retry khi duplicate key error
                        for (let retry = 0; retry < maxRetries; retry++) {
                            try {
                                newDepositCode = generateNewDepositCode();

                                // ATOMIC UPDATE by depositCode
                                userUpdateResult = await User.findOneAndUpdate(
                                    { depositCode: oldDepositCode },
                                    {
                                        $inc: {
                                            balance: (totalAmount || amount),
                                            tongnap: (amount),
                                            tongnapthang: (amount)
                                        },
                                        $set: {
                                            depositCode: newDepositCode
                                        }
                                    },
                                    { new: true }
                                );
                                break; // Thành công, thoát loop
                            } catch (updateErr) {
                                if (updateErr.code === 11000) {
                                    // Duplicate key - retry với mã mới
                                    console.log(`⚠️ Mã ${newDepositCode} đã tồn tại, retry ${retry + 1}/${maxRetries}...`);
                                    continue;
                                }
                                throw updateErr; // Lỗi khác, throw ra ngoài
                            }
                        }

                        // Fallback: dùng timestamp nếu tất cả retry đều trùng
                        if (!userUpdateResult) {
                            try {
                                const timestamp = Date.now().toString(36).toUpperCase();
                                const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 6 - timestamp.length);
                                newDepositCode = (timestamp + randomPart).substring(0, 6);

                                userUpdateResult = await User.findOneAndUpdate(
                                    { depositCode: oldDepositCode },
                                    {
                                        $inc: {
                                            balance: (totalAmount || amount),
                                            tongnap: (amount),
                                            tongnapthang: (amount)
                                        },
                                        $set: { depositCode: newDepositCode }
                                    },
                                    { new: true }
                                );
                                console.log(`✅ Fallback timestamp code: ${newDepositCode}`);
                            } catch (fallbackErr) {
                                console.error(`❌ Fallback cũng thất bại cho ${username}:`, fallbackErr.message);
                            }
                        }

                        if (!userUpdateResult) {
                            console.error(`⚠️ Không thể cập nhật số dư cho user: ${username} (depositCode không khớp hoặc đã thay đổi)`);
                            continue;
                        }

                        console.log(`🔄 Đã tạo mã nạp tiền mới cho ${username}: ${newDepositCode}`);


                        const tiencu = userUpdateResult.balance - (totalAmount || amount);
                        const newBalance = userUpdateResult.balance;

                        // Xét cấp bậc - dùng cached config (không query DB)
                        if (userUpdateResult.tongnap >= distributorThreshold) {
                            if (userUpdateResult.capbac !== 'distributor') {
                                userUpdateResult.capbac = 'distributor';
                                await userUpdateResult.save();
                            }
                        } else if (userUpdateResult.tongnap >= vipThreshold) {
                            if (userUpdateResult.capbac !== 'vip') {
                                userUpdateResult.capbac = 'vip';
                                await userUpdateResult.save();
                            }
                        }

                        const historyData = new HistoryUser({
                            username,
                            madon: oldDepositCode,
                            hanhdong: "Cộng tiền",
                            link: "",
                            tienhientai: tiencu,
                            tongtien: (totalAmount || amount),
                            tienconlai: newBalance,
                            createdAt: new Date(),
                            mota: bonus > 0
                                ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${formatMoney(totalAmount || amount)} VNĐ mã giao dịch ${oldDepositCode} và áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                                : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${formatMoney(totalAmount || amount)} VNĐ mã giao dịch ${oldDepositCode}`,
                        });
                        await historyData.save();

                        // Emit Socket.IO event cho realtime notification
                        emitDepositSuccess(username, {
                            newDepositCode,
                            username,
                            newBalance,
                            message: bonus > 0
                                ? `Nạp tiền thành công ${formatMoney(amount)} VNĐ mã giao dịch ${oldDepositCode} + ${formatMoney(bonus)} VNĐ khuyến mãi`
                                : `Nạp tiền thành công ${formatMoney(amount)} VNĐ mã giao dịch ${oldDepositCode}`,
                            timestamp: new Date(),
                        });

                        // Thông báo Telegram - dùng cached teleConfig (không query DB)
                        const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000); // Giờ Việt Nam (UTC+7)
                        if (teleConfig && teleConfig.botToken && teleConfig.chatidnaptien) {
                            const telegramMessage =
                                `📌 NẠP TIỀN THÀNH CÔNG!\n` +
                                `📌 Trans_id: ${trans.transactionID || "khong co"}\n` +
                                `👤 Khách hàng: ${username}\n` +
                                `💰 Số tiền nạp: ${formatMoney(amount)}\n` +
                                `🎁 Khuyến mãi: ${formatMoney(bonus)}\n` +
                                `📖 Nội dung: ${bonus > 0
                                    ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${formatMoney(totalAmount || amount)} VNĐ và mã giao dịch ${oldDepositCode} áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                                    : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${formatMoney(totalAmount || amount)} VNĐ và mã giao dịch ${oldDepositCode}`}\n` +
                                `🔹 Tổng cộng: ${formatMoney(totalAmount || amount)}\n` +
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

                        // Gửi thông báo cho user - dùng cached teleConfig (không query DB)
                        if (teleConfig && teleConfig.bot_notify && userUpdateResult.telegramChatId) {
                            const userMessage =
                                `🎉 Bạn vừa nạp tiền thành công!\n` +
                                `💰 Số tiền: ${formatMoney(amount)} VNĐ\n` +
                                (bonus > 0 ? `🎁 Khuyến mãi: +${formatMoney(bonus)} VNĐ\n` : '') +
                                `🔹 Tổng cộng: ${formatMoney(totalAmount || amount)} VNĐ\n` +
                                `💼 Số dư mới: ${formatMoney(newBalance)} VNĐ\n` +
                                `📖 Nội dung: ${bonus > 0
                                    ? `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${formatMoney(totalAmount || amount)} VNĐ mã giao dịch ${oldDepositCode} và áp dụng khuyến mãi ${promo?.percentBonus || 0}%`
                                    : `Hệ thống ${bank.bank_name} tự động cộng thành công số tiền ${formatMoney(totalAmount || amount)} VNĐ mã giao dịch ${oldDepositCode}`}\n` +
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
                        // Xử lý hoa hồng affiliate đa cấp
                        await processAffiliateCommission(user, amount, configweb, teleConfig, oldDepositCode);

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
        console.log(`✅ Cron hoàn thành`);
        isRunning = false;
    } catch (error) {
        console.error('❌ Cron lỗi:', error.message);
    } finally {
        // Luôn reset flag khi hoàn thành
        isRunning = false;
    }
});
