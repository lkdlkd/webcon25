const Service = require('../../models/server');
const Category = require('../../models/Category');
const User = require('../../models/User');

// Thêm dịch vụ mới (chỉ admin)
const Counter = require("../../models/Counter"); // Import model Counter
const Configweb = require('../../models/Configweb');
const SmmSv = require('../../models/SmmSv');
// Helper: lấy đơn giá theo cấp bậc user (member/vip)
function getEffectiveRate(service, user) {
  try {
    const base = Number(service?.rate || 0);
    const vip = Number(service?.ratevip || 0);
    const distributor = Number(service?.rateDistributor || 0);
    const level = (user?.capbac || 'member').toLowerCase();
    if (level === 'vip' && vip > 0) return vip;
    if (level === 'distributor' && distributor > 0) return distributor;
    return base;
  } catch (_) {
    return Number(service?.rate || 0);
  }
}

exports.addServer = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền sử dụng chức năng này" });
    }

    // Lấy giá trị Magoi tiếp theo từ bộ đếm
    const counter = await Counter.findOneAndUpdate(
      { name: "Magoi" },
      { $inc: { value: 1 } },
      { new: true, upsert: true } // Tạo mới nếu chưa tồn tại
    );
    // Gán giá trị Magoi tự động tăng
    let rate = req.body.rate;
    if (typeof rate === 'number') {
      rate = Math.round(rate * 10000) / 10000;
    }
    let ratevip = req.body.ratevip;
    if (typeof ratevip === 'number') {
      ratevip = Math.round(ratevip * 10000) / 10000;
    } else {
      ratevip = rate; // Nếu không có ratevip, gán bằng rate thường
    }
    // Tính rateDistributor: ưu tiên body, nếu không có thì theo ratevip, sau đó rate
    let rateDistributor = req.body.rateDistributor;
    if (typeof rateDistributor === 'number') {
      rateDistributor = Math.round(rateDistributor * 10000) / 10000;
    } else {
      rateDistributor = rate;
    }

    // Nếu ordertay = true, tự động sinh các trường bắt buộc
    let serviceData = {
      ...req.body,
      rate,
      ratevip,
      rateDistributor,
      Magoi: counter.value,
    };  

    if (req.body.ordertay === true) {
      // Tìm hoặc tạo SmmSv "Đơn tay"
      let smmDonTay = await SmmSv.findOne({ ordertay: true });
      if (!smmDonTay) {
        smmDonTay = await SmmSv.create({
          name: "Đơn tay",
          url_api: "https://manual-order.local",
          api_token: "manual_token_placeholder",
          status: "on",
          update_price: "off",
          autohoan: "off",
          ordertay: true,
        });
      }
      
      // Tự động gán các trường với thông tin giả
      serviceData.DomainSmm = smmDonTay._id;
      serviceData.serviceName = serviceData.name || `Dịch vụ ${counter.value}`;
      serviceData.originalRate = rateDistributor;
      serviceData.serviceId = `manual_${counter.value}`;
    }

    const newService = new Service(serviceData);

    await newService.save();
    res.status(201).json({ success: true, message: "Dịch vụ được thêm thành công", data: newService });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi thêm dịch vụ", error: error.message });
  }
};
// Lấy danh sách dịch vụ (admin có phân trang, user thường chỉ lấy dịch vụ đang hoạt động)
exports.getServer = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: "Không xác thực được người dùng" });
    }
    if (user.role === "admin") {
      const search = req.query.search ? req.query.search.trim() : "";
      let filter = {};

      // Tạo bộ lọc tìm kiếm
      if (search) {
        filter = {
          $or: [
            { Magoi: { $regex: search, $options: "i" } },
            { serviceId: { $regex: search, $options: "i" } },
          ],
        };
      }
      // Admin: có thể xem tất cả dịch vụ với phân trang
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 1000000;
      const skip = (page - 1) * limit;

      const totalServices = await Service.countDocuments(filter);
      let services = await Service.find(filter)
        .populate("category", "name path thutu")
        .populate("type", "name logo thutu")
        .populate("DomainSmm", "name")
        .skip(skip)
        .limit(limit);

      // Sort order strictly: type.thutu -> category.thutu -> service.thutu
      services = services.sort((a, b) => {
        const ta = a.type?.thutu ?? 999999;
        const tb = b.type?.thutu ?? 999999;
        if (ta !== tb) return ta - tb;
        const cta = a.category?.thutu ?? 999999;
        const ctb = b.category?.thutu ?? 999999;
        if (cta !== ctb) return cta - ctb;
        const sta = typeof a.thutu === 'number' ? a.thutu : 999999;
        const stb = typeof b.thutu === 'number' ? b.thutu : 999999;
        return sta - stb;
      });

      const formattedServices = services.map(service => ({
        _id: service._id,
        // Sử dụng optional chaining để tránh lỗi khi không có DomainSmm được populate
        DomainSmm: service.DomainSmm?.name || "Không xác định",
        serviceName: service.serviceName,
        originalRate: service.originalRate,
        category: service.category ? service.category.name : "Không xác định",
        description: service.description,
        Magoi: service.Magoi,
        thutu: service.thutu,
        type: service.type ? service.type.name : "không xác định",
        name: service.name,
        // Tránh lỗi khi category có thể không tồn tại
        path: service.category?.path || "",
        rate: service.rate,
        ratevip: service.ratevip,
        rateDistributor: service.rateDistributor,
        maychu: service.maychu,
        min: service.min,
        max: service.max,
        Linkdv: service.Linkdv,
        serviceId: service.serviceId,
        getid: service.getid,
        comment: service.comment,
        reaction: service.reaction,
        matlive: service.matlive,
        isActive: service.isActive,
        status: service.status,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        tocdodukien: service.tocdodukien || "Chưa cập nhật",
        logo: service.type ? service.type.logo : "",
        refil: service.refil,
        cancel: service.cancel,
        ischeck: service.ischeck,
        ordertay: service.ordertay
      }));

      return res.status(200).json({
        success: true,
        data: formattedServices,
        pagination: {
          totalItems: totalServices,
          currentPage: page,
          totalPages: Math.ceil(totalServices / limit),
          pageSize: formattedServices.length,
        },
      });
    } else {
      let services = await Service.find({ isActive: true, status: true })
        .populate("category", "name path thutu")
        .populate("type", "name logo thutu");

      services = services.sort((a, b) => {
        const ta = a.type?.thutu ?? 999999;
        const tb = b.type?.thutu ?? 999999;
        if (ta !== tb) return ta - tb;
        const cta = a.category?.thutu ?? 999999;
        const ctb = b.category?.thutu ?? 999999;
        if (cta !== ctb) return cta - ctb;
        const sta = typeof a.thutu === 'number' ? a.thutu : 999999;
        const stb = typeof b.thutu === 'number' ? b.thutu : 999999;
        return sta - stb;
      });

      const formattedServices = services.map(service => ({
        description: service.description,
        path: service.category?.path || "",
        Magoi: service.Magoi,
        id: service.id,
        maychu: service.maychu,
        getid: service.getid,
        comment: service.comment,
        reaction: service.reaction,
        matlive: service.matlive,
        name: service.name,
        rate: getEffectiveRate(service, user),
        ratevip: service.ratevip,
        rateDistributor: "x",
        min: service.min,
        max: service.max,
        type: service.type ? service.type.name : "không xác định",
        category: service.category?.name || "Không xác định",
        tocdodukien: service.tocdodukien || "Chưa cập nhật",
        logo: service.type ? service.type.logo : "",
        isActive: service.isActive,
        updatedAt: service.updatedAt,
        refil: service.refil,
        cancel: service.cancel,
      }));

      return res.status(200).json({ success: true, data: formattedServices });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Lỗi khi lấy danh sách dịch vụ",
      error: error.message,
    });
  }
};

