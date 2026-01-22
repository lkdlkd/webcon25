const Configweb = require("../../models/Configweb");

// Lấy thông tin cấu hình website
exports.getConfigweb = async (req, res) => {
  try {
    let config = await Configweb.findOne();

    // Nếu chưa có cấu hình, tạo một cấu hình mặc định
    if (!config) {
      config = new Configweb({
        tieude: "",
        logo: "",
        favicon: "",
        linktele: "",
        title: "",
        daily: 1000000,
        distributor: 10000000,
        viewluotban: false,
        autoactive: false,
        autoremove: false,
        deleteOrders: false,
        deleteUsers: false,
        deleteHistory: false,
        autoDeleteMonths: 3,
        tigia: 25000,
        notenaptien: "",
        headerJs: "",
        footerJs: "",
        lienhe: [
          {
            type: "",
            value: "",
            logolienhe: "",
          },
        ],
        cuphap: "", // Thêm giá trị mặc định cho cuphap
      });
      await config.save();
    }

    // Chuẩn bị dữ liệu trả về
    const responseData = {
      tieude: config.tieude,
      title: config.title,
      logo: config.logo,
      favicon: config.favicon,
      linktele: config.linktele,
      cuphap: config.cuphap,
      daily: config.daily,
      distributor: config.distributor,
      lienhe: config.lienhe,
      domain: config.domain,
      headerJs: config.headerJs,
      footerJs: config.footerJs,
      tigia: config.tigia,
      notenaptien: config.notenaptien,
      affiliateMinDeposit: config.affiliateMinDeposit,
      affiliateCommissionPercent: config.affiliateCommissionPercent,
    };

    // Chỉ hiển thị các fields admin nếu user là admin
    const user = req.user;
    if (user && user.role === 'admin') {
      responseData.viewluotban = config.viewluotban;
      responseData.autoactive = config.autoactive;
      responseData.autoremove = config.autoremove;
      responseData.autoDeleteMonths = config.autoDeleteMonths;
      responseData.deleteOrders = config.deleteOrders;
      responseData.deleteUsers = config.deleteUsers;
      responseData.deleteHistory = config.deleteHistory;
      // Affiliate config
      responseData.affiliateEnabled = config.affiliateEnabled;
      // Withdrawal config
      responseData.withdrawMinAmount = config.withdrawMinAmount;
      responseData.withdrawMaxAmount = config.withdrawMaxAmount;
      responseData.withdrawFeePercent = config.withdrawFeePercent;
      responseData.withdrawFeeFixed = config.withdrawFeeFixed;
      responseData.withdrawToBankEnabled = config.withdrawToBankEnabled;
      responseData.withdrawToBalanceEnabled = config.withdrawToBalanceEnabled;
    }

    res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Lỗi khi lấy cấu hình website:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// Lấy thông tin cấu hình website
exports.getConfigwebLogo = async (req, res) => {
  try {
    let config = await Configweb.findOne();

    // Nếu chưa có cấu hình, tạo một cấu hình mặc định
    if (!config) {
      config = new Configweb({
        tieude: "",
        logo: "/img/favicon.png",
        favicon: "",
        linktele: "",
        title: "",
        daily: 1000000,
        distributor: 10000000,
        viewluotban: false,
        autoactive: false,
        autoremove: false,
        deleteOrders: false,
        deleteUsers: false,
        deleteHistory: false,
        autoDeleteMonths: 3,
        headerJs: "",
        footerJs: "",
        tigia: 25000,
        notenaptien: "",
        lienhe: [
          {
            type: "",
            value: "",
            logolienhe: "",
          },
        ],
        cuphap: "", // Thêm giá trị mặc định cho cuphap
      });
      await config.save();
    }

    // Chuẩn bị dữ liệu trả về
    const responseData = {
      logo: config.logo,
      tigia: config.tigia,
    };

    res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Lỗi khi lấy cấu hình website:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};
// Cập nhật cấu hình website
exports.updateConfigweb = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có quyền truy cập' });
    }
    const { tieude, title, logo, favicon, lienhe, cuphap, linktele, daily, distributor, viewluotban, autoactive, autoremove, autoDeleteMonths, deleteOrders, deleteUsers, deleteHistory, tigia, notenaptien, affiliateEnabled, affiliateMinDeposit, affiliateCommissionPercent, withdrawMinAmount, withdrawMaxAmount, withdrawFeePercent, withdrawFeeFixed, withdrawToBankEnabled, withdrawToBalanceEnabled } = req.body;

    // Tìm cấu hình hiện tại
    const config = await Configweb.findOne();

    if (!config) {
      return res.status(404).json({ success: false, message: "Cấu hình website không tồn tại" });
    }

    // Kiểm tra và parse dữ liệu lienhe
    if (lienhe && !Array.isArray(lienhe)) {
      return res.status(400).json({ success: false, message: "Dữ liệu lienhe phải là một mảng" });
    }

    // Cập nhật cấu hình - Chỉ cập nhật field khi nó được gửi lên (không undefined)
    // Giữ nguyên giá trị hiện tại nếu field không được gửi
    if (tieude !== undefined) config.tieude = tieude;
    if (title !== undefined) config.title = title;
    if (logo !== undefined) config.logo = logo;
    if (daily !== undefined) config.daily = daily;
    if (distributor !== undefined) config.distributor = distributor;
    if (favicon !== undefined) config.favicon = favicon;
    if (lienhe !== undefined) config.lienhe = lienhe;
    if (cuphap !== undefined) config.cuphap = cuphap;
    if (linktele !== undefined) config.linktele = linktele;
    if (viewluotban !== undefined) config.viewluotban = viewluotban;
    if (autoactive !== undefined) config.autoactive = autoactive;
    if (autoremove !== undefined) config.autoremove = autoremove;
    if (autoDeleteMonths !== undefined) config.autoDeleteMonths = autoDeleteMonths;
    if (deleteOrders !== undefined) config.deleteOrders = deleteOrders;
    if (deleteUsers !== undefined) config.deleteUsers = deleteUsers;
    if (deleteHistory !== undefined) config.deleteHistory = deleteHistory;
    if (req.body.headerJs !== undefined) config.headerJs = req.body.headerJs;
    if (req.body.footerJs !== undefined) config.footerJs = req.body.footerJs;
    if (tigia !== undefined) config.tigia = tigia;
    if (notenaptien !== undefined) config.notenaptien = notenaptien;
    // Affiliate config
    if (affiliateEnabled !== undefined) config.affiliateEnabled = affiliateEnabled;
    if (affiliateMinDeposit !== undefined) config.affiliateMinDeposit = affiliateMinDeposit;
    if (affiliateCommissionPercent !== undefined) config.affiliateCommissionPercent = affiliateCommissionPercent;
    // Withdrawal config
    if (withdrawMinAmount !== undefined) config.withdrawMinAmount = withdrawMinAmount;
    if (withdrawMaxAmount !== undefined) config.withdrawMaxAmount = withdrawMaxAmount;
    if (withdrawFeePercent !== undefined) config.withdrawFeePercent = withdrawFeePercent;
    if (withdrawFeeFixed !== undefined) config.withdrawFeeFixed = withdrawFeeFixed;
    if (withdrawToBankEnabled !== undefined) config.withdrawToBankEnabled = withdrawToBankEnabled;
    if (withdrawToBalanceEnabled !== undefined) config.withdrawToBalanceEnabled = withdrawToBalanceEnabled;
    await config.save();

    res.status(200).json({ success: true, message: "Cấu hình website được cập nhật thành công", data: config });
  } catch (error) {
    console.error("Lỗi khi cập nhật cấu hình website:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// Xóa dữ liệu cũ thủ công (API cho admin)
exports.manualDeleteOldData = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Chỉ admin mới có quyền thực hiện' });
    }

    // Import hàm xóa
    const { autoDeleteOldData } = require('../tool/autoDeleteOldData');

    // Gọi hàm xóa (async nhưng không chờ để trả response ngay)
    autoDeleteOldData()
      .then(() => {
        console.log('✅ Xóa thủ công hoàn tất');
      })
      .catch((error) => {
        console.error('❌ Lỗi khi xóa thủ công:', error);
      });

    res.status(200).json({
      success: true,
      message: 'Đã bắt đầu xóa dữ liệu cũ. Kiểm tra console để xem tiến trình.'
    });
  } catch (error) {
    console.error("Lỗi khi xóa dữ liệu:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};
