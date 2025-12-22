const cron = require("node-cron");
const SmmApiService = require("../Smm/smmServices");
const Service = require("../../models/server");
const Category = require("../../models/Category");
const Platform = require("../../models/platform");
const SmmSv = require("../../models/SmmSv");
const Counter = require("../../models/Counter");
const Telegram = require('../../models/Telegram');
const axios = require('axios');

// Helper: Gửi thông báo Telegram
async function sendPriceUpdateNotification(service, oldRate, newPrices, previousOriginal, apiRate, sourceName, direction) {
    const teleConfig = await Telegram.findOne();
    if (!teleConfig?.botToken || !teleConfig?.chatidthaydoigoi) return;

    const createdAtVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const telegramMessage =
        `📌 *Cập nhật giá ${direction}!*\n` +
        `🔹 *Mã gói:* ${service.Magoi}\n` +
        `👤 *Dịch vụ:* ${service.name}\n` +
        `🔹 *Giá cũ (Member):* ${oldRate}\n` +
        `🔹 *Giá Thành Viên:* ${newPrices.member}\n` +
        `🔹 *Giá Đại Lý:* ${newPrices.vip}\n` +
        `🔹 *Giá Nhà Phân Phối:* ${newPrices.distributor}\n` +
        `🔹 *Giá cũ API:* ${Math.round(previousOriginal * 10000) / 10000}\n` +
        `🔹 *Giá mới API:* ${Math.round(apiRate * 10000) / 10000}\n` +
        `🔹 *Nguồn:* ${sourceName}\n` +
        `🔹 *Thời gian:* ${createdAtVN.toLocaleString("vi-VN", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        })}\n`;

    try {
        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
            chat_id: teleConfig.chatidthaydoigoi,
            text: telegramMessage,
            parse_mode: 'Markdown'
        });
        console.log('Thông báo Telegram đã được gửi.');
    } catch (error) {
        console.error('Lỗi gửi thông báo Telegram:', error.message);
    }
}

/**
 * Cron job tự động đồng bộ services từ SMM API
 * Chạy mỗi 6 giờ một lần
 */

// Biến chống chồng lệnh
let isRunning = false;
let syncStartTime = null;

// Cache để tránh query database nhiều lần
const platformCache = new Map();
const categoryCache = new Map();
const serviceCache = new Map();

// Map platform names từ API sang tên chuẩn
const PLATFORM_MAP = {
    FACEBOOK: "FACEBOOK",
    TIKTOK: "TIKTOK",
    INSTAGRAM: "INSTAGRAM",
    YOUTUBE: "YOUTUBE",
    SHOPPE: "SHOPPE",
    THREAD: "THREAD",
    LAZADA: "LAZADA",
    "FACEBOOK GÓI THÁNG": "FACEBOOK GÓI THÁNG",
};

// Map platform logos
const PLATFORM_LOGOS = {
    FACEBOOK: "https://upload.wikimedia.org/wikipedia/commons/5/51/Facebook_f_logo_%282019%29.svg",
    TIKTOK: "https://upload.wikimedia.org/wikipedia/en/a/a9/TikTok_logo.svg",
    INSTAGRAM: "https://upload.wikimedia.org/wikipedia/commons/a/a5/Instagram_icon.png",
    YOUTUBE: "https://upload.wikimedia.org/wikipedia/commons/0/09/YouTube_full-color_icon_%282017%29.svg",
    SHOPPE: "https://upload.wikimedia.org/wikipedia/commons/f/fe/Shopee.svg",
    THREAD: "https://upload.wikimedia.org/wikipedia/commons/9/9d/Threads_%28app%29_logo.svg",
    LAZADA: "https://upload.wikimedia.org/wikipedia/commons/0/0b/Lazada_logo.svg",
    "FACEBOOK GÓI THÁNG": "https://upload.wikimedia.org/wikipedia/commons/5/51/Facebook_f_logo_%282019%29.svg",
};

/**
 * Chuẩn hóa tên platform
 */
function normalizePlatformName(name) {
    return PLATFORM_MAP[name?.toUpperCase()] || name;
}

