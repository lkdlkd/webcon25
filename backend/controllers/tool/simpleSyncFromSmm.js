const Service = require('../../models/server');
const Category = require('../../models/Category');
const Platform = require('../../models/platform');
const SmmSv = require('../../models/SmmSv');
const Counter = require('../../models/Counter');
const Telegram = require('../../models/Telegram');
const axios = require('axios');

// Cache để tránh query database nhiều lần
const platformCache = new Map();
const categoryCache = new Map();

// Platform logos mapping
const PLATFORM_LOGOS = {
    FACEBOOK: "https://upload.wikimedia.org/wikipedia/commons/b/b8/2021_Facebook_icon.svg",
    TIKTOK: "https://upload.wikimedia.org/wikipedia/en/a/a9/TikTok_logo.svg",
    INSTAGRAM: "https://upload.wikimedia.org/wikipedia/commons/a/a5/Instagram_icon.png",
    YOUTUBE: "https://upload.wikimedia.org/wikipedia/commons/0/09/YouTube_full-color_icon_%282017%29.svg",
    SHOPPE: "https://upload.wikimedia.org/wikipedia/commons/f/fe/Shopee.svg",
    THREAD: "https://upload.wikimedia.org/wikipedia/commons/9/9d/Threads_%28app%29_logo.svg",
    LAZADA: "https://upload.wikimedia.org/wikipedia/commons/0/0b/Lazada_logo.svg",
};

/**
 * Helper: Gửi thông báo Telegram khi giá thay đổi
 */
async function sendPriceUpdateNotification(service, oldRate, newPrices, previousOriginal, apiRate, sourceName, direction) {
    try {
        const teleConfig = await Telegram.findOne();
        if (!teleConfig?.botToken || !teleConfig?.chatidthaydoigoi) return;

        const createdAtVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const telegramMessage =
            `📌 *Cập nhật giá đồng bộ ${direction}!*\n` +
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

        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
            chat_id: teleConfig.chatidthaydoigoi,
            text: telegramMessage,
            parse_mode: 'Markdown'
        });
        console.log('✅ Thông báo Telegram đã được gửi.');
    } catch (error) {
        console.error('❌ Lỗi gửi thông báo Telegram:', error.message);
    }
}

/**
 * Tìm hoặc tạo Platform (với cache)
 */