// Cập nhật dịch vụ (chỉ admin)
exports.updateServer = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: 'Chỉ admin mới có quyền sử dụng chức năng này' });
    }

    let updateData = { ...req.body };
    if (typeof updateData.rate === 'number') {
      updateData.rate = Math.round(updateData.rate * 10000) / 10000;
    }
    if (typeof updateData.ratevip === 'number') {
      updateData.ratevip = Math.round(updateData.ratevip * 10000) / 10000;
    } else if (typeof updateData.rate === 'number') {
      updateData.ratevip = updateData.rate; // Nếu không có ratevip, gán bằng rate thường
    }
    if (typeof updateData.rateDistributor === 'number') {
      updateData.rateDistributor = Math.round(updateData.rateDistributor * 10000) / 10000;
    } else if (typeof updateData.rate === 'number') {
      updateData.rateDistributor = updateData.rate; // Nếu không có rateDistributor, gán bằng rate thường
    }
    const updatedService = await Service.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!updatedService) {
      return res.status(404).json({ success: false, message: 'Dịch vụ không tồn tại' });
    }
    res.status(200).json({ success: true, message: 'Cập nhật dịch vụ thành công', data: updatedService });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Lỗi khi cập nhật dịch vụ', error: error.message });
  }
};

// Xóa dịch vụ (chỉ admin)
exports.deleteServer = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: 'Chỉ admin mới có quyền sử dụng chức năng này' });
    }

    const deletedService = await Service.findByIdAndDelete(req.params.id);
    if (!deletedService) {
      return res.status(404).json({ success: false, message: 'Dịch vụ không tồn tại' });
    }
    res.status(200).json({ success: true, message: 'Xóa dịch vụ thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi khi xóa dịch vụ', error: error.message });
  }
};

