const moment = require("moment");
const User = require("../../models/User");
const Order = require("../../models/Order");
const Deposit = require("../../models/History");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek'); // 🧠 dùng để tuần bắt đầu từ thứ 2

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek); // 👈 thêm dòng này

// Hàm lấy thời gian bắt đầu và kết thúc theo range
// function getRange(range) {
//     const now = moment();
//     let start, end;
//     switch (range) {
//         case "today":
//             start = now.clone().startOf("day");
//             end = now.clone().endOf("day");
//             break;
//         case "yesterday":
//             start = now.clone().subtract(1, "day").startOf("day");
//             end = now.clone().subtract(1, "day").endOf("day");
//             break;
//         case "this_week":
//             start = now.clone().startOf("week");
//             end = now.clone().endOf("week");
//             break;
//         case "last_week":
//             start = now.clone().subtract(1, "week").startOf("week");
//             end = now.clone().subtract(1, "week").endOf("week");
//             break;
//         case "this_month":
//             start = now.clone().startOf("month");
//             end = now.clone().endOf("month");
//             break;
//         case "last_month":
//             start = now.clone().subtract(1, "month").startOf("month");
//             end = now.clone().subtract(1, "month").endOf("month");
//             break;
//         default:
//             start = now.clone().startOf("day");
//             end = now.clone().endOf("day");
//     }
//     return { start: start.toDate(), end: end.toDate() };
// }

// Chuẩn hoá range: today, yesterday, this_week, last_week, this_month, last_month
function getRange(range) {
    const now = dayjs().tz('Asia/Ho_Chi_Minh'); // thời gian hiện tại theo giờ VN
    let start, end;

    switch (range) {
        case "today":
            start = now.startOf("day");
            end = now.endOf("day");
            break;
        case "yesterday":
            start = now.subtract(1, "day").startOf("day");
            end = now.subtract(1, "day").endOf("day");
            break;
        case "this_week":
            start = now.startOf("isoWeek"); // tuần bắt đầu từ Thứ hai
            end = now.endOf("isoWeek");
            break;
        case "last_week":
            const lastWeek = now.subtract(1, "week");
            start = lastWeek.startOf("isoWeek").startOf("day");
            end = lastWeek.endOf("isoWeek").endOf("day");
            break;
        case "this_month":
            start = now.startOf("month");
            end = now.endOf("month");
            break;
        case "last_month":
            start = now.subtract(1, "month").startOf("month");
            end = now.subtract(1, "month").endOf("month");
            break;
        default:
            start = now.startOf("day");
            end = now.endOf("day");
    }

    // Trả về UTC để dùng với MongoDB
    return {
        start: start.toDate(), // tự động chuyển về UTC khi convert sang Date
        end: end.toDate()
    };
}

