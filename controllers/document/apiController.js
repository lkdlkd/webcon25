const axios = require('axios');
const jwt = require('jsonwebtoken');
const Service = require('../../models/server');
const Order = require('../../models/Order');
const HistoryUser = require('../../models/History');
const User = require('../../models/User');
const SmmSv = require("../../models/SmmSv");
const SmmApiService = require('../Smm/smmServices'); // Giả sử bạn có một lớp để xử lý API SMM
const Telegram = require('../../models/Telegram');

// Helper: lấy đơn giá theo cấp bậc user
function getEffectiveRate(service, user) {
    try {
        const base = Number(service?.rate || 0);
        const vip = Number(service?.ratevip || 0);
        const distributor = Number(service?.rateDistributor || 0);
        const level = (user?.capbac || 'member').toLowerCase();
        if (level === 'vip' && vip > 0) return vip;
        if (level === 'distributor' && distributor > 0) return distributor;
        return base;
    } catch (_) {
        return Number(service?.rate || 0);
    }
}

/* Hàm lấy danh sách dịch vụ */
exports.getServices = async (req, res) => {
    try {
        const { key } = req.body;
        // Kiểm tra xem token có được gửi không
        // Kiểm tra xem token có được gửi không
        if (!key) {
            return res.status(400).json({ success: false, error: "Token không được bỏ trống" });
        }
        // Lấy user từ DB dựa trên userId từ decoded token
        const user = await User.findOne({ apiKey: key });
        if (!user) {
            res.status(404).json({ error: 'Người dùng không tồn tại' });
            return null;
        }

        // So sánh token trong header với token đã lưu của user
        if (user.apiKey !== key) {
            res.status(401).json({ error: 'api Key không hợp lệ1' });
            return null;
        }
        // Kiểm tra trạng thái người dùng trong CSDL (ví dụ: 'active')
        if (!user) {
            return res.status(404).json({ success: false, error: "Không tìm thấy người dùng" });
        }
        if (user.status && user.status !== 'active') {
            return res.status(403).json({ success: false, error: "Người dùng không hoạt động" });
        }
        // Lấy danh sách dịch vụ từ CSDL
        const services = await Service.find({ isActive: true })
            .populate("category", "name")
            .populate("type", "name"); // Lấy thông tin của Platform
        // Định dạng các trường cần hiển thị với giá theo cấp bậc
        const formattedServices = services.map(service => {
            const rateForUser = getEffectiveRate(service, user);
            return {
                service: Number(service.Magoi),
                name: `${service.maychu} ${service.name}`,
                type: service.comment === "on" ? "Custom Comments" : "Default",
                platform: service.type?.name || "không xác định",
                category: `${service.type?.name || "Không xác định"} | ${service.category?.name || "Không xác định"}`,
                rate: rateForUser / 25,
                min: service.min,
                max: service.max,
                cancel: service.cancel === "on",
                refill: service.refil === "on",
            };
        });

        return res.status(200).json(formattedServices);
    } catch (error) {
        console.error("Lỗi khi lấy danh sách dịch vụ:", error);
        return res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách dịch vụ',
            error: error.message
        });
    }
};
async function fetchSmmConfig(domain) {
    const smmSvConfig = await SmmSv.findById(domain);
    if (!smmSvConfig || !smmSvConfig.url_api || !smmSvConfig.api_token) {
        throw new Error('Lỗi khi mua dịch vụ, vui lòng ib admin');
    }
    return smmSvConfig;
}

