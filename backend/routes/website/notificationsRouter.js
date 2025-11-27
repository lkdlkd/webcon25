const express = require("express");
const router = express.Router();
const Notification = require("../../models/Notification");
const authAdmin = require("../../controllers/Middleware/authenticate"); // Middleware kiểm tra quyền Admin

// Thêm thông báo (Chỉ Admin)
router.post("/add", authAdmin.authenticateAdmin, async (req, res) => {
    try {
        const { title, content, color } = req.body;
        const newNotification = new Notification({ title, content, color });
        await newNotification.save();
        res.status(201).json({ message: "Thông báo đã được tạo", notification: newNotification });
    } catch (error) {
        res.status(500).json({ error: "Lỗi khi tạo thông báo" });
        console.log(error)
    }
});

// Sửa thông báo (Chỉ Admin)
router.put("/edit/:id", authAdmin.authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, color } = req.body;

        const updatedNotification = await Notification.findByIdAndUpdate(
            id,
            { title, content, color },
            { new: true }
        );

        if (!updatedNotification) return res.status(404).json({ error: "Không tìm thấy thông báo" });

        res.json({ message: "Thông báo đã được cập nhật", notification: updatedNotification });
    } catch (error) {
        res.status(500).json({ error: "Lỗi khi cập nhật thông báo" });
    }
});

// Xóa thông báo (Chỉ Admin)
router.delete("/delete/:id", authAdmin.authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const deletedNotification = await Notification.findByIdAndDelete(id);

        if (!deletedNotification) return res.status(404).json({ error: "Không tìm thấy thông báo" });

        res.json({ message: "Thông báo đã bị xóa" });
    } catch (error) {
        res.status(500).json({ error: "Lỗi khi xóa thông báo" });
    }
});

router.get("/", authAdmin.authenticateUser, async (req, res) => {
    try {
        let notifications;
        // Kiểm tra nếu người dùng có role là 'admin'
        if (req.role === "admin") {
            notifications = await Notification.find().sort({ created_at: -1 }).limit(5);;
        } else {
            notifications = await Notification.find().sort({ created_at: -1 }).limit(5);
        }
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ error: "Lỗi khi lấy danh sách thông báo" });
        console.log(error)

    }
});

module.exports = router;