exports.getStatistics = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser || currentUser.role !== "admin") {
            return res.status(403).json({ error: 'Chỉ admin mới có quyền sử dụng chức năng này' });
        }

        // Lấy range từ query, mặc định là "today"
        const { doanhthuRange = "today", customStart, customEnd } = req.query;
        let doanhthuTime;
        if (customStart && customEnd) {
            // Nếu customEnd chỉ là ngày (không có giờ), set về cuối ngày đó
            let endDate;
            if (/^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
                // Nếu customEnd là hôm nay, set về giờ hiện tại
                const todayStr = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
                if (customEnd === todayStr) {
                    endDate = new Date(); // giờ hiện tại
                } else {
                    // Set về cuối ngày customEnd
                    endDate = dayjs(customEnd).tz('Asia/Ho_Chi_Minh').endOf('day').toDate();
                }
            } else {
                // Nếu customEnd có cả giờ phút giây, dùng luôn
                endDate = new Date(customEnd);
            }
            doanhthuTime = {
                start: dayjs(customStart).tz('Asia/Ho_Chi_Minh').startOf('day').toDate(),
                end: endDate
            };
        } else {
            doanhthuTime = getRange(doanhthuRange);
        }
        // Tổng số thành viên
        const tonguser = await User.countDocuments();
        // Tổng số dư của người dùng
        const balanceAgg = await User.aggregate([
            { $group: { _id: null, totalBalance: { $sum: "$balance" } } }
        ]);
        const tongtienweb = balanceAgg[0] ? balanceAgg[0].totalBalance : 0;

        // Tổng số đơn đang chạy
        const tongdondangchay = await Order.countDocuments({
            status: { $in: ["running", "In progress", "Processing", "Pending"] }
        });

        // Tổng doanh thu (lợi nhuận) theo từng DomainSmm và tổng tiền hoàn theo trạng thái đơn tại thời điểm hoàn tiền
        let revenueAgg = await Order.aggregate([
            {
                $match: {
                    status: { $in: ["running", "In progress", "Processing", "Pending", "Completed", "Partial", "Canceled"] },
                    createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end }
                }
            },
            {
                $group: { _id: "$DomainSmm", totalLai: { $sum: "$lai" }, totalTientieu: { $sum: "$tientieu" }, totalCost: { $sum: "$totalCost" } }
            }
        ]);
        // Chỉ trả về name của DomainSmm cho mỗi item
        const SmmSv = require("../../models/SmmSv");
        for (const item of revenueAgg) {
            if (item._id && typeof item._id === 'object' && item._id.toHexString) {
                // ObjectId hợp lệ
                const smm = await SmmSv.findById(item._id);
                item.DomainSmm = smm ? smm.name : 'doitac';
            } else {
                // Nếu _id là string (ví dụ 'smm1s') hoặc null thì gán luôn
                item.DomainSmm = 'doitac';
            }
        }

        // Tính tổng tiền hoàn cho từng DomainSmm dựa trên trạng thái đơn tại thời điểm hoàn tiền
        // Lấy tất cả lịch sử hoàn tiền trong range
        const refundsForDomain = await Deposit.aggregate([
            { $match: { hanhdong: { $regex: "Hoàn tiền", $options: "i" }, createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end } } },
            { $project: { madon: 1, tongtien: 1 } }
        ]);
        // Join với Order để lấy domain và trạng thái tại thời điểm hoàn tiền
        const madonListForDomain = refundsForDomain.map(r => r.madon);
        const orderListForDomain = await Order.find({ Madon: { $in: madonListForDomain } }, { Madon: 1, DomainSmm: 1, status: 1 });
        // Map madon -> domain, status
        const madonDomainMap = {};
        orderListForDomain.forEach(o => {
            madonDomainMap[o.Madon] = { domain: o.DomainSmm, status: o.status };
        });
        // Gom tổng tiền hoàn theo domain và trạng thái
        const refundDomainMap = {};
        refundsForDomain.forEach(r => {
            const info = madonDomainMap[r.madon];
            if (!info) return;
            const domain = info.domain || 'Unknown';
            const status = info.status;
            if (!refundDomainMap[domain]) {
                refundDomainMap[domain] = { totalRefund: 0, totalRefundPartial: 0, totalRefundCanceled: 0 };
            }
            refundDomainMap[domain].totalRefund += r.tongtien;
            if (status === 'Partial') refundDomainMap[domain].totalRefundPartial += r.tongtien;
            if (status === 'Canceled') refundDomainMap[domain].totalRefundCanceled += r.tongtien;
        });
        // Gắn tổng tiền hoàn vào từng domain
        revenueAgg.forEach(item => {
            const refund = refundDomainMap[item._id] || {};
            item.totalRefund = refund.totalRefund || 0;
            item.totalRefundPartial = refund.totalRefundPartial || 0;
            item.totalRefundCanceled = refund.totalRefundCanceled || 0;
        });
        // Tổng lợi nhuận tất cả DomainSmm trong range
        const tongdoanhthu = revenueAgg.reduce((sum, item) => sum + (item.totalLai || 0), 0);

        // Doanh thu theo range
        const revenueRangeAgg = await Order.aggregate([
            {
                $match: {
                    createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end },
                    status: { $in: ["running", "In progress", "Processing", "Pending", "Completed", "Partial", "Canceled"] }
                }
            },
            {
                $group: { _id: null, total: { $sum: "$totalCost" } }
            }
        ]);
        const tongdoanhthuhnay = revenueRangeAgg[0] ? revenueRangeAgg[0].total : 0;

        // Tổng số nạp theo range
        const depositRangeAgg = await Deposit.aggregate([
            {
                $match: {
                    createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end },
                    hanhdong: { $regex: "(nạp tiền|Cộng tiền)", $options: "i" }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$tongtien" }
                }
            }
        ]);
        const tongnapngay = depositRangeAgg[0] ? depositRangeAgg[0].total : 0;

        // Tổng số nạp trong tháng
        const startMonth = moment().startOf("month").toDate();
        const depositMonthAgg = await Deposit.aggregate([
            {
                $match: {
                    createdAt: { $gte: startMonth },
                    hanhdong: { $regex: "(nạp tiền|Cộng tiền)", $options: "i" }
                }
            },
            { $group: { _id: null, totalDepositMonth: { $sum: "$tongtien" } } }
        ]);
        const tongnapthang = depositMonthAgg[0] ? depositMonthAgg[0].totalDepositMonth : 0;

        // Tổng đã nạp: Lấy tổng từ trường tongnap của User
        const userDepositAgg = await User.aggregate([
            { $group: { _id: null, totalDeposited: { $sum: "$tongnap" } } }
        ]);
        const tongdanap = userDepositAgg[0] ? userDepositAgg[0].totalDeposited : 0;


        // Thống kê theo Magoi: số đơn tạo, số đơn Partial, số đơn Canceled, tổng tiền, kèm namesv từ order đầu tiên
        const magoiStats = await Order.aggregate([
            {
                $match: {
                    createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end }
                }
            },
            {
                $sort: { createdAt: 1 } // đảm bảo lấy order đầu tiên theo thời gian
            },
            {
                $group: {
                    _id: "$Magoi",
                    totalOrders: { $sum: 1 },
                    partialCount: {
                        $sum: { $cond: [{ $eq: ["$status", "Partial"] }, 1, 0] }
                    },
                    canceledCount: {
                        $sum: { $cond: [{ $eq: ["$status", "Canceled"] }, 1, 0] }
                    },
                    namesv: { $first: "$namesv" },
                    totalAmount: { $sum: "$totalCost" }
                }
            },
            { $project: { Magoi: "$_id", totalOrders: 1, partialCount: 1, canceledCount: 1, namesv: 1, totalAmount: 1, _id: 0 } }
        ]);

        // Biểu đồ: tổng hợp theo ngày trong range
        const chartMatch = { createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end } };
        // Đếm số đơn tạo và tổng tiền mỗi ngày
        const dailyOrders = await Order.aggregate([
            { $match: chartMatch },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
                    count: { $sum: 1 },
                    total: { $sum: "$totalCost" }
                }
            },
            { $sort: { _id: 1 } }
        ]);
        // Lấy dailyPartial và dailyCanceled từ bảng HistoryUser, join với Order để xác định trạng thái
        const HistoryUser = require("../../models/History");
        // Lấy tất cả history hoàn tiền trong range
        const allRefunds = await HistoryUser.aggregate([
            { $match: { hanhdong: { $regex: "Hoàn tiền", $options: "i" }, createdAt: { $gte: doanhthuTime.start, $lte: doanhthuTime.end } } },
            { $project: { madon: 1, tongtien: 1, createdAt: 1 } }
        ]);
        // Lấy trạng thái các mã đơn liên quan
        const madonList = allRefunds.map(r => r.madon);
        // Tìm theo cả madon và Magoi (nhiều hệ thống lưu mã đơn ở 2 trường khác nhau)
        const orderStatusList = await Order.find({ $or: [{ Madon: { $in: madonList } }] }, { Madon: 1, status: 1 });
        const madonStatusMap = {};
        orderStatusList.forEach(o => {
            if (o.Madon) madonStatusMap[o.Madon] = o.status;
            if (o.Magoi) madonStatusMap[o.Magoi] = o.status;
        });
        // Gom nhóm theo ngày và trạng thái
        const partialMap = {};
        const canceledMap = {};
        allRefunds.forEach(r => {
            const status = madonStatusMap[r.madon];
            const date = dayjs(r.createdAt).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
            if (status === 'Partial') {
                if (!partialMap[date]) partialMap[date] = { _id: date, count: 0, total: 0 };
                partialMap[date].count += 1;
                partialMap[date].total += r.tongtien;
            } else if (status === 'Canceled') {
                if (!canceledMap[date]) canceledMap[date] = { _id: date, count: 0, total: 0 };
                canceledMap[date].count += 1;
                canceledMap[date].total += r.tongtien;
            }
        });
        // Chuyển sang mảng và sort
        const dailyPartial = Object.values(partialMap).sort((a, b) => a._id.localeCompare(b._id));
        const dailyCanceled = Object.values(canceledMap).sort((a, b) => a._id.localeCompare(b._id));

        // Tổng hợp số đơn và tổng tiền hoàn Partial/Canceled theo range
        let partialCount = 0, canceledCount = 0, partialHoan = 0, canceledHoan = 0;
        Object.values(partialMap).forEach(item => {
            partialCount += item.count;
            partialHoan += item.total;
        });
        Object.values(canceledMap).forEach(item => {
            canceledCount += item.count;
            canceledHoan += item.total;
        });
        // Tổng số tiền nạp mỗi ngày
        const dailyDeposits = await Deposit.aggregate([
            { $match: { ...chartMatch, hanhdong: { $regex: "(nạp tiền|Cộng tiền)", $options: "i" } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } }, total: { $sum: "$tongtien" } } },
            { $sort: { _id: 1 } }
        ]);

        // Gộp dữ liệu chart thành 1 mảng dailyChart
        // Tạo map theo ngày cho từng loại
        const mapOrders = Object.fromEntries(dailyOrders.map(i => [i._id, i]));
        const mapDeposits = Object.fromEntries(dailyDeposits.map(i => [i._id, i]));
        const mapPartial = Object.fromEntries(dailyPartial.map(i => [i._id, i]));
        const mapCanceled = Object.fromEntries(dailyCanceled.map(i => [i._id, i]));

        // Lấy tất cả ngày xuất hiện ở bất kỳ loại nào
        const allDates = Array.from(new Set([
            ...dailyOrders.map(i => i._id),
            ...dailyDeposits.map(i => i._id),
            ...dailyPartial.map(i => i._id),
            ...dailyCanceled.map(i => i._id)
        ])).sort();

        const dailyChart = allDates.map(date => ({
            date,
            orders: mapOrders[date]?.count || 0,
            ordersTotal: mapOrders[date]?.total || 0,
            deposits: mapDeposits[date]?.total || 0,
            partial: mapPartial[date]?.count || 0,
            partialTotal: mapPartial[date]?.total || 0,
            canceled: mapCanceled[date]?.count || 0,
            canceledTotal: mapCanceled[date]?.total || 0
        }));

        res.status(200).json({
            tonguser,
            tongtienweb,
            tongdondangchay,
            tongdanap,
            tongdoanhthu,
            laiTheoDomain: revenueAgg, // <-- thêm dòng này
            tongnapthang,
            tongnapngay,
            tongdoanhthuhnay,
            doanhthuRange,
            partialCount, // số đơn Partial theo range
            canceledCount, // số đơn Canceled theo range
            partialHoan, // tổng tiền hoàn Partial
            canceledHoan, // tổng tiền hoàn Canceled
            magoiStats, // thống kê theo Magoi
            chartData: dailyChart
        });
    } catch (error) {
        console.error("Lỗi thống kê:", error);
        res.status(500).json({ message: "Lỗi server", error: error.message });
    }
};