/**
 * Tìm hoặc tạo Platform (với cache)
 */
async function findOrCreatePlatform(platformName, thututype) {
    const normalizedName = platformName;

    // Kiểm tra cache trước
    if (platformCache.has(normalizedName)) {
        return platformCache.get(normalizedName);
    }

    let platform = await Platform.findOne({ name: normalizedName });

    if (!platform) {
        platform = await Platform.create({
            name: normalizedName,
            logo: PLATFORM_LOGOS[normalizedName] || "https://via.placeholder.com/50",
            status: true,
            thutu: thututype || 4,
        });
        console.log(`✅ Tạo mới Platform: ${normalizedName}`);
    }

    // Lưu vào cache
    platformCache.set(normalizedName, platform);
    return platform;
}

/**
 * Tìm hoặc tạo Category (với cache)
 */
async function findOrCreateCategory(categoryName, platformId, pathFromApi, thutucategory) {
    // Tách category name từ format "PLATFORM | CATEGORY"
    const parts = categoryName.split("|");
    const cleanCategoryName = parts.length > 1 ? parts[1].trim() : categoryName.trim();

    // Sử dụng path từ API nếu có, nếu không thì tự tạo
    const path = pathFromApi || cleanCategoryName
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-");

    // Tạo cache key
    const cacheKey = `${platformId}_${path}`;

    // Kiểm tra cache trước
    if (categoryCache.has(cacheKey)) {
        return categoryCache.get(cacheKey);
    }

    // Tìm category theo path và platformId (path là unique cho mỗi platform)
    let category = await Category.findOne({
        path: path,
        platforms_id: platformId
    });

    if (!category) {
        category = await Category.create({
            platforms_id: platformId,
            name: cleanCategoryName,
            path: path,
            status: true,
            thutu: thutucategory || 4
        });
        console.log(`✅ Tạo mới Category: ${cleanCategoryName} (path: ${path})`);
    }

    // Lưu vào cache
    categoryCache.set(cacheKey, category);
    return category;
}

/**
 * Tạo Magoi tự động
 */
async function generateMagoi() {
    const counter = await Counter.findOneAndUpdate(
        { name: "Magoi" },
        { $inc: { value: 1 } },
        { new: true, upsert: true }
    );
    return counter.value;
}

/**
 * Tìm hoặc tạo Service (với cache)
 * @returns {Object} { service, isNew } - service object và flag đánh dấu tạo mới
 */