async function fetchServiceData(magoi) {
    const serviceFromDb = await Service.findOne({ Magoi: magoi }).populate("category", "name").populate("DomainSmm", "name").populate("type", "name");
    if (!serviceFromDb) throw new Error('Dịch vụ không tồn tại');
    return serviceFromDb;
}
exports.AddOrder = async (req, res) => {
    // Lấy token từ req.body
    const { key, service, link, quantity, comments } = req.body;
    const magoi = service;

    if (!key) {
        return res.status(400).json({ error: "Token không được bỏ trống" });
    }
    const user = await User.findOne({ apiKey: key });
    if (!user) {
        res.status(404).json({ error: 'Người dùng không tồn tại' });
        return null;
    }
    if (user.apiKey !== key) {
        res.status(401).json({ error: 'api Key không hợp lệ' });
        return null;
    }
    if (user.status && user.status !== 'active') {
        return res.status(403).json({ success: false, error: "Người dùng không hoạt động" });
    }
    if (!magoi || !link || !quantity) {
        return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (service, link, quantity)' });
    }
    const username = user.username
    const qty = Number(quantity);
    const formattedComments = comments ? comments.replace(/\r?\n/g, "\r\n") : "";

    try {
        // --- Bước 1: Lấy thông tin dịch vụ từ CSDL ---
        const serviceFromDb = await fetchServiceData(magoi);
        const smmSvConfig = await fetchSmmConfig(serviceFromDb.DomainSmm);

        const smm = new SmmApiService(smmSvConfig.url_api, smmSvConfig.api_token);
        // const allServices = await smm.services();

        // const serviceFromApi = allServices.find(
        //     s => s.service === Number(serviceFromDb.serviceId) || s.service === serviceFromDb.serviceId
        // );
        // if (!serviceFromApi) throw new Error('lỗi khi mua dịch vụ, vui lòng ib admin11');


        // Tính tổng chi phí và làm tròn 2 số thập phân
        const rateForUser = getEffectiveRate(serviceFromDb, user);
        const totalCost = rateForUser * qty; // Kết quả: 123.4
        const apiRate = serviceFromDb.originalRate; // Giá gốc từ nguồn
        // Chỉ kiểm tra giá nếu ischeck = true
        if (serviceFromDb.ischeck !== true && apiRate > rateForUser) {
            throw new Error('Lỗi khi mua dịch vụ, vui lòng ib admin');
        }

        if (!serviceFromDb.isActive) {
            throw new Error("Dịch vụ bảo trì, vui lòng mua sv khác");
            // return res.status(400).json({ error: "Dịch vụ bảo trì, vui lòng mua sv khác" });
        }
        if (qty < serviceFromDb.min || qty > serviceFromDb.max) {
            throw new Error('Số lượng không hợp lệ');
        }
        if (user.balance < totalCost) {
            throw new Error('Số dư không đủ để thực hiện giao dịch');
        }
        if (serviceFromDb.isActive === false) {
            throw new Error('Dịch vụ bảo trì, vui lòng liên hệ admin');
        }
        const lai = totalCost - (apiRate * qty);
        const tientieu = apiRate * qty;

        // --- Bước 4: Gửi yêu cầu mua dịch vụ qua API bên thứ 3 ---
        const purchasePayload = {
            link,
            quantity: qty,
            service: serviceFromDb.serviceId,
            comments: formattedComments,
        };

        const purchaseResponse = await smm.order(purchasePayload);
        if (!purchaseResponse || !purchaseResponse.order) {
            // Một số nguồn trả về lỗi theo nhiều dạng khác nhau
            // const status = purchaseResponse?.status;
            const nestedError = purchaseResponse?.data?.error || purchaseResponse?.error || purchaseResponse?.error?.message;

            // if (status === 500) {
            //     throw new Error("Lỗi khi mua dịch vụ, vui lòng thử lại");
            // }
            if (nestedError) {
                console.error('Đối tác trả về lỗi', nestedError);
                const errRaw = String(nestedError);
                const errStr = errRaw.toLowerCase();
                // Nhạy cảm: số dư, đường link, số điện thoại VN
                const urlRegex = /(https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.(com|net|org|io|vn|co)\b/i;
                const phoneRegexVN = /\b(\+?84|0)(3|5|7|8|9)\d{8}\b/;
                const isSensitive = errStr.includes('số dư') || errStr.includes('balance') || errStr.includes('xu') || errStr.includes('tiền')
                    || urlRegex.test(errRaw) || phoneRegexVN.test(errRaw);
                if (isSensitive) {
                    throw new Error('Lỗi khi mua dịch vụ, vui lòng thử lại');
                } else {
                    throw new Error(String(nestedError));
                }
            } else {
                throw new Error('Lỗi khi mua dịch vụ, vui lòng thử lại');
            }
        }
        // --- Bước 5: Trừ số tiền vào tài khoản người dùng ---
        const newBalance = user.balance - totalCost;
        user.balance = newBalance;
        await user.save();

        // --- Bước 6: Tạo mã đơn (Madon) ---
        const lastOrder = await Order.findOne({}).sort({ Madon: -1 });
        const newMadon = lastOrder && lastOrder.Madon ? Number(lastOrder.Madon) + 1 : 10000;

        // --- Bước 7: Tạo đối tượng đơn hàng và lưu vào CSDL ---
        const createdAt = new Date();
        // Xây dựng ObjectLink cho dịch vụ facebook (nếu áp dụng)
        let objectLinkForStore = "";
        try {
            if (serviceFromDb.type && serviceFromDb.type.name) {
                const platformRaw = serviceFromDb.type.name.toLowerCase();
                const isFacebook = platformRaw.includes('facebook') || platformRaw === 'fb' || platformRaw.includes(' fb');
                const isTiktok = platformRaw.includes('tiktok') || platformRaw === 'tt';
                const isInstagram = platformRaw.includes('instagram') || platformRaw === 'ig';
                const raw = (link || '').trim();
                if (!raw) {
                    // nothing
                } else if (isFacebook) {
                    if (/^https?:\/\//i.test(raw)) {
                        objectLinkForStore = raw.replace(/^https?:\/\/(facebook\.com)/i, 'https://www.facebook.com');
                    } else if (/^facebook\.com\//i.test(raw)) {
                        objectLinkForStore = 'https://www.' + raw;
                    } else if (/^fb\.com\//i.test(raw)) {
                        objectLinkForStore = 'https://www.' + raw.replace(/^fb\.com/i, 'facebook.com');
                    } else {
                        const cleaned = raw.replace(/^\/+/, '');
                        objectLinkForStore = 'https://www.facebook.com/' + cleaned;
                    }
                } else if (isTiktok) {
                    if (/^https?:\/\//i.test(raw)) {
                        objectLinkForStore = raw;
                    } else if (/^tiktok\.com\//i.test(raw)) {
                        objectLinkForStore = 'https://' + raw;
                    } else {
                        let cleaned = raw.replace(/^\/+/, '');
                        if (cleaned.startsWith('@')) cleaned = cleaned; // keep @ for tiktok
                        else if (!/\//.test(cleaned)) cleaned = '@' + cleaned; // plain username
                        objectLinkForStore = 'https://www.tiktok.com/' + cleaned;
                    }
                } else if (isInstagram) {
                    if (/^https?:\/\//i.test(raw)) {
                        objectLinkForStore = raw;
                    } else if (/^instagram\.com\//i.test(raw)) {
                        objectLinkForStore = 'https://' + raw;
                    } else {
                        let cleaned = raw.replace(/^\/+/, '');
                        if (cleaned.startsWith('@')) cleaned = cleaned.slice(1);
                        objectLinkForStore = 'https://www.instagram.com/' + cleaned.replace(/\/+$/, '');
                    }
                }
            }
        } catch (_) { /* ignore build object link error */ }

        const orderData = new Order({
            Madon: newMadon,
            Magoi: serviceFromDb.Magoi,
            username,
            SvID: serviceFromDb.serviceId,
            orderId: purchaseResponse.order,
            namesv: `${serviceFromDb.maychu} ${serviceFromDb.name}`,
            category: serviceFromDb.category.name || "Không xác định",
            link,
            start: 0,
            quantity: qty,
            rate: rateForUser,
            totalCost,
            createdAt,
            ObjectLink: objectLinkForStore || link,
            status: 'Pending',
            note: "api/v2",
            comments: formattedComments,
            DomainSmm: serviceFromDb.DomainSmm,
            lai: lai,
            tientieu: tientieu,
            refil: serviceFromDb.refil,
            cancel: serviceFromDb.cancel,
        });

        const HistoryData = new HistoryUser({
            username,
            madon: newMadon,
            hanhdong: 'Tạo đơn hàng',
            link,
            tienhientai: user.balance + totalCost,
            tongtien: totalCost,
            tienconlai: newBalance,
            createdAt,
            mota: `Tăng ${serviceFromDb.maychu} ${serviceFromDb.name} thành công cho uid ${link}`,
        });
        await Service.findOneAndUpdate(
            { Magoi: serviceFromDb.Magoi },
            { $inc: { luotban: 1 } },
            { new: true }
        );
        await orderData.save();
        await HistoryData.save();

        // --- Bước 8: Gửi thông báo về Telegram ---
        // Lấy cấu hình Telegram từ DB
        const teleConfig = await Telegram.findOne();
        if (teleConfig && teleConfig.botToken && teleConfig.chatId) {
            // Giờ Việt Nam (UTC+7)
            const createdAtVN = new Date(createdAt.getTime() + 7 * 60 * 60 * 1000);
            const telegramMessage =
                `📌 *Đơn hàng mới đã được tạo thông qua API*!*\n` +
                `👤 *Khách hàng:* ${username}\n` +
                `🆔 *Mã đơn:* ${newMadon}\n` +
                `🔹 *Dịch vụ:* ${serviceFromDb.maychu} ${serviceFromDb.name}\n` +
                `🔗 *Link:* ${link}\n` +
                `🔸 *Rate:* ${rateForUser}\n` +
                `📌 *Số lượng:* ${qty}\n` +
                `💰 *Tiền cũ:* ${Number(Math.floor(Number(user.balance + totalCost))).toLocaleString("en-US")} VNĐ\n` +
                `💰 *Tổng tiền:* ${Number(Math.floor(Number(totalCost))).toLocaleString("en-US")} VNĐ\n` +
                `💰 *Tiền còn lại:* ${Number(Math.floor(Number(newBalance))).toLocaleString("en-US")} VNĐ\n` +
                `📆 *Ngày tạo:* ${createdAtVN.toLocaleString("vi-VN", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                })}\n` +
                `📝 *Ghi chú:* ${'api/v2'}\n` +
                `Nguồn: ${serviceFromDb.DomainSmm.name}`;
            await sendTelegramNotification({
                telegramBotToken: teleConfig.botToken,
                telegramChatId: teleConfig.chatId,
                message: telegramMessage,
            });
        }
        res.status(200).json({ order: newMadon });
    } catch (error) {
        // Nếu có lỗi từ provider, ưu tiên trả message của provider nhưng ẩn thông tin nhạy cảm
        const providerMsgRaw = error?.response?.data?.error || error?.message || '';
        const providerMsg = String(providerMsgRaw || '');
        const msgLower = providerMsg.toLowerCase();
        const urlRegex = /(https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.(com|net|org|io|vn|co)\b/i;
        const phoneRegexVN = /\b(\+?84|0)(3|5|7|8|9)\d{8}\b/;
        const sensitive = msgLower.includes('số dư') || msgLower.includes('balance') || msgLower.includes('xu') || msgLower.includes('tiền')
            || urlRegex.test(providerMsg) || phoneRegexVN.test(providerMsg);
        const safeMessage = sensitive || !providerMsg ? 'Lỗi khi mua dịch vụ, vui lòng thử lại' : providerMsg;
        res.status(500).json({ error: safeMessage });
    }
};

async function sendTelegramNotification(data) {
    const { telegramBotToken, telegramChatId, message } = data;
    if (telegramBotToken && telegramChatId) {
        try {
            await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
                chat_id: telegramChatId,
                text: message,
            });
            console.log('Thông báo Telegram đã được gửi.');
        } catch (error) {
            console.error('Lỗi gửi thông báo Telegram:', error.message);
        }
    } else {
        console.log('Thiếu thông tin cấu hình Telegram.');
    }
}

/* Hàm lấy danh sách dịch vụ */
exports.getOrderStatus = async (req, res) => {
    try {
        const { key, order, orders } = req.body;

        // Kiểm tra xem API key có được gửi không
        if (!key) {
            return res.status(400).json({ error: "Token không được bỏ trống" });
        }

        // Tìm user dựa trên apiKey
        const user = await User.findOne({ apiKey: key });
        if (!user) {
            return res.status(404).json({ error: "Người dùng không tồn tại" });
        }

        // Kiểm tra trạng thái người dùng
        if (user.status && user.status !== 'active') {
            return res.status(403).json({ error: "Người dùng không hoạt động" });
        }

        // Xử lý trường hợp có `orders` hoặc `order`
        let orderNumbers = [];

        if (orders) {
            // `orders` là danh sách đơn hàng, cần format thành object
            orderNumbers = Array.isArray(orders)
                ? orders.map(num => Number(num))
                : orders.split(',').map(num => Number(num.trim()));
        } else if (order) {
            // `order` là danh sách hoặc một đơn duy nhất
            orderNumbers = [Number(order)];

        } else {
            return res.status(400).json({ error: "Danh sách đơn hàng không được bỏ trống" });
        }

        // Lấy các đơn hàng từ DB
        const orderDocs = await Order.find({
            Madon: { $in: orderNumbers },
            // username: user.username // Kiểm tra đơn hàng có thuộc về user không
        });
        if (orders) {
            // Nếu có `orders`, trả về object với `Madon` làm key
            const formattedOrders = {};
            orderDocs.forEach(order => {
                if (order.username === user.username) {
                    formattedOrders[order.Madon] = {
                        charge: order.totalCost / 25000,
                        start_count: order.start,
                        status: order.status,
                        remains: order.quantity - order.dachay,
                        currency: "USD",
                    };
                }
                else {
                    formattedOrders[order.Madon] = {
                        error: "Incorrect order ID"
                    };
                }
            });
            return res.status(200).json(formattedOrders);
        }
        // Giả sử orderDocs là mảng các đơn hàng từ DB
        if (orderDocs.length > 0) {
            const firstOrder = orderDocs[0];
            let formattedOrder;
            if (firstOrder.username === user.username) {
                formattedOrder = {
                    charge: firstOrder.totalCost / 25000,
                    start_count: firstOrder.start,
                    status: firstOrder.status,
                    remains: firstOrder.quantity - firstOrder.dachay,
                    currency: "USD",
                };
            } else {
                formattedOrder = { order: firstOrder.Madon, error: "Incorrect order ID" };
            }
            return res.status(200).json(formattedOrder);
        } else {
            return res.status(200).json({ order: firstOrder.Madon, error: "Incorrect order ID" });
        }


        return res.status(200).json(formattedList);


        // Nếu có `order`, trả về danh sách

    } catch (error) {
        console.error("Lỗi khi lấy trạng thái đơn:", error);
        return res.status(500).json({
            error: "Lỗi khi lấy trạng thái đơn",
        });
    }
};
exports.cancelOrder = async (req, res) => {
    try {
        const { key, order, orders } = req.body;
        if (!key) return res.status(400).json({ error: 'Thiếu api key' });
        const user = await User.findOne({ apiKey: key });
        if (!user) return res.status(401).json({ error: 'Không tìm thấy người dùng' });
        // Xác định danh sách đơn cần hủy
        let orderList = [];
        if (orders) {
            orderList = Array.isArray(orders) ? orders : orders.split(',').map(o => o.trim());
        } else if (order) {
            orderList = [order];
        } else {
            return res.status(400).json({ error: 'Thiếu mã đơn' });
        }
        // Kết quả trả về cho từng đơn
        const results = [];
        for (const madon of orderList) {
            let result = { order: Number(madon) };
            try {
                const ordersDoc = await Order.findOne({ Madon: madon });
                if (!ordersDoc) {
                    result.cancel = { error: 'Incorrect order ID' };
                    results.push(result);
                    continue;
                }
                if (ordersDoc.iscancel) {
                    result.cancel = { error: 'Đơn hàng đã được hủy' };
                    results.push(result);
                    continue;
                }
                if (ordersDoc.status === "Completed") {
                    result.cancel = { error: 'Đơn hàng đã hoàn thành không thể hủy' };
                    results.push(result);
                    continue;
                }
                if (ordersDoc.status === "Partial" || ordersDoc.status === "Canceled") {
                    result.cancel = { error: 'Đơn hàng đã được hủy' };
                    results.push(result);
                    continue;
                }
                if (ordersDoc.cancel !== "on") {
                    result.cancel = { error: 'Đơn hàng không hỗ trợ hủy' };
                    results.push(result);
                    continue;
                }
                // Kiểm tra quyền hủy đơn
                if (user.role !== 'admin' && ordersDoc.username !== user.username) {
                    result.cancel = { error: 'Đơn hàng không thể hủy' };
                    results.push(result);
                    continue;
                }
                // Lấy config SmmSv theo domain
                const smmConfig = await SmmSv.findById(order.DomainSmm);
                if (!smmConfig) {
                    result.cancel = { error: 'Đơn hàng không thể hủy' };
                    results.push(result);
                    continue;
                }
                // Tạo instance SmmApiService
                const smmApi = new SmmApiService(smmConfig.url_api, smmConfig.api_token);
                // Gọi hàm cancel đến API thứ 3
                let apiResult = await smmApi.cancel2(ordersDoc.orderId);
                let cancelError = null;
                if (Array.isArray(apiResult)) {
                    cancelError = apiResult[0]?.cancel?.error;
                } else if (apiResult.error) {
                    cancelError = apiResult.error;
                }
                // Nếu lỗi thì thử gọi cancel
                if (cancelError) {
                    let apiResult2 = await smmApi.cancel([ordersDoc.orderId]);
                    let cancelError2 = null;
                    if (apiResult2) {
                        if (Array.isArray(apiResult2)) {
                            cancelError2 = apiResult2[0]?.cancel?.error;
                        } else if (apiResult2.error) {
                            cancelError2 = apiResult2.error;
                        }
                    } else {
                        cancelError2 = 'đơn hàng không thể hủy';
                    }
                    if (cancelError2) {
                        result.cancel = { error: 'đơn hàng không thể hủy' };
                        results.push(result);
                        continue;
                    }
                }
                // cancel thành công
                const historyData = new HistoryUser({
                    username: ordersDoc.username,
                    madon: ordersDoc.Madon,
                    hanhdong: "Hủy đơn",
                    link: ordersDoc.link,
                    tienhientai: user.balance,
                    tongtien: 0,
                    tienconlai: user.balance,
                    createdAt: new Date(),
                    mota: `Hủy đơn dịch vụ ${ordersDoc.namesv} uid => ${ordersDoc.link}`,
                });
                await historyData.save();
                ordersDoc.iscancel = true;
                await ordersDoc.save();
                result.cancel = 1;
                results.push(result);
            } catch (err) {
                result.cancel = { error: 'Lỗi liên hệ admin!' };
                results.push(result);
            }
        }
        return res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi liên hệ admin!' });
    }
};

exports.getme = async (req, res) => {
    try {
        const { key } = req.body;

        // Kiểm tra xem token có được gửi không
        if (!key) {
            return res.status(400).json({ error: "Token không được bỏ trống" });
        }
        // Lấy user từ DB dựa trên userId từ decoded token
        const user = await User.findOne({ apiKey: key });
        if (!user) {
            res.status(404).json({ error: 'Người dùng không tồn tại' });
            return null;
        }

        // So sánh token trong header với token đã lưu của user
        if (user.apiKey !== key) {
            res.status(401).json({ error: 'api Key không hợp lệ1' });
            return null;
        }
        // Kiểm tra trạng thái người dùng trong CSDL (ví dụ: 'active')
        if (!user) {
            return res.status(404).json({ error: "Không tìm thấy người dùng" });
        }
        if (user.status && user.status !== 'active') {
            return res.status(403).json({ error: "Người dùng không hoạt động" });
        }
        // Định dạng các trường cần hiển thị (có thể điều chỉnh theo yêu cầu)
        const userForm = {
            balance: user.balance / 25000,
            currency: "USD",
            // Các trường khác nếu cần
        };
        return res.status(200).json(userForm);
    } catch (error) {
        console.error("Lỗi khi lấy thông tin:", error);
        return res.status(500).json({
            error: "Lỗi khi lấy thông tin",
        });
    }
};
/* Hàm điều phối dựa trên giá trị của action trong body */
exports.routeRequest = async (req, res) => {
    const { action } = req.body;

    if (action === 'services') {
        // Gọi hàm lấy danh sách dịch vụ
        return exports.getServices(req, res);
    } else if (action === 'add') {
        // Gọi hàm tạo đơn hàng
        return exports.AddOrder(req, res);
    } else if (action === 'status') {
        // Gọi hàm tạo get trạng thái
        return exports.getOrderStatus(req, res);
    } else if (action === 'balance') {
        // Gọi hàm tạo get trạng thái
        return exports.getme(req, res);
    } else if (action === 'cancel') {
        // Gọi hàm hủy đơn hàng
        return exports.cancelOrder(req, res);
    } else {
        return res.status(400).json({ error: "Action không hợp lệ" });
    }
};
