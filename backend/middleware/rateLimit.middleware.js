// backend/middleware/rateLimit.middleware.js
const { rateLimit } = require('express-rate-limit');

const createRateLimiter = ({ windowMs, limit, message }) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message }
});

// General baseline limit for all /api routes
const apiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: 'Quá nhiều yêu cầu từ địa chỉ IP này. Vui lòng thử lại sau ít phút.'
});

// Strict limit for login attempts
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau 15 phút.'
});

// Strict limit for password reset requests
const forgotPasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Quá nhiều yêu cầu khôi phục mật khẩu. Vui lòng thử lại sau 15 phút.'
});

// Limit for Cloudinary upload / delete operations
const uploadLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Bạn tải hoặc xóa ảnh quá nhanh. Vui lòng thử lại sau ít phút.'
});

// Strict limit for paid external AI endpoints (Gemini / FPT.AI eKYC)
const aiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Bạn gọi tính năng AI quá nhiều lần. Vui lòng thử lại sau 15 phút.'
});

module.exports = {
  createRateLimiter,
  apiLimiter,
  loginLimiter,
  forgotPasswordLimiter,
  uploadLimiter,
  aiLimiter
};
