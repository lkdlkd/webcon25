const mongoose = require('mongoose');
const Order = require('./Order'); // Import model Order

const serviceSchema = new mongoose.Schema({
  //tt bên thứ 3
  DomainSmm: { type: mongoose.Schema.Types.ObjectId, ref: "SmmSv", required: true },//bên thứ 3 lấy từ smmsv
  serviceName: { type: String, required: false },//sv name ở bên thứ 3
  originalRate: { type: Number, required: true },//giá lấy bên thứ 3
  // loai dv 
  category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true }, // Tham chiếu đến Category
  type: { type: mongoose.Schema.Types.ObjectId, ref: "Platform", required: true },
  description: { type: String, required: false },//mô tả sv
  //server
  Magoi: { type: String, required: true },// ma goi moi khi them
  name: { type: String, required: true },// tăng like tiktok, tăng view titkok
  rate: { type: Number, required: true },//giá lấy bên thứ 3* với smmPartner.price_update,
  ratevip: { type: Number, required: false },//giá vip
  rateDistributor: { type: Number, required: false },//giá distributor
  maychu: { type: String, required: false },//sv1
  min: { type: Number, required: true },//min lấy bên thứ 3
  max: { type: Number, required: true },//max lấy bên thứ 3
  Linkdv: { type: String, required: false },//facebook-like, tiktok-view... // ko tác dụng
  tocdodukien: { type: String, required: false },//tốc độ dự kiến
  luotban: { type: Number, default: 0 },//lượt bán
  chietkhau: { type: Number, required: false , default: 0 },//chiết khấu %
  serviceId: { type: String, required: true },//sv ở bên thứ 3
  thutu: { type: String, required: false , default: 4 },// thứ tự
  //option
  refil: { type: String, enum: ["on", "off"], default: "off" },//chức năng refil
  cancel: { type: String, enum: ["on", "off"], default: "off" },//chức năng hủy đơn
  getid: { type: String, enum: ["on", "off"], default: "on" },//chức năng get id sau khi nhập link mua
  comment: { type: String, enum: ["on", "off"], default: "off" },//chức năng get id sau khi nhập link mua
  reaction: { type: String, enum: ["on", "off"], default: "off" },//chức năng get id sau khi nhập link mua
  matlive: { type: String, enum: ["on", "off"], default: "off" },//chức năng get id sau khi nhập link mua
  ischeck: { type: Boolean, default: false }, // đã kiểm tra dịch vụ
  isActive: { type: Boolean, default: true }, // Hiển thị hoặc ẩn dịch vụ
  status: { type: Boolean, default: true }, // Trạng thái dịch vụ
  ordertay: { type: Boolean, default: false }, // Đơn hàng tay
  domain: { type: String, default: null },
}, { timestamps: true }); // Thêm createdAt và updatedAt tự động

// Hàm cập nhật tốc độ dự kiến cho tất cả dịch vụ có trong Order
serviceSchema.statics.updateAllTocDoDuKien = async function () {
  // Lấy tất cả Magoi duy nhất trong Order
  const combos = await Order.aggregate([
    { $group: { _id: { Magoi: "$Magoi" } } }
  ]);
  const results = [];
  for (const combo of combos) {
    const { Magoi } = combo._id;
    const tocdo = await this.updateTocDoDuKien(Magoi);
    results.push({ Magoi, tocdo });
  }
  return results;
};
serviceSchema.statics.updateTocDoDuKien = async function (magoi) {
  // Lấy 5 đơn gần nhất trong 3 ngày
  const sinceDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  let orderQuery = {
    Magoi: magoi,
    status: 'Completed',
    createdAt: { $gte: sinceDate },
  };

  let orders = await Order.find(orderQuery)
    .sort({ updatedAt: -1 })
    .limit(5)
    .lean();

  // Lọc chỉ lấy đơn có dachay >= quantity
  orders = orders.filter(order => {
    const soLuong = Number(order.dachay || order.quantity || 0);
    const soLuongGoc = Number(order.quantity || 0);
    return soLuong >= soLuongGoc;
  });
  let avgSpeedStr = '';

  // Nếu không có đơn nào hợp lệ, cập nhật và trả về "Chưa cập nhật"
  const updateQuery = { Magoi: magoi };
  if (!orders.length) {
    await this.updateOne(updateQuery, { tocdodukien: "Chưa cập nhật" });
    return "Chưa cập nhật";
  }

  let totalSoLuong = 0;
  let totalTimeSeconds = 0;

  for (const order of orders) {
    const { createdAt, updatedAt, dachay, quantity } = order;
    if (!createdAt || !updatedAt) continue;
    const timeMs = new Date(updatedAt) - new Date(createdAt);
    if (isNaN(timeMs) || timeMs <= 0) continue;
    const soLuong = Number(dachay || quantity || 0);
    if (!soLuong || isNaN(soLuong) || soLuong <= 0) continue;
    totalTimeSeconds += timeMs / 1000;
    totalSoLuong += soLuong;
  }

  if (totalSoLuong === 0 || totalTimeSeconds === 0) {
    await this.updateOne(updateQuery, { tocdodukien: "Chưa cập nhật" });
    return "Chưa cập nhật";
  }

  const secondsPer1000 = (totalTimeSeconds / totalSoLuong) * 1000;
  if (!isFinite(secondsPer1000)) {
    await this.updateOne(updateQuery, { tocdodukien: "Chưa cập nhật" });
    return "Chưa cập nhật";
  }

  const amountPerHour = Math.round((3600 / secondsPer1000) * 1000);

  // Format thời gian về dạng "Xh Ym Zs"
  const hours = Math.floor(secondsPer1000 / 3600);
  const minutes = Math.floor((secondsPer1000 % 3600) / 60);
  const seconds = Math.floor(secondsPer1000 % 60);

  if (hours > 0) avgSpeedStr += `${hours}h `;
  if (minutes > 0 || hours > 0) avgSpeedStr += `${minutes}m `;
  avgSpeedStr += `${seconds}s/1000`;
  avgSpeedStr += `  ( số lượng ~${amountPerHour.toLocaleString()}/h)`;

  // Cập nhật vào field `tocdodukien`
  // const updateQuery = { Magoi: magoi };
  await this.updateOne(updateQuery, { tocdodukien: avgSpeedStr });
  return avgSpeedStr;
};

// // Migration script (optional)
// await Service.updateMany(
//     { DomainSmm: { $type: "string" } }, // Tìm những cái là string
//     [{ $set: { DomainSmm: { $toObjectId: "$DomainSmm" } } }] // Convert sang ObjectId
// ); 

module.exports = mongoose.model('Service', serviceSchema);
