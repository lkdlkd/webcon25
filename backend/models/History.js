const mongoose = require('mongoose');

const historyUserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true
    },
    madon: {
        type: String,
        required: true
    },
    hanhdong: {
        type: String,
        required: true
    },
    link: {
        type: String,
        required: false
    },
    tienhientai: {
        type: Number,
        required: true
    },
    tongtien: {
        type: Number,
        required: true
    },
    tienconlai: {
        type: Number,
        required: true
    },
    createdAt: { type: Date, default: Date.now }, // thời gian mua
    mota: {
        type: String,
        required: false
    },
    domain: { type: String, default: null },
});

const HistoryUser = mongoose.model('HistoryUser', historyUserSchema);

module.exports = HistoryUser;
