const Category = require("../../models/Category");
const Platform = require("../../models/platform");

// Escape regex special chars for exact, case-insensitive match
function escapeRegex(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Thêm category mới (chỉ admin)
exports.addCategory = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền thực hiện thao tác này" });
    }

    let { platforms_id, name, path, notes, modal_show, status, thutu } = req.body; // Thêm thutu

    // Kiểm tra xem Platform có tồn tại không
    const platform = await Platform.findById(platforms_id);
    if (!platform) {
      return res.status(404).json({ success: false, message: "Platform không tồn tại" });
    }

    // Chuẩn hóa path
    if (typeof path === 'string') {
      path = path.trim();
    }

    // Kiểm tra path đã tồn tại (không phân biệt hoa/thường)
    if (path) {
      const dup = await Category.findOne({ path: { $regex: `^${escapeRegex(path)}$`, $options: 'i' } });
      if (dup) {
        return res.status(400).json({ success: false, message: "Path đã tồn tại, vui lòng chọn path khác" });
      }
    }

    // Tạo category mới
    const newCategory = new Category({
      platforms_id,
      name,
      path,
      notes,
      modal_show,
      status,
      thutu, // Thêm thutu
    });

    await newCategory.save();
    res.status(201).json({ success: true, message: "Category được thêm thành công", data: newCategory });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi thêm Category", error: error.message });
  }
};

// Sửa category (chỉ admin)
exports.updateCategory = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền thực hiện thao tác này" });
    }

    const { id } = req.params;
    let { platforms_id, name, path, notes, modal_show, status, thutu } = req.body; // Thêm thutu

    // Kiểm tra xem Category có tồn tại không
    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category không tồn tại" });
    }

    // Chuẩn hóa và kiểm tra trùng path nếu có cập nhật path
    if (typeof path === 'string') {
      path = path.trim();
      if (path) {
        const dup = await Category.findOne({
          path: { $regex: `^${escapeRegex(path)}$`, $options: 'i' },
          _id: { $ne: id }
        });
        if (dup) {
          return res.status(400).json({ success: false, message: "Path đã tồn tại, vui lòng chọn path khác" });
        }
      }
    }

    // Cập nhật category
    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { platforms_id, name, path, notes, modal_show, status, thutu }, // Thêm thutu
      { new: true }
    );

    res.status(200).json({ success: true, message: "Category được cập nhật thành công", data: updatedCategory });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi cập nhật Category", error: error.message });
  }
};
exports.deleteCategory = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền thực hiện thao tác này" });
    }

    const { id } = req.params;

    // Kiểm tra xem Category có tồn tại không
    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category không tồn tại" });
    }

    // Kiểm tra xem có server/service nào đang dùng category này không
    const Service = require("../../models/server");
    const serviceUsingCategory = await Service.findOne({ category: id });
    if (serviceUsingCategory) {
      return res.status(400).json({
        success: false,
        message: "Không thể xóa vì vẫn còn dịch vụ/server đang sử dụng category này!",
      });
    }

    await Category.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: "Category được xóa thành công" });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi xóa Category", error: error.message });
  }
};
// Lấy danh sách category (không cần admin)
exports.getCategories = async (req, res) => {
  try {
    // Lấy tất cả categories, populate platforms_id
    const categories = await Category.find()
      .populate({
        path: "platforms_id",
        select: "name logo",
        options: { sort: { createdAt: 1 } },
      })
      .sort({ thutu: 1, createdAt: 1 });

    // Lấy tất cả platforms theo thứ tự thutu tăng dần, nếu không có thutu thì theo createdAt
    const platforms = await Platform.find().sort({ thutu: 1, createdAt: 1 });

    // Gắn categories vào từng platform
    const platformsWithCategories = platforms.map((platform) => {
      const platformCategories = categories.filter(
        (cat) => cat.platforms_id && cat.platforms_id._id.toString() === platform._id.toString()
      );
      return {
        ...platform.toObject(),
        categories: platformCategories,
      };
    });

    res.status(200).json({ success: true, platforms: platformsWithCategories });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};