// backend/controllers/ekyc.controller.js
const { defaultEkycService, EkycDomainError } = require('../services/ekyc.service');
const { InitiationMode } = require('../enums/ekyc.enum');

const resolveFrontendOrigin = (req) => {
  const configured = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const reqOrigin = typeof req.headers.origin === 'string'
    ? req.headers.origin.trim().replace(/\/+$/, '')
    : '';

  if (reqOrigin && (configured.includes(reqOrigin) || process.env.NODE_ENV !== 'production')) {
    try {
      const parsed = new URL(reqOrigin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // ignore invalid origin header
    }
  }

  return configured[0] || 'http://localhost:3000';
};

const handleControllerError = (res, error) => {
  if (error instanceof EkycDomainError) {
    const body = {
      code: error.code || 'EKYC_ERROR',
      message: error.message
    };
    if (error.details && typeof error.details === 'object') {
      Object.assign(body, error.details);
    }
    return res.status(error.statusCode || 400).json(body);
  }

  console.error('[eKYC][ControllerError]', {
    name: error?.name || 'Error',
    code: error?.code || 'UNEXPECTED_ERROR'
  });

  return res.status(500).json({
    code: 'EKYC_INTERNAL_ERROR',
    message: 'Đã xảy ra lỗi hệ thống trong quá trình xác minh danh tính. Vui lòng thử lại sau.'
  });
};

const createEkycController = ({ ekycService = defaultEkycService } = {}) => {
  const getEkycStatus = async (req, res) => {
    try {
      const result = await ekycService.getAccountEkycStatus(req.user._id);
      return res.status(200).json(result);
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const createVerificationSession = async (req, res) => {
    try {
      const rawMode = String(req.body?.initiationMode || 'QR').toUpperCase();
      const initiationMode = rawMode === InitiationMode.DIRECT ? InitiationMode.DIRECT : InitiationMode.QR;

      const result = await ekycService.createSession({
        userId: req.user._id,
        initiationMode,
        frontendBaseUrl: resolveFrontendOrigin(req),
        userAgent: req.headers['user-agent'] || ''
      });

      return res.status(201).json(result);
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const claimVerificationSession = async (req, res) => {
    try {
      const handoffToken = req.body?.token;
      const result = await ekycService.claimSession({
        handoffToken,
        userAgent: req.headers['user-agent'] || ''
      });
      return res.status(200).json(result);
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const getVerificationSession = async (req, res) => {
    try {
      if (req.ekycAuthMode === 'MOBILE' && req.ekycSession) {
        const sessionPayload = await ekycService.getSessionForMobile({
          session: req.ekycSession
        });
        return res.status(200).json({ mode: 'MOBILE', session: sessionPayload });
      }

      const sessionPayload = await ekycService.getSessionForOwner({
        sessionId: req.params.sessionId,
        userId: req.user._id
      });
      return res.status(200).json({ mode: 'DESKTOP', session: sessionPayload });
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const submitConsent = async (req, res) => {
    try {
      const accepted = req.body?.accepted === true;
      const sessionPayload = await ekycService.acceptConsent({
        session: req.ekycSession,
        accepted
      });
      return res.status(200).json({
        message: 'Đã ghi nhận đồng ý xử lý dữ liệu cá nhân.',
        session: sessionPayload
      });
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const submitDocuments = async (req, res) => {
    try {
      const frontFile = req.files?.frontImage?.[0];
      const backFile = req.files?.backImage?.[0];

      const sessionPayload = await ekycService.submitDocuments({
        session: req.ekycSession,
        frontBuffer: frontFile?.buffer || null,
        backBuffer: backFile?.buffer || null
      });

      return res.status(200).json({
        message: 'Kiểm tra giấy tờ và bóc tách thông tin CCCD thành công.',
        session: sessionPayload
      });
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const confirmDocument = async (req, res) => {
    try {
      const action = req.body?.action || 'CONFIRM';
      const sessionPayload = await ekycService.confirmDocumentOcr({
        session: req.ekycSession,
        action
      });
      return res.status(200).json({
        message: String(action).toUpperCase() === 'RETAKE'
          ? 'Đã chuyển về bước chụp lại giấy tờ CCCD.'
          : 'Đã xác nhận thông tin CCCD. Vui lòng thực hiện kiểm tra thực thể sống 5 tư thế khuôn mặt.',
        session: sessionPayload
      });
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const submitLivenessPose = async (req, res) => {
    try {
      const poseBuffer = req.file?.buffer || null;
      const requestedPose = req.body?.pose;

      const result = await ekycService.submitLivenessPose({
        session: req.ekycSession,
        poseBuffer,
        requestedPose
      });

      return res.status(200).json({
        message: result.completed
          ? 'Hoàn tất kiểm tra thực thể sống 5/5 tư thế! Kết quả đã được đồng bộ với tài khoản.'
          : `Đạt tư thế ${result.passedPose}. Vui lòng tiếp tục thực hiện tư thế tiếp theo.`,
        completed: result.completed,
        passedPose: result.passedPose,
        nextPose: result.nextPose,
        session: result.session
      });
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  const deprecatedFaceMatching = async (req, res) => res.status(410).json({
    code: 'FACE_MATCHING_REPLACED_BY_LIVENESS',
    message: 'Bước đối sánh khuôn mặt đã được thay thế bằng quy trình kiểm tra thực thể sống 5 tư thế (/api/ekyc/sessions/:sessionId/liveness).'
  });

  const cancelVerificationSession = async (req, res) => {
    try {
      const cancelledPayload = req.ekycAuthMode === 'MOBILE' && req.ekycSession
        ? await ekycService.cancelSession({
            sessionId: req.params.sessionId,
            mobileSession: req.ekycSession
          })
        : await ekycService.cancelSession({
            sessionId: req.params.sessionId,
            userId: req.user._id
          });

      return res.status(200).json({
        message: 'Đã hủy phiên xác minh danh tính.',
        session: cancelledPayload
      });
    } catch (error) {
      return handleControllerError(res, error);
    }
  };

  return {
    getEkycStatus,
    createVerificationSession,
    claimVerificationSession,
    getVerificationSession,
    submitConsent,
    submitDocuments,
    confirmDocument,
    submitLivenessPose,
    deprecatedFaceMatching,
    cancelVerificationSession
  };
};

const defaultController = createEkycController();

module.exports = {
  createEkycController,
  ...defaultController
};
