const mongoose = require('mongoose');

const TransactionBankingSchema = new mongoose.Schema({
    transactionID: { type: String, required: true, unique: true }, // ID giao dịch (duy nhất)
    typeBank: { type: String, required: true }, // Loại ngân hàng (ví dụ: ACB, Vietcombank, v.v.)
    accountNumber: { type: String, required: true }, // Số tài khoản ngân hàng
    code: { type: String }, // Mã nạp tiền
    username: { type: String, required: true }, // Tên người dùng liên quan đến giao dịch
    amount: { type: Number, required: true }, // Số tiền giao dịch
    description: { type: String, default: null }, // Mô tả giao dịch
    transactionDate: { type: String, required: true }, // Ngày giao dịch
    type: { type: String, enum: ['IN', 'OUT'], required: true }, // Loại giao dịch (IN: nạp tiền, OUT: rút tiền)
    note: { type: String, default: null }, // Ghi chú giao dịch
    status: { type: String, enum: ['COMPLETED', 'FAILED'] },
    domain: { type: String }, // Domain liên quan đến giao dịch
}, { timestamps: true });
TransactionBankingSchema.index({ typeBank: 1, accountNumber: 1, transactionID: 1 }, { unique: true });
module.exports = mongoose.model('TransactionBanking', TransactionBankingSchema);