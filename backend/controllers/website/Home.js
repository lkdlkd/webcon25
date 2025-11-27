// const Category = require('../../models/Category');
// const Platform = require('../../models/platform');
// const User = require('../../models/User');
// const Notification = require('../../models/Notification');
// const Configweb = require('../../models/Configweb');

// // exports.getCategories = async (req, res) => {
// //   try {
// //     // Lấy tất cả categories, populate platforms_id
// //     const categories = await Category.find()
// //       .populate({
// //         path: "platforms_id",
// //         select: "name logo",
// //         options: { sort: { createdAt: 1 } },
// //       })
// //       .sort({ thutu: 1, createdAt: 1 });

// //     // Lấy tất cả platforms theo thứ tự thutu tăng dần, nếu không có thutu thì theo createdAt
// //     const platforms = await Platform.find().sort({ thutu: 1, createdAt: 1 });

// //     // Gắn categories vào từng platform
// //     const platformsWithCategories = platforms.map((platform) => {
// //       const platformCategories = categories.filter(
// //         (cat) => cat.platforms_id && cat.platforms_id._id.toString() === platform._id.toString()
// //       );
// //       return {
// //         ...platform.toObject(),
// //         categories: platformCategories,
// //       };
// //     });

// //     res.status(200).json({ success: true, platforms: platformsWithCategories });
// //   } catch (error) {
// //     res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
// //   }
// // };

// // exports.getMe = async (req, res) => {
// //   try {
// //     const currentUser = req.user; // Lấy từ middleware
// //     const username = currentUser.username; // Lấy username từ params
// //     // Nếu là admin hoặc chính chủ mới được xem thông tin
// //     if (currentUser.role !== "admin" && currentUser.username !== username) {
// //       return res.status(403).json({ error: "Bạn không có quyền xem thông tin người dùng này" });
// //     }

// //     // Tìm người dùng theo username
// //     const user = await User.findOne({ username }).select("-password");
// //     if (!user) {
// //       return res.status(404).json({ error: "Người dùng không tồn tại" });
// //     }

// //     // Trả về thông tin user nhưng thay token bằng apiKey
// //     const loginHistory = Array.isArray(user.loginHistory)
// //       ? user.loginHistory.slice(-10).reverse()
// //       : [];
// //     return res.status(200).json({
// //       balance: user.balance,
// //       capbac: user.capbac,
// //       createdAt: user.createdAt,
// //       role: user.role,
// //       status: user.status,
// //       twoFactorEnabled: user.twoFactorEnabled,
// //       token: user.apiKey, // Hiển thị API Key thay vì token
// //       tongnap: user.tongnap,
// //       tongnapthang: user.tongnapthang,
// //       updatedAt: user.updatedAt,
// //       userId: user._id,
// //       telegramChat: user.telegramChatId ? true : false,
// //       username: user.username,
// //       loginHistory,
// //     });
// //   } catch (error) {
// //     console.error("Get user error:", error);
// //     return res.status(500).json({ error: "Có lỗi xảy ra. Vui lòng thử lại sau." });
// //   }
// // };

// // router.get("/", authAdmin.authenticateUser, async (req, res) => {
// //     try {
// //         let notifications;
// //         // Kiểm tra nếu người dùng có role là 'admin'
// //         if (req.role === "admin") {
// //             notifications = await Notification.find().sort({ created_at: -1 }).limit(5);;
// //         } else {
// //             notifications = await Notification.find().sort({ created_at: -1 }).limit(5);
// //         }
// //         res.json(notifications);
// //     } catch (error) {
// //         res.status(500).json({ error: "Lỗi khi lấy danh sách thông báo" });
// //         console.log(error)

// //     }
// // });
// // // Lấy thông tin cấu hình website
// // exports.getConfigweb = async (req, res) => {
// //   try {
// //     let config = await Configweb.findOne();

// //     // Nếu chưa có cấu hình, tạo một cấu hình mặc định
// //     if (!config) {
// //       config = new Configweb({
// //         tieude: "",
// //         logo: "",
// //         favicon: "",
// //         linktele: "https://t.me/noti_web_245_bot",
// //         title: "",
// //         lienhe: [
// //           {
// //             type: "",
// //             value: "",
// //             logolienhe: "",
// //           },
// //         ],
// //         cuphap: "naptien", // Thêm giá trị mặc định cho cuphap
// //       });
// //       await config.save();
// //     }

// //     res.status(200).json({ success: true, data: config });
// //   } catch (error) {
// //     console.error("Lỗi khi lấy cấu hình website:", error);
// //     res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
// //   }
// // };

// // Tổng hợp 4 hàm: categories + user info + notifications + config
// // Trả về một object duy nhất để giảm số request phía client
// exports.getHomeOverview = async (req, res) => {
//     try {
//         const currentUser = req.user; // yêu cầu middleware xác thực đã gán
//         if (!currentUser) {
//             return res.status(401).json({ success: false, message: 'Unauthorized' });
//         }

//         // Parallel fetch
//         const [categories, platforms, notificationsRaw, configRaw, user] = await Promise.all([
//             Category.find()
//                 .populate({ path: 'platforms_id', select: 'name logo', options: { sort: { createdAt: 1 } } })
//                 .sort({ thutu: 1, createdAt: 1 }),
//             Platform.find().sort({ thutu: 1, createdAt: 1 }),
//             Notification.find().sort({ created_at: -1 }).limit(5),
//             (async () => {
//                 let cfg = await Configweb.findOne();
//                 if (!cfg) {
//                     cfg = new Configweb({
//                         tieude: '', logo: '', favicon: '', linktele: 'https://t.me/noti_web_245_bot', title: '',
//                         lienhe: [{ type: '', value: '', logolienhe: '' }], cuphap: 'naptien'
//                     });
//                     await cfg.save();
//                 }
//                 return cfg;
//             })(),
//             User.findOne({ username: currentUser.username }).select('-password')
//         ]);

//         if (!user) {
//             return res.status(404).json({ success: false, message: 'Người dùng không tồn tại' });
//         }

//         // Build platforms with categories
//         const platformsWithCategories = platforms.map(p => {
//             const platformCategories = categories.filter(
//                 c => c.platforms_id && c.platforms_id._id.toString() === p._id.toString()
//             );
//             return { ...p.toObject(), categories: platformCategories };
//         });

//         const loginHistory = Array.isArray(user.loginHistory) ? user.loginHistory.slice(-10).reverse() : [];

//         const userData = {
//             balance: user.balance,
//             capbac: user.capbac,
//             createdAt: user.createdAt,
//             role: user.role,
//             status: user.status,
//             twoFactorEnabled: user.twoFactorEnabled,
//             token: user.apiKey,
//             tongnap: user.tongnap,
//             tongnapthang: user.tongnapthang,
//             updatedAt: user.updatedAt,
//             userId: user._id,
//             telegramChat: !!user.telegramChatId,
//             username: user.username,
//             loginHistory,
//         };

//         return res.status(200).json({
//             success: true,
//             data: {
//                 platforms: platformsWithCategories,
//                 notifications: notificationsRaw,
//                 config: configRaw,
//                 user: userData,
//             }
//         });
//     } catch (err) {
//         console.error('getHomeOverview error:', err);
//         return res.status(500).json({ success: false, message: 'Lỗi server', error: err.message });
//     }
// };