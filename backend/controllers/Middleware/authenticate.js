const jwt = require("jsonwebtoken");
const User = require("../../models/User");

// Middleware xác thực user (chỉ cần đăng nhập)
const authenticateUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Không có token, truy cập bị từ chối" });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ error: "Token không hợp lệ" });
    }
    try {
        const decoded = jwt.verify(token, process.env.secretKey);
        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(404).json({ error: "Người dùng không tồn tại" });
        }
        if(user.status !== "active") {
            return res.status(404).json({ error: "Tài khoản của bạn đã bị khóa" });
        }
        req.user = user;
        req.role = user.role;
        next();
    } catch (error) {
        return res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn" });
    }
};

// Middleware xác thực admin
const authenticateAdmin = async (req, res, next) => {
    await authenticateUser(req, res, async () => {
        if (req.user.role !== "admin") {
            return res.status(403).json({ error: "Bạn không có quyền truy cập" });
        }
        next();
    });
};

module.exports = {
    authenticateUser,
    authenticateAdmin
};
