const ConfigCard = require("../../models/ConfigCard");

// Lấy cấu hình thẻ nạp
exports.getConfigCard = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có quyền truy cập' });
    }
    let config = await ConfigCard.findOne();

    // Nếu chưa có cấu hình, trả về dữ liệu rỗng
    if (!config) {
      config = {
        API_URLCARD: "",
        PARTNER_ID: "",
        PARTNER_KEY: "",
      };
    }

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error("Lỗi khi lấy cấu hình thẻ nạp:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// Cập nhật cấu hình thẻ nạp
exports.updateConfigCard = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có quyền truy cập' });
    }
    const { API_URLCARD, PARTNER_ID, PARTNER_KEY } = req.body;

    let config = await ConfigCard.findOne();

    // Nếu chưa có cấu hình, tạo mới cấu hình
    if (!config) {
      config = new ConfigCard({
        API_URLCARD: API_URLCARD || "",
        PARTNER_ID: PARTNER_ID || "",
        PARTNER_KEY: PARTNER_KEY || "",
      });
    } else {
      // Cập nhật cấu hình hiện tại
      config.API_URLCARD = API_URLCARD || config.API_URLCARD;
      config.PARTNER_ID = PARTNER_ID || config.PARTNER_ID;
      config.PARTNER_KEY = PARTNER_KEY || config.PARTNER_KEY;
    }

    await config.save();
    res.status(200).json({ success: true, message: "Cấu hình thẻ nạp được cập nhật thành công", data: config });
  } catch (error) {
    console.error("Lỗi khi cập nhật cấu hình thẻ nạp:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};