// backend/middleware/ekycAuth.middleware.js
const crypto = require('crypto');
const User = require('../models/User.model');
const VerificationSession = require('../models/VerificationSession.model');
const { protect } = require('./auth.middleware');
const {
  hashToken,
  verifyEkycMobileSessionToken
} = require('../utils/ekycCrypto');

const safeTimingEqualHex = (hexA, hexB) => {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== 64 || hexB.length !== 64) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
  } catch {
    return false;
  }
};

const createEkycAuthMiddleware = ({
  SessionModel = VerificationSession,
  UserModel = User,
  protectMiddleware = protect
} = {}) => {
  /**
   * Authenticates mobile eKYC workflow requests strictly scoped to `:sessionId`.
   * Does NOT grant access to any general user account endpoints.
   */
  const protectEkycMobileSession = async (req, res, next) => {
    const rawToken = req.headers['x-ekyc-session-token'];
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';

    if (!token) {
      return res.status(401).json({
        code: 'MISSING_EKYC_SESSION_TOKEN',
        message: 'Phiên xác minh trên thiết bị di động không hợp lệ hoặc thiếu thông tin xác thực.'
      });
    }

    let decoded;
    try {
      decoded = verifyEkycMobileSessionToken(token);
    } catch (err) {
      const isExpired = err?.name === 'TokenExpiredError';
      return res.status(isExpired ? 410 : 401).json({
        code: isExpired ? 'SESSION_EXPIRED' : 'INVALID_EKYC_SESSION_TOKEN',
        message: isExpired
          ? 'Phiên xác minh đã hết hạn. Vui lòng tạo lại mã QR mới.'
          : 'Thông tin xác thực phiên eKYC không hợp lệ.'
      });
    }

    const paramSessionId = String(req.params.sessionId || '');
    if (!paramSessionId || String(decoded.sid) !== paramSessionId) {
      return res.status(403).json({
        code: 'SESSION_SCOPE_MISMATCH',
        message: 'Bạn không có quyền truy cập phiên xác minh này.'
      });
    }

    try {
      const session = await SessionModel.findOne({ sessionId: paramSessionId })
        .select('+mobileAccessTokenHash');

      if (!session) {
        return res.status(404).json({
          code: 'SESSION_NOT_FOUND',
          message: 'Không tìm thấy phiên xác minh.'
        });
      }

      if (session.status === 'CANCELLED') {
        return res.status(410).json({
          code: 'SESSION_CANCELLED',
          message: 'Phiên xác minh đã bị hủy.'
        });
      }

      const incomingHash = hashToken(token);
      if (!session.mobileAccessTokenHash || !safeTimingEqualHex(incomingHash, session.mobileAccessTokenHash)) {
        return res.status(401).json({
          code: 'REVOKED_EKYC_SESSION_TOKEN',
          message: 'Phiên xác minh không còn hiệu lực trên thiết bị này.'
        });
      }

      const owner = await UserModel.findById(session.userId).select('_id isBanned suspendedUntil');
      if (
        !owner
        || owner.isBanned
        || (owner.suspendedUntil && new Date() < new Date(owner.suspendedUntil))
      ) {
        return res.status(403).json({
          code: 'ACCOUNT_RESTRICTED',
          message: 'Tài khoản liên kết không đủ điều kiện thực hiện xác minh.'
        });
      }

      req.ekycSession = session;
      req.ekycAuthMode = 'MOBILE';
      return next();
    } catch {
      return res.status(500).json({
        code: 'INTERNAL_AUTH_ERROR',
        message: 'Không thể kiểm tra trạng thái phiên xác minh.'
      });
    }
  };

  /**
   * Allows either the Mobile session holder (via `X-Ekyc-Session-Token`)
   * OR the logged-in Desktop session owner (via `Authorization: Bearer`)
   * to read or cancel `:sessionId`.
   */
  const protectEkycOwnerOrMobile = (req, res, next) => {
    const hasMobileHeader = typeof req.headers['x-ekyc-session-token'] === 'string'
      && req.headers['x-ekyc-session-token'].trim().length > 0;

    if (hasMobileHeader) {
      return protectEkycMobileSession(req, res, next);
    }

    return protectMiddleware(req, res, (err) => {
      if (err) return next(err);
      req.ekycAuthMode = 'OWNER';
      return next();
    });
  };

  return {
    protectEkycMobileSession,
    protectEkycOwnerOrMobile
  };
};

const defaultMiddleware = createEkycAuthMiddleware();

module.exports = {
  createEkycAuthMiddleware,
  ...defaultMiddleware
};
