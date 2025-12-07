const mongoose = require('mongoose');
const Scheduled = require('../../models/Scheduled');

const MAX_LIMIT = 100;
const MIN_DELAY_MS = 60 * 1000; // 1 minute safety buffer

function parsePage(value) {
  const page = Number(value);
  if (!Number.isFinite(page) || page <= 0) return 1;
  return Math.floor(page);
}

function parseLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 10;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function buildStatusFilter(rawStatus) {
  if (!rawStatus) return undefined;
  const statuses = String(rawStatus)
    .split(',')
    .map((status) => status.trim())
    .filter(Boolean);
  if (statuses.length === 0) return undefined;
  if (statuses.length === 1) return statuses[0];
  return { $in: statuses };
}

function isValidFutureDate(rawDate) {
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: 'Thời gian hẹn giờ không hợp lệ' };
  }
  const now = Date.now();
  if (date.getTime() <= now + MIN_DELAY_MS) {
    return { ok: false, error: 'Thời gian hẹn giờ phải lớn hơn thời điểm hiện tại ít nhất 1 phút' };
  }
  return { ok: true, value: date };
}

async function getScheduledOrders(req, res) {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const skip = (page - 1) * limit;

    const filter = {};
    // Chỉ lọc theo username nếu không phải admin
    if (req.user.role !== 'admin') {
      filter.username = req.user.username;
    }

    const statusFilter = buildStatusFilter(req.query.status);
    if (statusFilter) {
      filter.status = statusFilter;
    }

    // Admin xem tất cả trường, user thường ẩn các trường nhạy cảm
    const selectFields = req.user.role === 'admin' ? '' : '-serviceId -domainSmm -isManualOrder -orderId';

    const [scheduledOrders, total] = await Promise.all([
      Scheduled.find(filter, selectFields)
        .sort({ createdAt: -1, scheduleTime: -1 })
        .skip(skip)
        .limit(limit),
      Scheduled.countDocuments(filter),
    ]);

    return res.status(200).json({
      scheduledOrders,
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Không thể lấy danh sách đơn hẹn giờ' });
  }
}

async function rescheduleScheduledOrder(req, res) {
  const { id } = req.params;
  const { scheduleTime } = req.body || {};

  if (!scheduleTime) {
    return res.status(400).json({ error: 'Vui lòng cung cấp thời gian hẹn giờ mới' });
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Mã đơn hẹn giờ không hợp lệ' });
  }

  const validation = isValidFutureDate(scheduleTime);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    // Admin có thể reschedule đơn của bất kỳ user nào, user thường chỉ reschedule đơn của mình
    const filter = { _id: id };
    if (req.user.role !== 'admin') {
      filter.username = req.user.username;
    }

    const scheduledOrder = await Scheduled.findOne(filter);
    if (!scheduledOrder) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hẹn giờ' });
    }

    if (scheduledOrder.status !== 'Pending') {
      return res.status(400).json({ error: 'Chỉ có thể hẹn giờ lại với đơn đang chờ xử lý (Pending)' });
    }

    scheduledOrder.scheduleTime = validation.value;
    scheduledOrder.status = 'Pending';
    scheduledOrder.executedAt = undefined;
    scheduledOrder.errorMessage = undefined;

    await scheduledOrder.save();

    const { serviceId, domainSmm, isManualOrder, orderId, madon, ...safeOrder } = scheduledOrder.toObject();

    return res.status(200).json({
      message: 'Cập nhật thời gian hẹn giờ thành công',
      scheduledOrder: safeOrder,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Không thể cập nhật thời gian hẹn giờ' });
  }
}

async function cancelScheduledOrder(req, res) {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Mã đơn hẹn giờ không hợp lệ' });
  }

  try {
    // Admin có thể cancel đơn của bất kỳ user nào, user thường chỉ cancel đơn của mình
    const filter = { _id: id };
    if (req.user.role !== 'admin') {
      filter.username = req.user.username;
    }

    const scheduledOrder = await Scheduled.findOne(filter);
    if (!scheduledOrder) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hẹn giờ' });
    }

    if (scheduledOrder.status !== 'Pending') {
      return res.status(400).json({ error: 'Chỉ có thể hủy các đơn đang chờ xử lý (Pending)' });
    }

    scheduledOrder.status = 'Cancelled';
    scheduledOrder.errorMessage = 'Đơn hẹn giờ đã được hủy bởi người dùng';
    scheduledOrder.executedAt = new Date();

    await scheduledOrder.save();

    const { serviceId, domainSmm, isManualOrder, orderId, madon, ...safeOrder } = scheduledOrder.toObject();

    return res.status(200).json({
      message: 'Đơn hẹn giờ đã được hủy',
      scheduledOrder: safeOrder,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Không thể hủy đơn hẹn giờ' });
  }
}

module.exports = {
  getScheduledOrders,
  rescheduleScheduledOrder,
  cancelScheduledOrder,
};
