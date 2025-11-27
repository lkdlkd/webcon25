const mongoose = require('mongoose');

const BankSchema = new mongoose.Schema({
    bank_name: { type: String, required: true },
    account_name: { type: String, required: true },
    account_number: { type: String, required: true },
    url_api: { type: String },
    code : { type: String },
    bank_account: { type: String },
    bank_password: { type: String },
    min_recharge: { type: Number, default: 0 },
    status: { type: Boolean, default: true },
    token: { type: String },
    domain: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Bank', BankSchema);