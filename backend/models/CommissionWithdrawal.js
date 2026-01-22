const mongoose = require('mongoose');

const commissionWithdrawalSchema = new mongoose.Schema({
    // User yêu cầu rút
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    username: { type: String, required: true },

    // Thông tin rút tiền
    amount: { type: Number, required: true },           // Số tiền yêu cầu rút
    fee: { type: Number, default: 0 },                  // Phí rút
    netAmount: { type: Number, required: true },        // Số tiền thực nhận (amount - fee)

    // Loại rút
    type: {
        type: String,
        enum: ['bank', 'balance'],  // 'bank' = rút về ATM, 'balance' = chuyển vào số dư web
        required: true
    },

    // Thông tin ngân hàng (chỉ khi type = 'bank')
    bankInfo: {
        bankName: { type: String },
        accountNumber: { type: String },
        accountName: { type: String }
    },

    // Trạng thái
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
        index: true
    },

    // Admin xử lý
    adminNote: { type: String },                        // Ghi chú của admin
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    processedAt: { type: Date }

}, { timestamps: true });

// Index cho query thường xuyên
commissionWithdrawalSchema.index({ status: 1, createdAt: -1 });
commissionWithdrawalSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('CommissionWithdrawal', commissionWithdrawalSchema);
