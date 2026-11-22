// backend/server.js
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config();

const { connectRabbitMQ } = require('./config/rabbitmq'); // >>> THÊM: Import hàm kết nối RabbitMQ

const User = require('./models/User.model');
const Message = require('./models/Message.model');
const {
  authorizeChatRead,
  authorizeChatWrite
} = require('./services/chatAuthorization.service');
const { apiLimiter } = require('./middleware/rateLimit.middleware');

const normalizeOrigin = (origin) => {
  if (typeof origin !== 'string') return '';
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
};

const getAllowedOrigins = () => {
  const configured = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  if (process.env.NODE_ENV !== 'production') {
    return ['http://localhost:3000'];
  }

  return [];
};

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return getAllowedOrigins().includes(normalized);
};

const corsOriginValidator = (origin, callback) => {
  if (isOriginAllowed(origin)) {
    return callback(null, true);
  }
  return callback(null, false);
};

const corsOptions = {
  origin: corsOriginValidator,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

const createSocketRateLimiter = ({ windowMs = 10000, maxEvents = 10 } = {}) => {
  const buckets = new Map();

  const isAllowed = (key, now = Date.now()) => {
    const bucketKey = String(key);
    const cutoff = now - windowMs;
    const timestamps = (buckets.get(bucketKey) || []).filter((ts) => ts > cutoff);

    if (timestamps.length >= maxEvents) {
      buckets.set(bucketKey, timestamps);
      return false;
    }

    timestamps.push(now);
    buckets.set(bucketKey, timestamps);

    if (buckets.size > 1000) {
      for (const [entryKey, entryTimestamps] of buckets.entries()) {
        const fresh = entryTimestamps.filter((ts) => ts > cutoff);
        if (fresh.length === 0) {
          buckets.delete(entryKey);
        } else {
          buckets.set(entryKey, fresh);
        }
      }
    }

    return true;
  };

  return { isAllowed, buckets };
};

const socketMessageRateLimiter = createSocketRateLimiter({
  windowMs: 10000,
  maxEvents: 10
});

const app = express();
// Tin tưởng 1 lớp reverse proxy (Nginx) cho req.ip, express-rate-limit và VNPay IP
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOriginValidator,
    methods: ['GET', 'POST']
  }
});

// Lắng nghe các sự kiện Real-time
io.use(async (socket, next) => {
  try {
    const authHeader = socket.handshake.headers?.authorization || '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : '';
    const token = socket.handshake.auth?.token || socket.handshake.query?.token || headerToken;

    if (!token) {
      return next(new Error('Unauthorized, no token'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return next(new Error('Tai khoan khong ton tai'));
    }

    if (user.isBanned) {
      return next(new Error('Tai khoan da bi khoa'));
    }

    if (user.suspendedUntil && new Date() < new Date(user.suspendedUntil)) {
      return next(new Error('Tai khoan dang bi dinh chi'));
    }

    socket.user = user;
    next();
  } catch (error) {
    next(new Error('Unauthorized, token failed'));
  }
});

io.on('connection', (socket) => {
  console.log(`[SOCKET] User connected: ${socket.id}`);

  // 1. Tham gia vào phòng chat của 1 Đơn thuê
  socket.on('join_rental_room', async (rentalId) => {
    try {
      const { error } = await authorizeChatRead(rentalId, socket.user);
      if (error) {
        socket.emit('chat_error', { message: error.message });
        return;
      }

      socket.join(rentalId.toString());
      console.log(`User ${socket.id} joined room: ${rentalId}`);
    } catch (error) {
      socket.emit('chat_error', { message: 'Khong the tham gia phong chat' });
    }
  });

  // 2. Lắng nghe tin nhắn mới
  socket.on('send_message', async (data) => {
    // data FE gửi lên sẽ có dạng: { rentalId, senderId, content }
    try {
      const rateLimitKey = socket.user?._id || socket.id;
      if (!socketMessageRateLimiter.isAllowed(rateLimitKey)) {
        socket.emit('chat_error', {
          message: 'Bạn gửi tin nhắn quá nhanh. Vui lòng chờ vài giây rồi thử lại.'
        });
        return;
      }

      const rentalId = data?.rentalId;
      const content = typeof data?.content === 'string' ? data.content.trim() : '';

      if (!content) {
        socket.emit('chat_error', { message: 'Noi dung tin nhan khong duoc de trong' });
        return;
      }

      const { error } = await authorizeChatWrite(rentalId, socket.user);
      if (error) {
        socket.emit('chat_error', { message: error.message });
        return;
      }
      
      // Lưu vào Database để làm bằng chứng sau này
      const savedMessage = await Message.create({
        rentalId,
        senderId: socket.user._id,
        content
      });

      // Phát (Broadcast) tin nhắn đó lại cho tất cả những ai đang trong phòng (bao gồm cả người gửi để hiển thị)
      io.to(rentalId.toString()).emit('receive_message', savedMessage);
      
    } catch (error) {
      console.error('[SOCKET] Lỗi lưu tin nhắn:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SOCKET] User disconnected: ${socket.id}`);
  });
});

const swaggerDocument = YAML.load(path.join(__dirname, '..', 'swagger.yaml'));

// --- Middleware ---
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use('/api', apiLimiter);

// --- Hàm kết nối DB ---
const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('FATAL ERROR: MONGO_URI is not defined.');
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB Connected successfully.');
};

// --- Import & Mount Routes ---
// ... (giữ nguyên không đổi)
const authRoutes = require('./routes/auth.routes');
const itemRoutes = require('./routes/items.routes');
const rentalRoutes = require('./routes/rentals.routes');
const viewRoutes = require('./routes/views.routes');
const adminRoutes = require('./routes/admin.routes');
const uploadRoutes = require('./routes/upload.routes');
const userRoutes = require('./routes/users.routes');

const reviewRoutes = require('./routes/reviews.routes');

const disputeRoutes = require('./routes/disputes.routes'); 

app.use('/api/auth', authRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/rentals', rentalRoutes);
app.use('/api/views', viewRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/users', userRoutes);
app.use('/api/reviews', reviewRoutes);

app.use('/api/disputes', disputeRoutes);

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/', (req, res) => {
  res.send('Backend API is running...');
});

// --- >>> THAY ĐỔI LỚN: TRÌNH TỰ KHỞI ĐỘNG <<< ---
const startServer = async () => {
  try {
    // 1. Kết nối đến DB và chờ hoàn tất
    await connectDB();

    // RabbitMQ phục vụ thông báo; kết nối lại ở nền nếu broker chưa sẵn sàng.
    connectRabbitMQ();

    // 3. Khởi động Express sau khi MongoDB đã sẵn sàng.
    const PORT = process.env.PORT || 5000;
    if (!process.env.JWT_SECRET) {
      throw new Error('FATAL ERROR: JWT_SECRET is not defined.');
    }

    server.listen(PORT, () => {
      console.log(`[SERVER] Đang chạy trên cổng ${PORT} (Đã tích hợp Socket.io Real-time)`);
    });

  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1); // Thoát nếu không thể khởi động
  }
};

// Gọi hàm để bắt đầu toàn bộ quá trình khi chạy trực tiếp
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  startServer,
  getAllowedOrigins,
  isOriginAllowed,
  createSocketRateLimiter
};
