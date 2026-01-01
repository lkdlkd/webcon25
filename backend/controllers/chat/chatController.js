const Chat = require('../../models/Chat');
const User = require('../../models/User');
const { emitNewChatMessage } = require('../../utils/socket');

// Lấy danh sách chat
async function getChatList(req, res) {
    try {
        const user = req.user;
        const { page = 1, limit = 20, unreadOnly = 'false', search = '' } = req.query;
        let filter = {};

        if (user.role !== 'admin') {
            filter.username = user.username;
        }

        // Lọc chỉ tin nhắn chưa đọc nếu admin yêu cầu
        if (user.role === 'admin' && unreadOnly === 'true') {
            filter.unreadAdminCount = { $gt: 0 };
        }

        // Tìm kiếm theo username
        if (search && search.trim()) {
            filter.username = { $regex: search.trim(), $options: 'i' };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const chats = await Chat.find(filter)
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .select('-messages')
            .lean();

        const chatWithUserInfo = await Promise.all(chats.map(async (chat) => {
            const userInfo = await User.findOne({ username: chat.username })
                .select('username email capbac')
                .lean();
            return {
                ...chat,
                userInfo
            };
        }));

        res.status(200).json({
            success: true,
            data: chatWithUserInfo
        });
    } catch (error) {
        console.error('Error getting chat list:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách chat',
            error: error.message
        });
    }
}

// Lấy chi tiết một cuộc hội thoại
async function getChatDetail(req, res) {
    try {
        const user = req.user;
        const { username } = req.params;
        const { limit = 20, skip = 0 } = req.query;

        if (user.role !== 'admin' && user.username !== username) {
            return res.status(403).json({
                success: false,
                message: 'Bạn không có quyền xem chat này'
            });
        }

        // Lấy total count của messages
        const chatForCount = await Chat.findOne({ username }).select('messages').lean();
        const totalMessages = chatForCount?.messages?.length || 0;

        let chat = await Chat.findOne({ username })
            .select({
                username: 1,
                lastMessage: 1,
                lastMessageTime: 1,
                unreadCount: 1,
                unreadAdminCount: 1,
                status: 1,
                messages: { $slice: [-(parseInt(skip) + parseInt(limit)), parseInt(limit)] }
            })
            .lean();

        if (!chat) {
            chat = await Chat.create({
                username,
                messages: [],
                lastMessage: '',
                lastMessageTime: new Date(),
                unreadCount: 0,
                unreadAdminCount: 0,
                status: 'active'
            });
        }

        // Thêm thông tin pagination
        const hasMore = totalMessages > (parseInt(skip) + parseInt(limit));
        chat.totalMessages = totalMessages;
        chat.hasMore = hasMore;

        if (user.role === 'admin') {
            await Chat.updateOne(
                { username },
                { $set: { unreadAdminCount: 0 } }
            );
        } else {
            await Chat.updateOne(
                { username },
                { $set: { unreadCount: 0 } }
            );
        }

        res.status(200).json({
            success: true,
            data: chat
        });
    } catch (error) {
        console.error('Error getting chat detail:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy chi tiết chat',
            error: error.message
        });
    }
}

// Gửi tin nhắn
async function sendMessage(req, res) {
    try {
        const user = req.user;
        const { username, message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Nội dung tin nhắn không được để trống'
            });
        }

        if (user.role !== 'admin' && user.username !== username) {
            return res.status(403).json({
                success: false,
                message: 'Bạn không có quyền gửi tin nhắn này'
            });
        }

        const senderRole = user.role === 'admin' ? 'admin' : 'user';
        const newMessage = {
            sender: senderRole === 'admin' ? 'Admin' : user.username,
            senderRole,
            message: message.trim(),
            isRead: false,
            createdAt: new Date()
        };

        let chat = await Chat.findOne({ username });

        if (!chat) {
            chat = new Chat({
                username,
                messages: [newMessage],
                lastMessage: message.trim(),
                lastMessageTime: new Date(),
                unreadCount: senderRole === 'admin' ? 1 : 0,
                unreadAdminCount: senderRole === 'user' ? 1 : 0,
                status: 'active'
            });
        } else {
            chat.messages.push(newMessage);
            chat.lastMessage = message.trim();
            chat.lastMessageTime = new Date();
            chat.updatedAt = new Date();
            
            if (senderRole === 'admin') {
                chat.unreadCount += 1;
            } else {
                chat.unreadAdminCount += 1;
            }
        }

        await chat.save();

        const messageData = {
            _id: chat.messages[chat.messages.length - 1]._id,
            sender: newMessage.sender,
            senderRole: newMessage.senderRole,
            message: newMessage.message,
            createdAt: newMessage.createdAt,
            username,
            chatId: chat._id
        };

        // Emit socket event để realtime
        emitNewChatMessage(username, messageData);

        res.status(200).json({
            success: true,
            message: 'Gửi tin nhắn thành công',
            data: messageData
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi gửi tin nhắn',
            error: error.message
        });
    }
}

// Đánh dấu đã đọc
async function markAsRead(req, res) {
    try {
        const user = req.user;
        const { username } = req.params;

        if (user.role !== 'admin' && user.username !== username) {
            return res.status(403).json({
                success: false,
                message: 'Bạn không có quyền thực hiện hành động này'
            });
        }

        const updateField = user.role === 'admin' 
            ? { unreadAdminCount: 0 }
            : { unreadCount: 0 };

        await Chat.updateOne({ username }, { $set: updateField });

        res.status(200).json({
            success: true,
            message: 'Đã đánh dấu đã đọc'
        });
    } catch (error) {
        console.error('Error marking as read:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi đánh dấu đã đọc',
            error: error.message
        });
    }
}

// Lấy số lượng tin nhắn chưa đọc
async function getUnreadCount(req, res) {
    try {
        const user = req.user;

        if (user.role === 'admin') {
            const result = await Chat.aggregate([
                { $match: { unreadAdminCount: { $gt: 0 } } },
                { $group: { _id: null, total: { $sum: '$unreadAdminCount' } } }
            ]);

            const unreadCount = result.length > 0 ? result[0].total : 0;

            res.status(200).json({
                success: true,
                data: { unreadCount }
            });
        } else {
            const chat = await Chat.findOne({ username: user.username })
                .select('unreadCount')
                .lean();

            res.status(200).json({
                success: true,
                data: { unreadCount: chat?.unreadCount || 0 }
            });
        }
    } catch (error) {
        console.error('Error getting unread count:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy số tin nhắn chưa đọc',
            error: error.message
        });
    }
}


// Xóa toàn bộ chat
async function deleteChat(req, res) {
    try {
        const user = req.user;
        const { username } = req.params;

        if (user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Chỉ admin mới có quyền xóa chat'
            });
        }

        await Chat.deleteOne({ username });

        res.status(200).json({
            success: true,
            message: 'Đã xóa chat'
        });
    } catch (error) {
        console.error('Error deleting chat:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa chat',
            error: error.message
        });
    }
}

module.exports = {
    getChatList,
    getChatDetail,
    sendMessage,
    markAsRead,
    getUnreadCount,
    deleteChat
};
