
const SmmSv = require('../../models/SmmSv'); // Model chứa thông tin cấu hình SMM
const SmmApiService = require('./smmServices'); // hoặc đường dẫn tương ứng

exports.getBalance = async (req, res) => {
  try {
    // Lấy id từ req.params
    const { id } = req.params;

    // Tìm cấu hình SMM theo id
    const smmConfig = await SmmSv.findById(id);
    if (!smmConfig || smmConfig.status !== 'on') {
      return res.status(404).json({ success: false, message: 'Không tìm thấy cấu hình SMM đang hoạt động' });
    }

    // Tạo instance của SmmApiService
    const smmService = new SmmApiService(smmConfig.url_api, smmConfig.api_token);

    // Gọi phương thức balance để lấy số dư
    const balanceData = await smmService.balance();

    res.status(200).json({ success: true, data: balanceData });
  } catch (error) {
    console.error('Lỗi khi lấy số dư:', error.message);
    res.status(500).json({ success: false, message: 'Lỗi server', error: error.message });
  }
};

exports.getServices = async (req, res) => {
  try {
    // Lấy id từ req.params
    const { id } = req.params;

    // Tìm cấu hình SMM theo id
    const smmConfig = await SmmSv.findById(id);
    if (!smmConfig || smmConfig.status !== 'on') {
      return res.status(404).json({ success: false, message: 'Không tìm thấy cấu hình SMM đang hoạt động' });
    }

    // Tạo instance của SmmApiService
    const smmService = new SmmApiService(smmConfig.url_api, smmConfig.api_token);

    // Gọi phương thức services để lấy danh sách dịch vụ
    const servicesData = await smmService.services();

    res.status(200).json({ success: true, data: servicesData });
  } catch (error) {
    console.error('Lỗi khi lấy danh sách dịch vụ:', error.message);
    res.status(500).json({ success: false, message: 'Lỗi server', error: error.message });
  }
};