async function findOrCreatePlatform(platformName) {
    const normalizedName = platformName.toUpperCase();

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
            thutu: 4,
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
async function findOrCreateCategory(categoryName, platformId) {
    // Tách category name từ format "PLATFORM | CATEGORY"
    const parts = categoryName.split("|");
    const cleanCategoryName = parts.length > 1 ? parts[1].trim() : categoryName.trim();

    // Tạo cache key theo tên (vì path có thể thay đổi suffix)
    const cacheKey = `${platformId}_${cleanCategoryName}`;

    // Kiểm tra cache trước
    if (categoryCache.has(cacheKey)) {
        return categoryCache.get(cacheKey);
    }

    // Tìm category theo TÊN và platformId
    // (Ưu tiên tìm theo tên vì path có thể đã bị thêm suffix số để đảm bảo unique)
    let category = await Category.findOne({
        name: cleanCategoryName,
        platforms_id: platformId
    });

    if (!category) {
        // Tự động tạo path từ category name
        let basePath = cleanCategoryName
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/\s+/g, "-");

        if (!basePath) basePath = "category";

        // Đảm bảo path là duy nhất trong toàn bộ hệ thống
        let uniquePath = basePath;
        let counter = 1;
        while (await Category.findOne({ path: uniquePath })) {
            uniquePath = `${basePath}-${counter}`;
            counter++;
        }

        category = await Category.create({
            platforms_id: platformId,
            name: cleanCategoryName,
            path: uniquePath,
            status: true,
            thutu: 4,
            notes: "",
            modal_show: ""
        });
        console.log(`✅ Tạo mới Category: ${cleanCategoryName} (path: ${uniquePath})`);
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
 * Đồng bộ dịch vụ đơn giản từ SMM API
 * Tự động gọi API để lấy danh sách services
 */
async function simpleSyncFromSmm(smmSv) {
    try {
        console.log(`\n🔄 Bắt đầu đồng bộ đơn giản từ: ${smmSv.name || smmSv.url_api}`);

        // Import SmmApiService
        const SmmApiService = require('../Smm/smmServices');

        // Khởi tạo SMM API Service
        const smm = new SmmApiService(smmSv.url_api, smmSv.api_token);

        // Lấy danh sách services từ API
        const servicesResponse = await smm.services();

        // Kiểm tra response
        if (!servicesResponse) {
            console.error(`❌ Lỗi: Response từ ${smmSv.name} là null/undefined`);
            throw new Error('Response từ SMM API không hợp lệ');
        }

        // Xử lý response - có thể là array trực tiếp hoặc object chứa array
        let servicesData = [];
        if (Array.isArray(servicesResponse)) {
            servicesData = servicesResponse;
        } else if (servicesResponse.data && Array.isArray(servicesResponse.data)) {
            servicesData = servicesResponse.data;
        } else if (servicesResponse.services && Array.isArray(servicesResponse.services)) {
            servicesData = servicesResponse.services;
        } else if (typeof servicesResponse === 'object') {
            // Thử tìm array đầu tiên trong object
            for (const key in servicesResponse) {
                if (Array.isArray(servicesResponse[key])) {
                    servicesData = servicesResponse[key];
                    break;
                }
            }
        }

        if (servicesData.length === 0) {
            console.error(`❌ Lỗi: Không tìm thấy danh sách services từ ${smmSv.name}`);
            console.error(`Response type: ${typeof servicesResponse}`);
            console.error(`Response keys: ${Object.keys(servicesResponse || {}).join(', ')}`);
            throw new Error('Không tìm thấy danh sách services từ API');
        }

        console.log(`📦 Tìm thấy ${servicesData.length} services từ API`);

        // Clear cache
        platformCache.clear();
        categoryCache.clear();

        let created = 0;
        let updated = 0;
        let errors = 0;

        // Pre-load existing services của source này
        const existingServices = await Service.find({ DomainSmm: smmSv._id });
        const existingServiceMap = new Map();
        existingServices.forEach(s => {
            // Sử dụng String key để tránh lỗi NaN
            existingServiceMap.set(String(s.serviceId), s);
        });
        console.log(`💾 Đã load ${existingServices.length} services hiện có`);

        const apiServiceIds = new Set();

        // Xử lý từng service
        for (const serviceData of servicesData) {
            try {
                // Validate dữ liệu cơ bản
                if (!serviceData.service || !serviceData.name || !serviceData.platform || !serviceData.category) {
                    console.warn(`⚠️ Bỏ qua service thiếu thông tin:`, serviceData);
                    errors++;
                    continue;
                }

                // Chuyển ID sang chuỗi để an toàn
                const apiServiceIdStr = String(serviceData.service);
                apiServiceIds.add(apiServiceIdStr);

                // 1. Tìm hoặc tạo Platform
                const platform = await findOrCreatePlatform(serviceData.platform);

                // 2. Tìm hoặc tạo Category
                const category = await findOrCreateCategory(serviceData.category, platform._id);

                // 3. Tính giá với markup của partner và tỷ giá
                const exchangeRate = Number(smmSv.tigia) || 1;
                const rawApiRate = Number(serviceData.rate) || 0;
                const apiRate = rawApiRate * exchangeRate; // Giá gốc đã quy đổi

                const rateMember = Math.round(apiRate * (1 + Number(smmSv.price_update || 0) / 100) * 10000) / 10000;
                const rateVip = Math.round(apiRate * (1 + Number(smmSv.price_updateVip || 0) / 100) * 10000) / 10000;
                const rateDistributor = Math.round(apiRate * (1 + Number(smmSv.price_updateDistributor || 0) / 100) * 10000) / 10000;

                // 4. Kiểm tra service đã tồn tại chưa
                let existingService = existingServiceMap.get(apiServiceIdStr);

                if (existingService) {
                    // Update Logic
                    let hasChanges = false;

                    // Check if moved Platform or Category
                    if (existingService.type?.toString() !== platform._id.toString()) {
                        existingService.type = platform._id;
                        hasChanges = true;
                    }
                    if (existingService.category?.toString() !== category._id.toString()) {
                        existingService.category = category._id;
                        hasChanges = true;
                    }

                    // Check other fields
                    if (existingService.serviceName !== serviceData.name) {
                        existingService.serviceName = serviceData.name;
                        existingService.name = serviceData.name; // usually synced
                        hasChanges = true;
                    }

                    // Check Cancel/Refill
                    const normalizeBool = (val) => ["1", "true", "on", 1, true].includes(val) ? "on" : "off";
                    const newCancel = normalizeBool(serviceData.cancel);
                    const newRefill = normalizeBool(serviceData.refill);

                    if (existingService.cancel !== newCancel) {
                        existingService.cancel = newCancel;
                        hasChanges = true;
                    }
                    if (existingService.refil !== newRefill) {
                        existingService.refil = newRefill;
                        hasChanges = true;
                    }

                    // Price check
                    const previousOriginal = Number(existingService.originalRate) || 0;
                    const dbRate = Number(existingService.rate);
                    let direction = '!';
                    if (apiRate > previousOriginal) direction = 'TĂNG';
                    else if (apiRate < previousOriginal) direction = 'GIẢM';

                    const shouldUpdatePrice = (
                        apiRate !== previousOriginal ||
                        dbRate < apiRate
                    );

                    if (shouldUpdatePrice) {
                        const newPrices = {
                            member: rateMember,
                            vip: rateVip,
                            distributor: rateDistributor
                        };
                        existingService.originalRate = apiRate;
                        existingService.rate = rateMember;
                        existingService.ratevip = rateVip;
                        existingService.rateDistributor = rateDistributor;
                        hasChanges = true;

                        await sendPriceUpdateNotification(existingService, previousOriginal, newPrices, previousOriginal, apiRate, smmSv.name, direction);
                        console.log(`💰 Giá thay đổi ${existingService.name}: ${previousOriginal} -> ${apiRate}`);
                    }

                    // Min/Max/Status updates could be added here if critical
                    // For now, let's trust the essential fields updates

                    if (hasChanges) {
                        await existingService.save();
                        updated++;
                        console.log(`🔄 Cập nhật Service: ${existingService.name} (${existingService.Magoi})`);
                    } else {
                        // console.log(`⏭️ Service không thay đổi: ${existingService.name}`);
                    }

                } else {
                    // Tạo mới service
                    const magoi = await generateMagoi();

                    // Xác định comment setting dựa trên type
                    const commentSetting = (serviceData.type && serviceData.type.toLowerCase().includes("comment")) ? "on" : "off";

                    const newService = await Service.create({
                        DomainSmm: smmSv._id,
                        serviceName: serviceData.name,
                        originalRate: apiRate,
                        serviceId: apiServiceIdStr,
                        category: category._id,
                        type: platform._id,
                        Magoi: magoi,
                        name: serviceData.name,
                        rate: rateMember,
                        ratevip: rateVip,
                        rateDistributor: rateDistributor,
                        min: Number(serviceData.min) || 0,
                        max: Number(serviceData.max) || 0,
                        cancel: ["1", "true", "on", 1, true].includes(serviceData.cancel) ? "on" : "off",
                        refil: ["1", "true", "on", 1, true].includes(serviceData.refill) ? "on" : "off",
                        isActive: true,
                        status: true,
                        maychu: "",
                        tocdodukien: "",
                        luotban: 0,
                        thutu: "4",
                        getid: "off",
                        comment: commentSetting,
                        description: ""
                    });

                    created++;
                    console.log(`✅ Tạo mới Service: ${newService.name} (${newService.Magoi})`);
                }

            } catch (error) {
                console.error(`❌ Lỗi xử lý service ${serviceData.service}:`, error.message);
                errors++;
            }
        }

        // Xóa dịch vụ không còn tồn tại ở nguồn API
        let deleted = 0;
        for (const existingService of existingServices) {
            // Check String to String
            if (!apiServiceIds.has(String(existingService.serviceId))) {
                try {
                    await Service.deleteOne({ _id: existingService._id });
                    deleted++;
                    console.log(`🗑️ Đã xóa service không còn ở nguồn: ${existingService.name} (${existingService.Magoi})`);
                } catch (deleteErr) {
                    errors++;
                    console.error(`❌ Không thể xóa service ${existingService.name}:`, deleteErr.message);
                }
            }
        }

        console.log(`\n✅ Hoàn thành đồng bộ từ ${smmSv.name}`);
        console.log(`   - Tạo mới: ${created} services`);
        console.log(`   - Cập nhật: ${updated} services`);
        console.log(`   - Xóa: ${deleted} services`);
        console.log(`   - Lỗi: ${errors} services`);

        return {
            success: true,
            created,
            updated,
            deleted,
            errors
        };

    } catch (error) {
        console.error(`❌ Lỗi khi đồng bộ từ ${smmSv.name}:`, error.message);
        throw error;
    }
}

/**
 * Controller function cho API endpoint
 * Tự động gọi API SMM để lấy services
 */
async function simpleSyncController(req, res) {
    try {
        const { smmId } = req.params;
        const user = req.user;

        // Check admin permission
        if (!user || user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Chỉ admin mới có quyền sử dụng chức năng này"
            });
        }

        // Find SMM partner
        const smmSv = await SmmSv.findById(smmId);
        if (!smmSv) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy đối tác SMM"
            });
        }

        // Check if partner is active
        if (smmSv.status !== "on") {
            return res.status(400).json({
                success: false,
                message: `Đối tác ${smmSv.name} đang không hoạt động`
            });
        }

        // Clear cache before sync
        platformCache.clear();
        categoryCache.clear();
        console.log("🧠 Cache đã được reset trước khi đồng bộ thủ công");

        // Sync services (will call API automatically)
        const result = await simpleSyncFromSmm(smmSv);

        return res.status(200).json({
            success: true,
            message: `Đồng bộ thành công từ ${smmSv.name}`,
            data: result
        });

    } catch (error) {
        console.error("❌ Lỗi khi đồng bộ thủ công:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi khi đồng bộ dịch vụ",
            error: error.message
        });
    }
}

module.exports = {
    simpleSyncFromSmm,
    simpleSyncController
};
