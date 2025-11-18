const Platform = require("../../models/platform");

// Thêm platform mới (chỉ admin)
exports.addPlatform = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền thực hiện thao tác này" });
    }

    const { name, logo, thutu , status } = req.body;

    const newPlatform = new Platform({
      name,
      logo,
      thutu,
      status,
    });

    await newPlatform.save();
    res.status(201).json({ success: true, message: "Platform được thêm thành công", data: newPlatform });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi thêm Platform", error: error.message });
  }
};

// Sửa platform (chỉ admin)
exports.updatePlatform = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền thực hiện thao tác này" });
    }

    const { id } = req.params; // Sử dụng _id thay vì id
    const { name, logo, status, thutu } = req.body;

    const updatedPlatform = await Platform.findByIdAndUpdate(
      id, // Tìm theo _id
      { name, logo, status, thutu },
      { new: true }
    );

    if (!updatedPlatform) {
      return res.status(404).json({ success: false, message: "Platform không tồn tại" });
    }

    res.status(200).json({ success: true, message: "Platform được cập nhật thành công", data: updatedPlatform });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi cập nhật Platform", error: error.message });
  }
};

// Xóa platform (chỉ admin)
exports.deletePlatform = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Chỉ admin mới có quyền thực hiện thao tác này" });
    }

    const { id } = req.params; // Sử dụng _id thay vì id

    // Kiểm tra xem có category nào đang dùng platform này không
    const Category = require("../../models/Category");
    console.error("Checking for categories using platform with id:", id);
    const categoryUsingPlatform = await Category.findOne({ platforms_id: id });
    console.error("Category using platform:", categoryUsingPlatform);
    if (categoryUsingPlatform) {
      return res.status(400).json({
        success: false,
        message: "Không thể xóa vì vẫn còn category đang sử dụng platform này!",
      });
    }

    const deletedPlatform = await Platform.findByIdAndDelete(id); // Tìm và xóa theo _id

    if (!deletedPlatform) {
      return res.status(404).json({ success: false, message: "Platform không tồn tại" });
    }

    res.status(200).json({ success: true, message: "Platform được xóa thành công" });
  } catch (error) {
    res.status(400).json({ success: false, message: "Lỗi khi xóa Platform", error: error.message });
  }
};

// Lấy danh sách platform (không cần admin, không phân trang)
exports.getPlatforms = async (req, res) => {
  try {
    const user = req.user;
    // Lấy tất cả các platform
    let filter = {
      status: true, // Chỉ lấy platform đang hoạt động
    };
    if (user.role === "admin") {
      filter = {}; // Admin xem tất cả
    }
    const platforms = await Platform.find(filter).sort({ thutu: 1, createdAt: 1 }); // Sử dụng _id thay vì id

    res.status(200).json({
      success: true,
      platforms,
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách Platform:", error);
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};