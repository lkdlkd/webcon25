const mongoose = require('mongoose');

const affiliateCommissionSchema = new mongoose.Schema({
    // Người nhận hoa hồng (referrer)
    referrer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    referrerUsername: { type: String, required: true },

    // Người nạp tiền (được giới thiệu)
    depositor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    depositorUsername: { type: String, required: true },

    // Thông tin giao dịch
    depositAmount: { type: Number, required: true },        // Số tiền nạp
    commissionPercent: { type: Number, required: true },    // % hoa hồng
    commissionAmount: { type: Number, required: true },     // Số tiền hoa hồng

    // Trạng thái duyệt
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
        index: true
    },

    // Admin duyệt
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectedReason: { type: String },

    // Mã giao dịch gốc
    depositCode: { type: String },

}, { timestamps: true });

// Index cho query thường xuyên
affiliateCommissionSchema.index({ status: 1, createdAt: -1 });
affiliateCommissionSchema.index({ referrer: 1, status: 1 });

module.exports = mongoose.model('AffiliateCommission', affiliateCommissionSchema);