async function findOrCreateService(serviceData, smmSvId, platformId, categoryId) {
    // Tạo cache key
    const cacheKey = `${smmSvId._id}_${serviceData.service}`;
    let isNew = false;

    // Tìm service theo serviceId từ API (kiểm tra cache trước)
    let service = serviceCache.get(cacheKey);

    if (!service) {
        service = await Service.findOne({
            serviceId: Number(serviceData.service),
            DomainSmm: smmSvId._id
        });

        if (service) {
            // Lưu vào cache nếu tìm thấy
            serviceCache.set(cacheKey, service);
        }
    }

    if (service) {
        // Kiểm tra xem có thay đổi gì không
        let hasChanges = false;

        // Kiểm tra và cập nhật Platform nếu thay đổi
        if (service.type.toString() !== platformId.toString()) {
            console.log(`🔄 Platform thay đổi cho ${service.name}: ${service.type} -> ${platformId}`);
            service.type = platformId;
            hasChanges = true;
        }

        // Kiểm tra và cập nhật Category nếu thay đổi
        if (service.category.toString() !== categoryId.toString()) {
            console.log(`🔄 Category thay đổi cho ${service.name}: ${service.category} -> ${categoryId}`);
            service.category = categoryId;
            hasChanges = true;
        }

        // Chuẩn bị dữ liệu mới
        const newData = {
            serviceName: serviceData.name,
            name: serviceData.name,
            tocdodukien: serviceData.tocdodukien || "",
            luotban: Number(serviceData.luotban) || 0,
            getid: (serviceData.getid === true || serviceData.getid === "on") ? "on" : "off",
            comment: (serviceData.comment === true || serviceData.comment === "on") ? "on" : "off",
            description: serviceData.description || "",
            min: serviceData.min,
            max: serviceData.max,
            cancel: serviceData.cancel ? "on" : "off",
            refil: serviceData.refill ? "on" : "off",
            isActive: serviceData.isActive === true || serviceData.isActive === "on" ? true : false
        };

        // So sánh và cập nhật nếu có thay đổi
        for (const [key, value] of Object.entries(newData)) {
            if (service[key] !== value) {
                service[key] = value;
                hasChanges = true;
            }
        }

        const apirate = Number(serviceData.rate); // Giá từ API
        const previousOriginal = Number(service.originalRate) || 0; // Giá API trước đó

        const dbRate = Number(service.rate); // Giá member hiện tại
        const dbRateVip = Number(service.ratevip); // Giá vip hiện tại
        const dbRateDistributor = Number(service.rateDistributor); // Giá distributor hiện tại


        // Xác định hướng thay đổi giá
        let direction = '!';
        if (apirate > previousOriginal) direction = 'TĂNG';
        else if (apirate < previousOriginal) direction = 'GIẢM';
        // Xác định hướng thay đổi


        // Tính giá mới trước
        const rateMember = Math.round(apirate * (1 + Number(smmSvId.price_update) / 100) * 10000) / 10000;
        const rateVip = Math.round(apirate * (1 + Number(smmSvId.price_updateVip) / 100) * 10000) / 10000;
        const rateDistributor = Math.round(apirate * (1 + Number(smmSvId.price_updateDistributor) / 100) * 10000) / 10000;

        // Điều kiện cập nhật giá: giá API thay đổi HOẶC bất kỳ giá DB nào khác giá mới cần thiết
        const shouldUpdate =
            (
                apirate !== previousOriginal ||
                dbRate < apirate ||               // nếu giá member thấp hơn API
                dbRateVip < apirate ||           // giá vip thấp hơn API
                dbRateDistributor < apirate ||   // giá distributor thấp hơn API
                apirate < previousOriginal // hoặc giá API giảm
            );
        if (shouldUpdate) {
            const newPrices = {
                member: rateMember,
                vip: rateVip,
                distributor: rateDistributor
            };

            service.originalRate = apirate;
            service.rate = rateMember;
            service.ratevip = rateVip;
            service.rateDistributor = rateDistributor;
            hasChanges = true;

            await sendPriceUpdateNotification(
                service,
                previousOriginal,
                newPrices,
                previousOriginal,
                apirate,
                smmSvId.name,
                direction
            );

            console.log(
                `💰 Giá thay đổi (${direction}) ${service.name}: ${previousOriginal} -> ${apirate}`
            );
        }

        // Chỉ lưu khi có thay đổi
        if (hasChanges) {
            await service.save();
            // Cập nhật cache
            serviceCache.set(cacheKey, service);
            console.log(`🔄 Cập nhật Service: ${service.name} (${service.Magoi})`);
        } else {

        }
    } else {
        // Tạo mới service
        isNew = true;
        const magoi = await generateMagoi();
        const apirate = serviceData.rate;
        const ratemenber = Math.round(apirate * (1 + Number(smmSvId.price_update) / 100) * 10000) / 10000;
        const ratevip = Math.round(apirate * (1 + Number(smmSvId.price_updateVip) / 100) * 10000) / 10000;
        const rateDistributor = Math.round(apirate * (1 + Number(smmSvId.price_updateDistributor) / 100) * 10000) / 10000;
        service = await Service.create({
            DomainSmm: smmSvId._id,
            serviceName: serviceData.name,
            originalRate: serviceData.rate,
            serviceId: Number(serviceData.service),
            category: categoryId,
            type: platformId,
            Magoi: magoi,
            maychu: serviceData.maychu || "",
            tocdodukien: serviceData.tocdodukien || "",
            luotban: Number(serviceData.luotban) || 0,
            thutu: serviceData.thutu ? String(serviceData.thutu) : "4",
            getid: (serviceData.getid === true || serviceData.getid === "on") ? "on" : "off",
            comment: (serviceData.comment === true || serviceData.comment === "on") ? "on" : "off",
            description: serviceData.description || "",
            name: serviceData.name,
            rate: ratemenber,
            ratevip: ratevip,
            rateDistributor: rateDistributor,
            min: serviceData.min,
            max: serviceData.max,
            cancel: serviceData.cancel ? "on" : "off",
            refil: serviceData.refill ? "on" : "off",
            isActive: serviceData.isActive === true || serviceData.isActive === "on" ? true : false,
            status: serviceData.status === true || serviceData.status === "on" ? true : false,
        });

        // Lưu vào cache
        serviceCache.set(cacheKey, service);
        console.log(`✅ Tạo mới Service: ${service.name} (${service.Magoi})`);
    }

    return { service, isNew };
}

