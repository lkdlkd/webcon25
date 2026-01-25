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
 * Đồng bộ services từ một SMM source theo cấu trúc webcon
 * Xử lý đầy đủ: Add/Edit/Delete cho Platform, Category, Service
 * Sử dụng ID từ API (idSmm) để định danh chính xác
 */
async function syncServicesFromSmmSource(smmSv) {
    try {
        console.log(`\n🔄 Bắt đầu đồng bộ từ: ${smmSv.name || smmSv.url_api}`);

        // Khởi tạo SMM API Service
        const smm = new SmmApiService(smmSv.url_api, smmSv.api_token);

        // Lấy danh sách services từ API theo cấu trúc webcon
        const apiResponse = await smm.webcon();

        // Kiểm tra response
        if (!apiResponse || !Array.isArray(apiResponse)) {
            console.error(`❌ Lỗi: Response từ ${smmSv.name} không hợp lệ`);
            return;
        }

        console.log(`📦 Tìm thấy ${apiResponse.length} platforms từ API`);

        // Track các ID từ API (ID local của chúng ta) để biết cái nào cần xóa
        // Khi dùng idSmm, ta sẽ track _id của các record đã được sync/match
        const processedPlatformIds = new Set();
        const processedCategoryIds = new Set();
        const apiServiceIds = new Set(); // Service thì dùng serviceId (string)

        let stats = {
            platforms: { created: 0, updated: 0, deleted: 0 },
            categories: { created: 0, updated: 0, deleted: 0 },
            services: { created: 0, updated: 0, deleted: 0 },
            errors: 0
        };

        // Lấy tất cả platforms, categories, services hiện có
        // Lưu ý: Chúng ta lấy hết, không lọc theo source cho Platform/Category vì schema cũ có thể chưa có idSmm
        // Nhưng khi xóa, cẩn thận chỉ xóa những cái được tạo bởi SMM này hoặc logic "single source" như user yêu cầu
        const existingPlatforms = await Platform.find({});
        const existingCategories = await Category.find({});
        const existingServices = await Service.find({ DomainSmm: smmSv._id });

        // Tạo map để tra cứu nhanh & logic migration
        // Map theo idSmm (nếu có) và Map theo Name (để fallback)
        const platformByIdSmm = new Map();
        const platformByName = new Map();
        existingPlatforms.forEach(p => {
            if (p.idSmm) platformByIdSmm.set(p.idSmm, p);
            platformByName.set(p.name.toUpperCase(), p);
        });

        // Tương tự cho Category
        // Category cần unique identify. Trước đây là idSmm hoặc path+platform.
        const categoryByIdSmm = new Map();
        const categoryByKey = new Map(); // Key = platformId_path (như cũ)
        const categoryByIdMap = new Map(); // Key = MongoID (dùng cho heuristic)
        existingCategories.forEach(c => {
            if (c.idSmm) categoryByIdSmm.set(c.idSmm, c);
            categoryByKey.set(`${c.platforms_id}_${c.path}`, c);
            categoryByIdMap.set(c._id.toString(), c);
        });

        // Use keys as STRING for safety
        const existingServicesMap = new Map(existingServices.map(s => [String(s.serviceId), s]));

        // Xử lý từng platform từ API
        for (const platformData of apiResponse) {
            try {
                if (!platformData.platform_name || !Array.isArray(platformData.categories)) {
                    console.warn(`⚠️ Bỏ qua platform thiếu thông tin`);
                    stats.errors++;
                    continue;
                }

                // ID từ API (có thể là platform_id từ source)
                const apiPlatformId = platformData.platform_id ? String(platformData.platform_id) : null;
                const platformName = platformData.platform_name.trim();
                const platformThutu = platformData.platform_thutu || 4;
                const platformStatus = platformData.platform_status !== undefined ? platformData.platform_status : true;
                const platformLogo = platformData.platform_logo || PLATFORM_LOGOS[platformName.toUpperCase()] || "https://via.placeholder.com/50";

                // 1. Tìm Platform
                let platform = null;

                // Ưu tiên tìm theo idSmm
                if (apiPlatformId && platformByIdSmm.has(apiPlatformId)) {
                    platform = platformByIdSmm.get(apiPlatformId);
                }
                // Fallback: Tìm theo tên (nếu chưa có idSmm)
                else if (platformByName.has(platformName.toUpperCase())) {
                    platform = platformByName.get(platformName.toUpperCase());
                    // Migration: Cập nhật idSmm cho platform cũ
                    if (apiPlatformId && !platform.idSmm) {
                        console.log(`🔗 Link Platform cũ "${platformName}" với ID SMM: ${apiPlatformId}`);
                        platform.idSmm = apiPlatformId;
                        platformByIdSmm.set(apiPlatformId, platform); // Update map
                    }
                }

                if (platform) {
                    // Cập nhật
                    let hasChanges = false;

                    if (apiPlatformId && platform.idSmm !== apiPlatformId) {
                        platform.idSmm = apiPlatformId;
                        hasChanges = true;
                    }

                    if (platform.name !== platformName) {
                        console.log(`🔄 Rename Platform: "${platform.name}" -> "${platformName}"`);
                        platform.name = platformName;
                        hasChanges = true;
                    }

                    if (Number(platform.thutu) !== Number(platformThutu)) {
                        platform.thutu = platformThutu;
                        hasChanges = true;
                    }

                    if (platform.status !== platformStatus) {
                        platform.status = platformStatus;
                        hasChanges = true;
                    }

                    if (platform.logo !== platformLogo) {
                        platform.logo = platformLogo;
                        hasChanges = true;
                    }

                    if (hasChanges) {
                        await platform.save();
                        stats.platforms.updated++;
                        console.log(`🔄 Cập nhật Platform: ${platformName}`);
                    }
                } else {
                    // Tạo mới
                    platform = await Platform.create({
                        name: platformName,
                        logo: platformLogo,
                        status: platformStatus,
                        thutu: platformThutu,
                        idSmm: apiPlatformId // Lưu ID từ API
                    });
                    stats.platforms.created++;
                    console.log(`✅ Tạo mới Platform: ${platformName} (ID SMM: ${apiPlatformId})`);
                }

                // Đánh dấu đã xử lý platform này (để không xóa)
                processedPlatformIds.add(platform._id.toString());
                platformByIdSmm.set(apiPlatformId || "null", platform); // update map for safety

                // 2. Xử lý Categories của platform này
                for (const categoryData of platformData.categories) {
                    try {
                        if (!categoryData.category_name || !categoryData.category_path) {
                            console.warn(`⚠️ Bỏ qua category thiếu thông tin trong platform ${platformName}`);
                            stats.errors++;
                            continue;
                        }

                        const apiCategoryId = categoryData.category_id ? String(categoryData.category_id) : null;
                        const categoryName = categoryData.category_name.trim();
                        const categoryPath = categoryData.category_path;
                        const categoryThutu = categoryData.category_thutu || 4;
                        const categoryStatus = categoryData.category_status !== undefined ? categoryData.category_status : true;
                        const categoryNotes = categoryData.category_notes || "";
                        const categoryModalShow = categoryData.category_modal_show || "";

                        // Key cũ để fallback tìm kiếm
                        const legacyKey = `${platform._id}_${categoryPath}`;

                        let category = null;

                        // Ưu tiên tìm theo idSmm
                        if (apiCategoryId && categoryByIdSmm.has(apiCategoryId)) {
                            category = categoryByIdSmm.get(apiCategoryId);
                        }
                        // Fallback: Tìm theo key cũ (path + platformId)
                        else if (categoryByKey.has(legacyKey)) {
                            category = categoryByKey.get(legacyKey);
                            // Migration: Cập nhật idSmm
                            if (apiCategoryId && !category.idSmm) {
                                console.log(`🔗 Link Category cũ "${categoryName}" với ID SMM: ${apiCategoryId}`);
                                category.idSmm = apiCategoryId;
                                categoryByIdSmm.set(apiCategoryId, category); // Update map
                            }
                        }

                        // HEURISTIC: Nếu vẫn chưa tìm thấy, thử tìm qua Service associations để phát hiện Category bị di chuyển
                        if (!category && Array.isArray(categoryData.services) && categoryData.services.length > 0) {
                            // Thử quét qua các services trong danh sách để tìm manh mối
                            for (const svcData of categoryData.services) {
                                const svcId = String(svcData.service_id); // Used to be Number, now String for safety
                                const existingSvc = existingServicesMap.get(svcId);
                                // Nếu tìm thấy dịch vụ đã tồn tại trong DB, xem nó đang thuộc category nào
                                if (existingSvc && existingSvc.category) {
                                    const candidateCat = categoryByIdMap.get(existingSvc.category.toString());

                                    // Phải đảm bảo Category này chưa được xử lý (link) với bất kỳ API Category nào khác trong đợt sync này
                                    if (candidateCat && !processedCategoryIds.has(candidateCat._id.toString())) {
                                        console.log(`🕵️‍♂️ Tìm thấy Category "${categoryName}" (gốc: "${candidateCat.name}") qua Service "${existingSvc.name}" (ID: ${svcId}).`);
                                        category = candidateCat;

                                        // Nếu tìm thấy, ta ưu tiên sử dụng nó ngay
                                        // Logic cập nhật ID và Platform sẽ được xử lý ở phần cập nhật bên dưới
                                        if (apiCategoryId) {
                                            categoryByIdSmm.set(apiCategoryId, category);
                                        }
                                        break;
                                    }
                                }
                            }
                        }

                        if (category) {
                            // Cập nhật
                            let hasChanges = false;

                            if (apiCategoryId && category.idSmm !== apiCategoryId) {
                                console.log(`🔗 Link ID SMM mới cho Category: ${apiCategoryId}`);
                                category.idSmm = apiCategoryId;
                                hasChanges = true;
                            }

                            if (category.name !== categoryName) {
                                console.log(`🔄 Rename Category: "${category.name}" -> "${categoryName}"`);
                                category.name = categoryName;
                                hasChanges = true;
                            }

                            // Quan trọng: Update Platform ID nếu đã di chuyển
                            if (category.platforms_id.toString() !== platform._id.toString()) {
                                console.log(`🔄 Move Category "${categoryName}" to Platform "${platformName}"`);
                                category.platforms_id = platform._id;
                                hasChanges = true;
                            }

                            if (Number(category.thutu) !== Number(categoryThutu)) {
                                category.thutu = categoryThutu;
                                hasChanges = true;
                            }

                            if (category.status !== categoryStatus) {
                                category.status = categoryStatus;
                                hasChanges = true;
                            }

                            if (category.path !== categoryPath) {
                                category.path = categoryPath;
                                hasChanges = true;
                            }

                            if (String(category.notes || '') !== String(categoryNotes)) {
                                category.notes = categoryNotes;
                                hasChanges = true;
                            }

                            if (String(category.modal_show || '') !== String(categoryModalShow)) {
                                category.modal_show = categoryModalShow;
                                hasChanges = true;
                            }

                            if (hasChanges) {
                                await category.save();
                                stats.categories.updated++;
                                console.log(`🔄 Cập nhật Category: ${categoryName}`);
                            }
                        } else {
                            // Tạo mới
                            category = await Category.create({
                                platforms_id: platform._id,
                                name: categoryName,
                                path: categoryPath,
                                status: categoryStatus,
                                thutu: categoryThutu,
                                notes: categoryNotes,
                                modal_show: categoryModalShow,
                                idSmm: apiCategoryId
                            });
                            stats.categories.created++;
                            console.log(`✅ Tạo mới Category: ${categoryName} (ID SMM: ${apiCategoryId})`);
                        }

                        // Đánh dấu đã xử lý category
                        processedCategoryIds.add(category._id.toString());
                        if (apiCategoryId) categoryByIdSmm.set(apiCategoryId, category); // Update current map

                        // 3. Xử lý Services
                        if (!Array.isArray(categoryData.services)) continue;

                        for (const serviceData of categoryData.services) {
                            try {
                                if (!serviceData.service_id || !serviceData.service_name) {
                                    continue;
                                }

                                const apiServiceIdStr = String(serviceData.service_id);
                                apiServiceIds.add(apiServiceIdStr);

                                // Tính giá với markup (Fix NaN bug using || 0)
                                const apiRate = Number(serviceData.rate) || 0;
                                const rateMember = Math.round(apiRate * (1 + Number(smmSv.price_update || 0) / 100) * 10000) / 10000;
                                const rateVip = Math.round(apiRate * (1 + Number(smmSv.price_updateVip || 0) / 100) * 10000) / 10000;
                                const rateDistributor = Math.round(apiRate * (1 + Number(smmSv.price_updateDistributor || 0) / 100) * 10000) / 10000;

                                let service = existingServicesMap.get(apiServiceIdStr);

                                if (service) {
                                    let hasChanges = false;

                                    if (service.type?.toString() !== platform._id.toString()) {
                                        service.type = platform._id;
                                        hasChanges = true;
                                    }
                                    if (service.category?.toString() !== category._id.toString()) {
                                        service.category = category._id;
                                        hasChanges = true;
                                    }

                                    // Check fields
                                    const updates = {
                                        serviceName: serviceData.service_name,
                                        name: serviceData.service_name,
                                        tocdodukien: serviceData.tocdodukien || "",
                                        luotban: Number(serviceData.luotban) || 0,
                                        maychu: serviceData.maychu || "",
                                        thutu: serviceData.thutu ? String(serviceData.thutu) : "4",
                                        getid: (serviceData.getid === true || serviceData.getid === "on") ? "on" : "off",
                                        comment: (serviceData.comment === true || serviceData.comment === "on") ? "on" : "off",
                                        description: serviceData.description || "",
                                        min: Number(serviceData.min) || 0,
                                        max: Number(serviceData.max) || 0,
                                        cancel: serviceData.cancel ? "on" : "off",
                                        refil: serviceData.refill ? "on" : "off",
                                        isActive: serviceData.isActive === true || serviceData.isActive === "on" ? true : false,
                                        status: serviceData.status === true || serviceData.status === "on" ? true : false
                                    };

                                    for (const [key, value] of Object.entries(updates)) {
                                        let currentValue = service[key];
                                        let newValue = value;
                                        if (key === 'min' || key === 'max' || key === 'luotban') {
                                            currentValue = Number(currentValue);
                                            newValue = Number(newValue);
                                        }
                                        if (typeof newValue === 'string') {
                                            currentValue = String(currentValue || '');
                                            newValue = String(newValue || '');
                                        }
                                        if (currentValue !== newValue) {
                                            service[key] = value;
                                            hasChanges = true;
                                        }
                                    }

                                    // Check price
                                    const previousOriginal = Number(service.originalRate) || 0;
                                    const dbRate = Number(service.rate);
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
                                        service.originalRate = apiRate;
                                        service.rate = rateMember;
                                        service.ratevip = rateVip;
                                        service.rateDistributor = rateDistributor;
                                        hasChanges = true;

                                        await sendPriceUpdateNotification(service, previousOriginal, newPrices, previousOriginal, apiRate, smmSv.name, direction);
                                        console.log(`💰 Giá thay đổi ${service.name}: ${previousOriginal} -> ${apiRate}`);
                                    }

                                    if (hasChanges) {
                                        await service.save();
                                        stats.services.updated++;
                                        console.log(`🔄 Service: ${service.name} updated`);
                                    }
                                } else {
                                    // New service
                                    const magoi = await generateMagoi();
                                    service = await Service.create({
                                        DomainSmm: smmSv._id,
                                        serviceName: serviceData.service_name,
                                        originalRate: apiRate,
                                        serviceId: apiServiceIdStr,
                                        category: category._id,
                                        type: platform._id,
                                        Magoi: magoi,
                                        maychu: serviceData.maychu || "",
                                        tocdodukien: serviceData.tocdodukien || "",
                                        luotban: Number(serviceData.luotban) || 0,
                                        thutu: serviceData.thutu ? String(serviceData.thutu) : "4",
                                        getid: (serviceData.getid === true || serviceData.getid === "on") ? "on" : "off",
                                        comment: (serviceData.comment === true || serviceData.comment === "on") ? "on" : "off",
                                        description: serviceData.description || "",
                                        name: serviceData.service_name,
                                        rate: rateMember,
                                        ratevip: rateVip,
                                        rateDistributor: rateDistributor,
                                        min: Number(serviceData.min) || 0,
                                        max: Number(serviceData.max) || 0,
                                        cancel: serviceData.cancel ? "on" : "off",
                                        refil: serviceData.refill ? "on" : "off",
                                        isActive: serviceData.isActive === true || serviceData.isActive === "on" ? true : false,
                                        status: serviceData.status === true || serviceData.status === "on" ? true : false,
                                    });
                                    stats.services.created++;
                                    console.log(`✅ New Service: ${service.name}`);
                                }

                            } catch (err) {
                                console.error(err);
                                stats.errors++;
                            }
                        }

                    } catch (err) {
                        console.error(err);
                        stats.errors++;
                    }
                }

            } catch (err) {
                console.error(err);
                stats.errors++;
            }
        }

        // 4. Cleanup
        // Vì user bảo "chỉ có 1 nguồn", nên ta có thể safely xóa những gì không có trong API

        // Clean Services
        for (const existingService of existingServices) {
            if (!apiServiceIds.has(String(existingService.serviceId))) {
                await Service.deleteOne({ _id: existingService._id });
                stats.services.deleted++;
                console.log(`🗑️ Deleted Service: ${existingService.name}`);
            }
        }

        // Clean Categories
        // Chỉ xóa những category nào không được processed trong lần sync này
        // (Điều này giả định DB chỉ chứa categories từ nguồn này, hoặc nguồn này cung cấp FULL danh sách)
        for (const existingCategory of existingCategories) {
            if (!processedCategoryIds.has(existingCategory._id.toString())) {
                // Xóa services kèm theo (cho chắc chắn)
                await Service.deleteMany({ category: existingCategory._id });
                await Category.deleteOne({ _id: existingCategory._id });
                stats.categories.deleted++;
                console.log(`🗑️ Deleted Category: ${existingCategory.name}`);
            }
        }

        // Clean Platforms
        for (const existingPlatform of existingPlatforms) {
            if (!processedPlatformIds.has(existingPlatform._id.toString())) {
                await Service.deleteMany({ type: existingPlatform._id });
                await Category.deleteMany({ platforms_id: existingPlatform._id });
                await Platform.deleteOne({ _id: existingPlatform._id });
                stats.platforms.deleted++;
                console.log(`🗑️ Deleted Platform: ${existingPlatform.name}`);
            }
        }

        console.log(`\n✅ Sync Completed [${smmSv.name}]`);
        console.log(`   Platforms: +${stats.platforms.created} ~${stats.platforms.updated} -${stats.platforms.deleted}`);
        console.log(`   Categories: +${stats.categories.created} ~${stats.categories.updated} -${stats.categories.deleted}`);
        console.log(`   Services: +${stats.services.created} ~${stats.services.updated} -${stats.services.deleted}`);

    } catch (error) {
        console.error(`❌ Sync Error:`, error.message);
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
