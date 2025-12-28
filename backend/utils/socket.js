// Socket.IO instance và quản lý connections
let io = null;

// Khởi tạo Socket.IO với HTTP server
function initSocket(server) {
    const { Server } = require('socket.io');
    
    // Lấy URL_WEBSITE từ env để cấu hình CORS
    const rawAllowed = process.env.URL_WEBSITE || '';
    let allowedOrigins = [];
    
    try {
        const u = new URL(rawAllowed);
        const hostname = u.hostname;
        // Cho phép cả http và https
        allowedOrigins = [
            `http://${hostname}`,
            `https://${hostname}`,
            `http://www.${hostname}`,
            `https://www.${hostname}`
        ];
    } catch (e) {
        // Nếu không parse được URL, sử dụng trực tiếp
        if (rawAllowed) {
            allowedOrigins = [rawAllowed];
        }
    }
    
    io = new Server(server, {
        cors: {
            origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    io.on('connection', (socket) => {
        console.log(`✅ Socket client connected: ${socket.id}`);
        
        // Lắng nghe sự kiện join room theo username
        socket.on('join-user-room', (username) => {
            if (username) {
                socket.join(`user:${username}`);
                console.log(`👤 User ${username} joined room: user:${username}`);
            }
        });
        
        socket.on('disconnect', () => {
            console.log(`❌ Socket client disconnected: ${socket.id}`);
        });
    });

    console.log('🔌 Socket.IO đã được khởi tạo');
    return io;
}

// Lấy Socket.IO instance
function getIO() {
    if (!io) {
        throw new Error('Socket.IO chưa được khởi tạo. Gọi initSocket(server) trước.');
    }
    return io;
}

// Emit event nạp tiền thành công
function emitDepositSuccess(username, data) {
    if (!io) {
        console.warn('⚠️ Socket.IO chưa được khởi tạo, không thể emit event');
        return;
    }
    
    // Emit đến room của user cụ thể
    io.to(`user:${username}`).emit('deposit-success', data);
    
    
    console.log(`📢 Đã emit event deposit-success cho user: ${username}`);
}

// Emit event mua đơn hàng thành công
function emitOrderSuccess(username, data) {
    if (!io) {
        console.warn('⚠️ Socket.IO chưa được khởi tạo, không thể emit event');
        return;
    }
    
    // Emit đến room của user cụ thể
    io.to(`user:${username}`).emit('order-success', data);
    
    
    console.log(`📢 Đã emit event order-success cho user: ${username}`);
}

module.exports = {
    initSocket,
    getIO,
    emitDepositSuccess,
    emitOrderSuccess
};