/**
 * Đồng bộ services từ một SMM source
 */
async function syncServicesFromSmmSource(smmSv) {
    try {
        console.log(`\n🔄 Bắt đầu đồng bộ từ: ${smmSv.name || smmSv.url_api}`);

        // Khởi tạo SMM API Service
        const smm = new SmmApiService(smmSv.url_api, smmSv.api_token);

        // Lấy danh sách services từ API
        const servicesResponse = await smm.webcon();
        // Kiểm tra response
        if (!servicesResponse) {
            console.error(`❌ Lỗi: Response từ ${smmSv.name} là null/undefined`);
            return;
        }

        // Xử lý response - có thể là array trực tiếp hoặc object chứa array
        let servicesList = [];
        if (Array.isArray(servicesResponse)) {
            servicesList = servicesResponse;
        } else if (servicesResponse.data && Array.isArray(servicesResponse.data)) {
            servicesList = servicesResponse.data;
        } else if (servicesResponse.services && Array.isArray(servicesResponse.services)) {
            servicesList = servicesResponse.services;
        } else if (typeof servicesResponse === 'object') {
            // Thử tìm array đầu tiên trong object
            for (const key in servicesResponse) {
                if (Array.isArray(servicesResponse[key])) {
                    servicesList = servicesResponse[key];
                    break;
                }
            }
        }

        if (servicesList.length === 0) {
            console.error(`❌ Lỗi: Không tìm thấy danh sách services từ ${smmSv.name}`);
            console.error(`Response type: ${typeof servicesResponse}`);
            console.error(`Response keys: ${Object.keys(servicesResponse || {}).join(', ')}`);
            return;
        }

        console.log(`📦 Tìm thấy ${servicesList.length} services từ API`);

        // Pre-load tất cả services của source này vào cache để tối ưu
        const existingServices = await Service.find({ DomainSmm: smmSv._id });
        existingServices.forEach(service => {
            const cacheKey = `${smmSv._id}_${service.serviceId}`;
            serviceCache.set(cacheKey, service);
        });
        console.log(`💾 Đã load ${existingServices.length} services vào cache`);

        const apiServiceIds = new Set();
        let created = 0;
        let updated = 0;
        let deleted = 0;
        let errors = 0;

        // Xử lý từng service
        for (const serviceData of servicesList) {
            try {
                // Validate dữ liệu cơ bản
                if (!serviceData.service || !serviceData.name || !serviceData.platform || !serviceData.category) {
                    errors++;
                    continue;
                }

                const numericServiceId = Number(serviceData.service);
                if (!numericServiceId) {
                    errors++;
                    continue;
                }

                apiServiceIds.add(numericServiceId);

                // 1. Tìm hoặc tạo Platform
                const platform = await findOrCreatePlatform(
                    serviceData.platform,
                    serviceData.thututype
                );

                // 2. Tìm hoặc tạo Category (sử dụng path từ API)
                const category = await findOrCreateCategory(
                    serviceData.category,
                    platform._id,
                    serviceData.path,
                    serviceData.thutucategory
                );

                // 3. Tìm hoặc tạo Service
                const result = await findOrCreateService(serviceData, smmSv, platform._id, category._id);

                // Đếm dựa trên flag isNew từ kết quả
                if (result.isNew) {
                    created++;
                } else {
                    updated++;
                }

            } catch (error) {
                console.error(`❌ Lỗi xử lý service ${serviceData.service}:`, error.message);
                errors++;
            }
        }

        // Xóa dịch vụ không còn tồn tại ở nguồn
        for (const existingService of existingServices) {
            const existingId = Number(existingService.serviceId);
            if (!existingId || apiServiceIds.has(existingId)) {
                continue;
            }

            try {
                await Service.deleteOne({ _id: existingService._id });
                serviceCache.delete(`${smmSv._id}_${existingService.serviceId}`);
                deleted++;
                console.log(`🗑️ Đã xóa service không còn ở nguồn: ${existingService.name} (${existingService.Magoi})`);
            } catch (deleteErr) {
                errors++;
                console.error(`❌ Không thể xóa service ${existingService.name}:`, deleteErr.message);
            }
        }

        console.log(`\n✅ Hoàn thành đồng bộ từ ${smmSv.name || smmSv.url_api}`);
        console.log(`   - Tạo mới: ${created} services`);
        console.log(`   - Cập nhật: ${updated} services`);
        console.log(`   - Xóa: ${deleted} services`);
        console.log(`   - Lỗi: ${errors} services`);

    } catch (error) {
        console.error(`❌ Lỗi khi đồng bộ từ ${smmSv.name || smmSv.url_api}:`, error.message);
    }
}

