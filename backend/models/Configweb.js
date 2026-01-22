const mongoose = require("mongoose");

const configwebSchema = new mongoose.Schema({
  tieude: { type: String, default: "" },
  title: { type: String, default: "" },
  logo: { type: String, default: "" },
  favicon: { type: String, default: "" },
  linktele: { type: String, default: "" },
  cuphap: { type: String, default: "" },
  daily: { type: Number, default: 1000000 }, // hoa hồng đại lý
  distributor: { type: Number, default: 10000000 }, // hoa hồng nhà phân phối
  viewluotban: { type: Boolean, default: false }, // hiển thị lượt bán trên dịch vụ
  autoactive: { type: Boolean, default: false }, // tự động cập nhật trạng thái server
  autoremove: { type: Boolean, default: false }, // tự động xóa trên 3 tháng
  autoDeleteMonths: { type: Number, default: 3 }, // số tháng để xóa
  deleteOrders: { type: Boolean, default: false }, // xóa đơn hàng
  deleteUsers: { type: Boolean, default: false }, // xóa user
  deleteHistory: { type: Boolean, default: false }, // xóa lịch sử
  headerJs: { type: String, default: "" }, // mã js header
  footerJs: { type: String, default: "" }, // mã js footer
  tigia: { type: Number, default: 25000 }, // tỷ giá
  notenaptien: { type: String, default: "" }, // ghi chú nạp tiền
  lienhe: [
    {
      type: { type: String, default: "" },
      value: { type: String, default: "" },
      logolienhe: { type: String, default: "" },
    },
  ],
  domain: { type: String, default: null },

  // Affiliate configuration
  affiliateEnabled: { type: Boolean, default: false }, // Bật/tắt chức năng affiliate
  affiliateMinDeposit: { type: Number, default: 50000 }, // Mức nạp tối thiểu để tính hoa hồng (VNĐ)
  affiliateCommissionPercent: { type: Number, default: 1 }, // 1% hoa hồng affiliate

}, { timestamps: true });

module.exports = mongoose.model("Configweb", configwebSchema);