exports.getServerByTypeAndPath = async (req, res) => {
  try {
    const { path } = req.query;
    const user = req.user || null;

    if (!path) {
      return res.status(400).json({ success: false, message: "Thiếu tham số path" });
    }

    // Tìm category theo path trước rồi lấy _id
    // Ưu tiên khớp chính xác theo path (không phân biệt hoa/thường)
    const category = await Category.findOne({ path: { $regex: `^${path}$`, $options: 'i' } });

    if (!category) {
      return res.status(200).json({ success: true, notes: { note: "", modal_show: "" }, data: [] });
    }

    // Lấy cấu hình website để kiểm tra viewluotban
    const config = await Configweb.findOne();

    // Lấy danh sách dịch vụ theo category._id và chỉ lấy dịch vụ đang hoạt động
    let services = await Service.find({ category: category._id, status: true })
      .populate("category", "name path thutu")
      .populate("type", "name logo thutu")
      .sort("thutu");
    // Thêm thông tin server vào từng dịch vụ
    // Sắp xếp theo thutu tăng dần
    services = services.sort((a, b) => {
      const sa = typeof a.thutu === 'number' ? a.thutu : 999999;
      const sb = typeof b.thutu === 'number' ? b.thutu : 999999;
      return sa - sb;
    });

    const formattedServices = services.map(service => {
      const baseService = {
        description: service.description,
        Magoi: service.Magoi,
        id: service.id,
        maychu: service.maychu,
        name: service.name,
        rate: getEffectiveRate(service, user),
        min: service.min,
        max: service.max,
        getid: service.getid,
        comment: service.comment,
        reaction: service.reaction,
        matlive: service.matlive,
        type: service.type ? service.type.name : "không xác định",
        category: service.category?.name || "Không xác định",
        path: service.category?.path || "",
        isActive: service.isActive,
        tocdodukien: service.tocdodukien || "Chưa cập nhật",
        updatedAt: service.updatedAt,
        refil: service.refil,
        cancel: service.cancel,
      };

      // Chỉ hiển thị luotban nếu config.viewluotban là true
      if (config && config.viewluotban) {
        baseService.luotban = service.luotban || 0;
      }

      return baseService;
    });

    return res.status(200).json({
      success: true,
      category: category.name,
      notes: { note: category.notes || "", modal_show: category.modal_show || "" },
      data: formattedServices,
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách dịch vụ theo path:", error);
    return res.status(500).json({
      success: false,
      message: "Lỗi khi lấy danh sách dịch vụ",
      error: error.message,
    });
  }
};