/**
 * Main function - Đồng bộ tất cả SMM sources
 */
async function syncAllServices() {
    // Kiểm tra chống chồng lệnh
    if (isRunning) {
        const elapsedTime = Date.now() - syncStartTime;
        console.warn(`⚠️ Bỏ qua: Tiến trình đồng bộ đang chạy (${Math.round(elapsedTime / 1000)}s)`);
        return;
    }

    isRunning = true;
    syncStartTime = Date.now();

    try {
        console.log("\n" + "=".repeat(60));
        console.log("🚀 BẮT ĐẦU ĐỒNG BỘ SERVICES TỪ SMM API");
        console.log("=".repeat(60));

        platformCache.clear();
        categoryCache.clear();
        serviceCache.clear();
        console.log("🧠 Cache đã được reset trước khi đồng bộ");

        // Lấy tất cả SMM sources đang active
        const smmSources = await SmmSv.find({
            status: "on",
            ordertay: { $ne: true } // Bỏ qua source "Đơn tay"
        });

        if (smmSources.length === 0) {
            console.log("⚠️ Không tìm thấy SMM source nào đang hoạt động");
            return;
        }

        console.log(`📋 Tìm thấy ${smmSources.length} SMM sources đang hoạt động\n`);

        // Đồng bộ từng source
        for (const smmSv of smmSources) {
            await syncServicesFromSmmSource(smmSv);
        }

        console.log("\n" + "=".repeat(60));
        console.log("✅ HOÀN THÀNH ĐỒNG BỘ SERVICES");
        console.log("=".repeat(60) + "\n");

        const totalTime = Date.now() - syncStartTime;
        console.log(`⏱️ Tổng thời gian đồng bộ: ${Math.round(totalTime / 1000)}s`);

    } catch (error) {
        console.error("❌ Lỗi tổng quát khi đồng bộ services:", error);
    } finally {
        // Luôn luôn reset trạng thái để cho phép lần chạy tiếp theo
        isRunning = false;
        syncStartTime = null;
    }
}

const webcon = process.env.webcon;

if (webcon === 'true') {
    cron.schedule('*/30 * * * * *', async () => {
        console.log(`\n⏰ [${new Date().toLocaleString()}] Cron job đồng bộ services được kích hoạt`);
        await syncAllServices();
    });
}
console.log("✅ Cron job đồng bộ services đã được khởi động (chạy mỗi 6 giờ)");

// Export để có thể gọi thủ công
module.exports = {
    syncAllServices,
    syncServicesFromSmmSource,
};
