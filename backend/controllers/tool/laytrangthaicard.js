const axios = require("axios");
const Card = require("../../models/Card");
const ConfigCard = require("../../models/ConfigCard"); // Import mô hình ConfigCard

// Hàm lấy trạng thái thẻ và lưu vào DB
async function fetchAndSaveCardStatus() {
    try {
        // Lấy cấu hình từ ConfigCard
        const configCard = await ConfigCard.findOne();
        if (!configCard) {
            console.error("Cấu hình thẻ nạp không tồn tại");
            return;
        }

        const partner_id = configCard.PARTNER_ID;
        const api_urlcard = `${configCard.API_URLCARD}/chargingws/v2`;
        const RATE = configCard.RATE || 5; // Lấy tỷ lệ chiết khấu, mặc định 5 nếu không có
        // Tạo URL API
        const apiUrl = `${api_urlcard}/getfee?partner_id=${partner_id}`;
        const response = await axios.get(apiUrl);

        if (!response.data || !Array.isArray(response.data)) {
            console.error("API trả về dữ liệu không hợp lệ:", response.data);
            return;
        }
        // console.log("Đã nhận dữ liệu từ API thẻ:", response.data);
        // Tạo Set để lưu các cặp telco+value từ API
        const apiCards = new Set();

        for (const item of response.data) {
            const key = `${item.telco}_${item.value}`;
            apiCards.add(key);

            const newFees = (Number(item.fees) || 30) + RATE;
            const newPenalty = Number(item.penalty);

            // Kiểm tra xem thẻ đã tồn tại chưa
            const existingCard = await Card.findOne({ telco: item.telco, value: item.value });

            if (existingCard) {
                // Chỉ cập nhật nếu fees hoặc penalty thay đổi
                if (existingCard.fees !== newFees || existingCard.penalty !== newPenalty) {
                    await Card.findOneAndUpdate(
                        { telco: item.telco, value: item.value },
                        {
                            fees: newFees,
                            penalty: newPenalty,
                        },
                        { new: true }
                    );
                    console.log(`🔄 Cập nhật thẻ ${item.telco} - ${item.value}: fees ${existingCard.fees} -> ${newFees}`);
                }
            } else {
                // Thêm mới nếu chưa tồn tại
                await Card.create({
                    telco: item.telco,
                    value: item.value,
                    fees: newFees,
                    penalty: newPenalty,
                });
                console.log(`✅ Thêm mới thẻ: ${item.telco} - ${item.value}`);
            }
        }

        // Xóa các thẻ không còn tồn tại ở nguồn
        const existingCards = await Card.find({});
        for (const card of existingCards) {
            const key = `${card.telco}_${card.value}`;
            if (!apiCards.has(key)) {
                await Card.deleteOne({ _id: card._id });
                console.log(`🗑️ Đã xóa thẻ không còn ở nguồn: ${card.telco} - ${card.value}`);
            }
        }

        console.log(`Đã cập nhật trạng thái thẻ từ API, tổng: ${response.data.length}`);
    } catch (error) {
        console.error("Lỗi khi lấy trạng thái thẻ:", error.message);
    }
}

// Cronjob: chạy mỗi 1 phút
setInterval(fetchAndSaveCardStatus, 60 * 1000);

// Nếu muốn chạy ngay khi khởi động:
fetchAndSaveCardStatus();

module.exports = { fetchAndSaveCardStatus };