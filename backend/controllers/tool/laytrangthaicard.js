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

        // Tạo URL API
        const apiUrl = `${api_urlcard}/getfee?partner_id=${partner_id}`;
        const response = await axios.get(apiUrl);

        if (!response.data || !Array.isArray(response.data)) {
            console.error("API trả về dữ liệu không hợp lệ:", response.data);
            return;
        }

        for (const item of response.data) {
            // Cập nhật hoặc thêm mới theo telco + value
            await Card.findOneAndUpdate(
                { telco: item.telco, value: item.value },
                {
                    telco: item.telco,
                    value: item.value,
                    fees: (Number(item.fees) || 30) + 5, // Cộng thêm 5 vào fees
                    penalty: Number(item.penalty),
                },
                { upsert: true, new: true }
            );
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