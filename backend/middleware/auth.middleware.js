const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

// Middleware_bảo_vệ_các_route
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Reject scoped single-purpose tokens (e.g. eKYC mobile session tokens)
      if (!decoded || !decoded.id || decoded.purpose) {
        return res.status(401).json({ message: 'Unauthorized, invalid token scope' });
      }
      
      const user = await User.findById(decoded.id).select('-password -resetPasswordToken -resetPasswordExpire');

      if (!user) {
        return res.status(401).json({ message: 'Tài khoản không tồn tại' });
      }

      // KIỂM TRA BỊ BAN VĨNH VIỄN
      if (user.isBanned) {
        return res.status(403).json({ 
          message: 'Tài khoản của bạn đã bị khóa vĩnh viễn do vi phạm nghiêm trọng chính sách của chúng tôi.' 
        });
      }

      // KIỂM TRA ĐANG TRONG THỜI GIAN ĐÌNH CHỈ
      if (user.suspendedUntil && new Date() < new Date(user.suspendedUntil)) {
        const unlockDate = new Date(user.suspendedUntil).toLocaleDateString('vi-VN');
        return res.status(403).json({ 
          message: `Tài khoản của bạn hiện đang bị đình chỉ. Bạn sẽ có thể truy cập lại vào ngày ${unlockDate}.` 
        });
      }

      req.user = user;
      next(); 
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: 'Unauthorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Unauthorized, no token' });
  }
};

// Middleware_kiểm_tra_quyền_Admin
const admin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Forbidden: Admin role required' });
  }
};

// Middleware kiểm tra xem user đã eKYC chưa (Có tick xanh và giấy tờ còn hiệu lực)
const checkVerified = (req, res, next) => {
  if (req.user && req.user.ekycStatus === 'verified') {
    if (req.user.ekycExpiresAt && new Date() > new Date(req.user.ekycExpiresAt)) {
      return res.status(403).json({
        code: 'EKYC_EXPIRED',
        message: 'Forbidden: Giấy tờ tùy thân (CCCD) đã hết hạn hiệu lực. Vui lòng xác thực danh tính (eKYC) lại để sử dụng tính năng này!',
        ekycStatus: 'expired'
      });
    }
    return next(); // Có tick xanh và còn hạn -> Cho qua
  }
  return res.status(403).json({ 
    code: 'EKYC_REQUIRED',
    message: 'Forbidden: Vui lòng xác thực danh tính (eKYC) để sử dụng tính năng này!',
    ekycStatus: req.user ? req.user.ekycStatus : 'unknown'
  });
};

module.exports = { protect, admin, checkVerified };