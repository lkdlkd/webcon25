const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    sender: {
        type: String,
        required: true,
        ref: 'User'
    },
    senderRole: {
        type: String,
        enum: ['user', 'admin'],
        required: true
    },
    message: {
        type: String,
        required: true,
        trim: true
    },
    isRead: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const ChatSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        ref: 'User',
        unique: true,
        index: true
    },
    messages: [MessageSchema],
    lastMessage: {
        type: String,
        default: ''
    },
    lastMessageTime: {
        type: Date,
        default: Date.now
    },
    unreadCount: {
        type: Number,
        default: 0
    },
    unreadAdminCount: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['active', 'closed'],
        default: 'active'
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

ChatSchema.index({ username: 1 });
ChatSchema.index({ updatedAt: -1 });
ChatSchema.index({ status: 1 });

module.exports = mongoose.model('Chat', ChatSchema);
