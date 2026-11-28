// backend/services/ekyc.service.js
const crypto = require('crypto');
const User = require('../models/User.model');
const IdentityProfile = require('../models/IdentityProfile.model');
const VerificationSession = require('../models/VerificationSession.model');
const EkycTempAsset = require('../models/EkycTempAsset.model');
const AuditLog = require('../models/AuditLog.model');
const { getEkycConfig } = require('../config/ekyc.config');
const {
  VerificationSessionStatus,
  EkycStep,
  ProcessingStage,
  InitiationMode,
  LivenessPose,
  ALL_LIVENESS_POSES,
  DIRECTIONAL_LIVENESS_POSES,
  UserEkycStatus,
  VerificationMethod,
  TERMINAL_SESSION_STATUSES,
  ACTIVE_SESSION_STATUSES
} = require('../enums/ekyc.enum');
const {
  generateHandoffToken,
  generateSessionId,
  hashToken,
  computeIdNumberHmac,
  maskIdNumber,
  encryptSensitiveText,
  createEkycMobileSessionToken
} = require('../utils/ekycCrypto');
const { validateEkycImageBuffer } = require('../utils/imageValidator');
const { defaultViettelAiProvider } = require('./viettelAi.provider');
const { emitEkycSessionUpdate } = require('./ekycRealtime.service');
const {
  recalculateUserTrustScore,
  getTrustLevelFromScore
} = require('./trustScore.service');

class EkycDomainError extends Error {
  constructor(message, { statusCode = 400, code = 'EKYC_ERROR', details = null } = {}) {
    super(message);
    this.name = 'EkycDomainError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const PERMANENT_EXPIRY_PATTERNS = [
  'không thời hạn',
  'khong thoi han',
  'vô thời hạn',
  'vo thoi han',
  'không giới hạn'
];

const POSE_LABELS_VI = Object.freeze({
  [LivenessPose.PORTRAIT]: 'Nhìn thẳng vào camera',
  [LivenessPose.LEFT]: 'Quay đầu sang trái',
  [LivenessPose.RIGHT]: 'Quay đầu sang phải',
  [LivenessPose.TOP]: 'Ngẩng đầu lên',
  [LivenessPose.BOTTOM]: 'Cúi đầu xuống'
});

/**
 * Generates ['Portrait', ...CSPRNG-shuffled(['Left', 'Right', 'Top', 'Bottom'])].
 */
const generateLivenessChallengeSequence = () => {
  const directional = [...DIRECTIONAL_LIVENESS_POSES];
  for (let i = directional.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const tmp = directional[i];
    directional[i] = directional[j];
    directional[j] = tmp;
  }
  return [LivenessPose.PORTRAIT, ...directional];
};

const createEmptyLivenessResults = () => ({
  Portrait: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
  Left: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
  Right: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
  Top: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
  Bottom: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null }
});

const cleanOcrText = (raw) => {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().replace(/\s+/g, ' ');
};

const parseCalendarDateParts = (rawText) => {
  const value = cleanOcrText(rawText);
  if (!value) return null;

  let day;
  let month;
  let year;

  const dmyMatch = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmyMatch) {
    day = Number.parseInt(dmyMatch[1], 10);
    month = Number.parseInt(dmyMatch[2], 10);
    year = Number.parseInt(dmyMatch[3], 10);
  } else {
    const ymdMatch = value.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
    if (ymdMatch) {
      year = Number.parseInt(ymdMatch[1], 10);
      month = Number.parseInt(ymdMatch[2], 10);
      day = Number.parseInt(ymdMatch[3], 10);
    } else {
      return null;
    }
  }

  if (year < 1900 || year > 2150 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null;
  }

  const endOfDayVn = new Date(Date.UTC(year, month - 1, day, 16, 59, 59, 999));

  return {
    day,
    month,
    year,
    formatted: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
    endOfDayVn
  };
};

const validateAndNormalizeOcr = (information, now = new Date()) => {
  if (!information || typeof information !== 'object') {
    return {
      valid: false,
      code: 'OCR_INVALID_PAYLOAD',
      message: 'Dữ liệu bóc tách giấy tờ không hợp lệ. Vui lòng chụp lại hai mặt CCCD.'
    };
  }

  const passportId = cleanOcrText(information.passport_id);
  const licenceClass = cleanOcrText(information.licence_class);
  const militaryTitle = cleanOcrText(information.military_title);
  if (passportId || licenceClass || militaryTitle) {
    return {
      valid: false,
      code: 'UNSUPPORTED_DOCUMENT_TYPE',
      message: 'Hệ thống hiện chỉ hỗ trợ xác minh bằng thẻ Căn cước công dân (CCCD) hai mặt.'
    };
  }

  const documentField = cleanOcrText(information.document);
  const typeListField = cleanOcrText(information.type_list);
  const typeField = cleanOcrText(information.type);

  if (typeListField) {
    const lowerSides = typeListField
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!lowerSides.includes('front') || !lowerSides.includes('back')) {
      return {
        valid: false,
        code: 'INCOMPLETE_DOCUMENT_SIDES',
        message: 'Chưa nhận diện đủ mặt trước và mặt sau của CCCD. Vui lòng chụp đúng mặt trước ở bước 1 và mặt sau ở bước 2.'
      };
    }
  }

  if (documentField) {
    const lowerDoc = documentField.toLowerCase();
    if (!lowerDoc.includes('cccd')) {
      return {
        valid: false,
        code: 'UNSUPPORTED_DOCUMENT_TYPE',
        message: 'Loại giấy tờ không thuộc phạm vi CCCD được hỗ trợ. Vui lòng sử dụng thẻ Căn cước công dân hai mặt.'
      };
    }
    if (
      (lowerDoc.includes('front') || lowerDoc.includes('back'))
      && (!lowerDoc.includes('front') || !lowerDoc.includes('back'))
    ) {
      return {
        valid: false,
        code: 'INCOMPLETE_DOCUMENT_SIDES',
        message: 'Ảnh chụp hai mặt CCCD không khớp mặt trước/mặt sau. Vui lòng kiểm tra và chụp lại.'
      };
    }
  }

  const idNumber = cleanOcrText(information.id).replace(/\s+/g, '');
  const fullName = cleanOcrText(information.name);
  const birthdayRaw = cleanOcrText(information.birthday);
  const issueDateRaw = cleanOcrText(information.issue_date);
  const expiryRaw = cleanOcrText(information.expiry);

  if (!idNumber || !fullName || !birthdayRaw || !issueDateRaw || !expiryRaw) {
    return {
      valid: false,
      code: 'OCR_MISSING_REQUIRED_FIELDS',
      message: 'Ảnh chụp CCCD bị thiếu hoặc mờ thông tin bắt buộc (Số CCCD, Họ tên, Ngày sinh, Ngày cấp hoặc Ngày hết hạn). Vui lòng chụp lại rõ nét cả hai mặt.'
    };
  }

  if (!/^\d{12}$/.test(idNumber)) {
    return {
      valid: false,
      code: 'INVALID_CCCD_NUMBER',
      message: 'Số Căn cước công dân nhận dạng được không hợp lệ (cần đủ 12 chữ số). Vui lòng chụp lại mặt trước CCCD rõ nét.'
    };
  }

  if (fullName.length < 2) {
    return {
      valid: false,
      code: 'INVALID_FULL_NAME',
      message: 'Họ và tên trên CCCD không hợp lệ. Vui lòng chụp lại mặt trước CCCD rõ nét.'
    };
  }

  const parsedBirthday = parseCalendarDateParts(birthdayRaw);
  if (!parsedBirthday || parsedBirthday.endOfDayVn > now) {
    return {
      valid: false,
      code: 'INVALID_BIRTHDAY',
      message: 'Ngày sinh nhận dạng trên CCCD không hợp lệ. Vui lòng chụp lại mặt trước CCCD.'
    };
  }

  const parsedIssueDate = parseCalendarDateParts(issueDateRaw);
  if (!parsedIssueDate || parsedIssueDate.endOfDayVn > new Date(now.getTime() + 24 * 60 * 60 * 1000)) {
    return {
      valid: false,
      code: 'INVALID_ISSUE_DATE',
      message: 'Ngày cấp nhận dạng ở mặt sau CCCD không hợp lệ. Vui lòng chụp lại mặt sau CCCD rõ nét.'
    };
  }

  const lowerExpiry = expiryRaw.toLowerCase();
  const isPermanentExpiry = PERMANENT_EXPIRY_PATTERNS.some((p) => lowerExpiry.includes(p));
  let expiryDate = null;
  let normalizedExpiryText = expiryRaw;

  if (!isPermanentExpiry) {
    const parsedExpiry = parseCalendarDateParts(expiryRaw);
    if (!parsedExpiry) {
      return {
        valid: false,
        code: 'INVALID_EXPIRY_DATE',
        message: 'Không đọc được ngày hết hạn hợp lệ trên CCCD. Vui lòng chụp lại mặt trước CCCD rõ nét.'
      };
    }

    if (parsedExpiry.endOfDayVn < now) {
      return {
        valid: false,
        code: 'DOCUMENT_EXPIRED',
        message: `Thẻ CCCD đã hết hạn sử dụng (${parsedExpiry.formatted}). Vui lòng sử dụng giấy tờ còn thời hạn hiệu lực.`
      };
    }

    expiryDate = parsedExpiry.endOfDayVn;
    normalizedExpiryText = parsedExpiry.formatted;
  } else {
    normalizedExpiryText = 'Không thời hạn';
  }

  return {
    valid: true,
    normalized: {
      idNumber,
      idNumberMasked: maskIdNumber(idNumber),
      fullName,
      birthday: parsedBirthday.formatted,
      sex: cleanOcrText(information.sex),
      nationality: cleanOcrText(information.nationality) || 'Việt Nam',
      address: cleanOcrText(information.address),
      hometown: cleanOcrText(information.hometown),
      issueDate: parsedIssueDate.formatted,
      issueBy: cleanOcrText(information.issue_by),
      expiryRaw: normalizedExpiryText,
      expiryDate,
      isPermanentExpiry,
      documentType: documentField || typeField || 'cccd',
      typeList: typeListField
    }
  };
};

const countPassedLivenessPoses = (session) => {
  if (!session?.livenessResults) return 0;
  return ALL_LIVENESS_POSES.filter((pose) => Boolean(session.livenessResults[pose]?.passed)).length;
};

const getDesktopUiPhase = (session) => {
  if (!session) return { code: 'UNKNOWN', label: 'Không xác định' };
  const passedPoses = countPassedLivenessPoses(session);
  const totalPoses = ALL_LIVENESS_POSES.length;

  switch (session.status) {
    case VerificationSessionStatus.CREATED:
      return { code: 'WAITING_QR_SCAN', label: 'Đang chờ quét mã QR' };
    case VerificationSessionStatus.CLAIMED:
      return { code: 'MOBILE_CONNECTED', label: 'Điện thoại đã kết nối' };
    case VerificationSessionStatus.CONSENT_ACCEPTED:
      return { code: 'CAPTURING_DOCUMENTS', label: 'Đang chụp giấy tờ tùy thân' };
    case VerificationSessionStatus.DOCUMENT_PROCESSING:
      if (session.processingStage === ProcessingStage.OCR) {
        return { code: 'EXTRACTING_OCR', label: 'Đang bóc tách thông tin' };
      }
      return { code: 'CHECKING_DOCUMENTS', label: 'Đang kiểm tra giấy tờ' };
    case VerificationSessionStatus.DOCUMENT_VERIFIED:
      return { code: 'EXTRACTING_OCR', label: 'Đang chờ người dùng xác nhận thông tin CCCD' };
    case VerificationSessionStatus.DOCUMENT_CONFIRMED:
    case VerificationSessionStatus.LIVENESS_IN_PROGRESS:
      return {
        code: 'VERIFYING_LIVENESS',
        label: `Đang kiểm tra thực thể sống (${passedPoses}/${totalPoses} tư thế)`
      };
    case VerificationSessionStatus.LIVENESS_PROCESSING:
    case VerificationSessionStatus.FACE_PROCESSING:
      if (session.processingStage === ProcessingStage.FINALIZING) {
        return { code: 'FINALIZING_RESULT', label: 'Đang xử lý kết quả' };
      }
      return {
        code: 'VERIFYING_LIVENESS',
        label: `Đang kiểm tra thực thể sống (${Math.min(totalPoses, passedPoses + 1)}/${totalPoses})`
      };
    case VerificationSessionStatus.DOCUMENT_RETRY_REQUIRED:
    case VerificationSessionStatus.LIVENESS_RETRY_REQUIRED:
    case VerificationSessionStatus.FACE_RETRY_REQUIRED:
    case VerificationSessionStatus.FAILED:
      return { code: 'RETRY_REQUIRED', label: 'Cần xác minh lại' };
    case VerificationSessionStatus.COMPLETED:
      return { code: 'VERIFIED_SUCCESS', label: 'Xác minh thành công' };
    case VerificationSessionStatus.EXPIRED:
      return { code: 'SESSION_EXPIRED', label: 'Phiên xác minh đã hết hạn' };
    case VerificationSessionStatus.CANCELLED:
      return { code: 'SESSION_CANCELLED', label: 'Phiên xác minh đã bị hủy' };
    default:
      return { code: 'PROCESSING', label: 'Đang xử lý kết quả' };
  }
};

const buildLivenessProgressSummary = (session) => {
  const challenges = Array.isArray(session?.livenessChallenges) ? session.livenessChallenges : [];
  const totalPoses = ALL_LIVENESS_POSES.length;
  const currentIndex = Number.isInteger(session?.currentPoseIndex) ? session.currentPoseIndex : 0;
  const currentPose = currentIndex >= 0 && currentIndex < challenges.length ? challenges[currentIndex] : null;
  const completedCount = countPassedLivenessPoses(session);

  const poses = challenges.map((pose, idx) => ({
    index: idx + 1,
    pose,
    instruction: POSE_LABELS_VI[pose] || pose,
    passed: Boolean(session?.livenessResults?.[pose]?.passed),
    isCurrent: idx === currentIndex && !session?.livenessVerified
  }));

  return {
    totalPoses,
    completedCount,
    currentPoseIndex: currentIndex,
    currentPoseNumber: currentPose ? currentIndex + 1 : totalPoses,
    currentPose,
    currentPoseInstruction: currentPose ? (POSE_LABELS_VI[currentPose] || currentPose) : '',
    poses
  };
};

const toDesktopSafeSessionPayload = (session) => {
  if (!session) return null;
  const uiPhase = getDesktopUiPhase(session);
  const livenessProgress = buildLivenessProgressSummary(session);

  return {
    sessionId: session.sessionId,
    initiationMode: session.initiationMode,
    status: session.status,
    processingStage: session.processingStage,
    currentStep: session.currentStep,
    uiPhase: uiPhase.code,
    uiPhaseLabel: uiPhase.label,
    mobileConnected: Boolean(session.claimedAt),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    claimedAt: session.claimedAt,
    completedAt: session.completedAt,
    cancelledAt: session.cancelledAt,
    documentAttempts: session.documentAttempts,
    maxDocumentAttempts: session.maxDocumentAttempts,
    livenessRetries: session.livenessRetries || 0,
    maxLivenessRetries: session.maxLivenessRetries || 5,
    livenessCompletedPoses: livenessProgress.completedCount,
    livenessTotalPoses: livenessProgress.totalPoses,
    failureCode: session.failureCode || '',
    failureReason: session.failureReason || '',
    resultSummary: session.status === VerificationSessionStatus.COMPLETED
      ? {
          verifiedFullName: session.ocrSummary?.fullName || '',
          idNumberMasked: session.ocrSummary?.idNumberMasked || '',
          verificationMethod: VerificationMethod.DOCUMENT_AND_LIVENESS,
          livenessVerified: true,
          faceMatchingVerified: null,
          cccdOwnershipVerified: false
        }
      : null
  };
};

const toMobileSessionPayload = (session) => {
  if (!session) return null;
  const showOcrPreview = Boolean(
    session.documentVerified
    && session.ocrSummary
    && [
      VerificationSessionStatus.DOCUMENT_VERIFIED,
      VerificationSessionStatus.DOCUMENT_CONFIRMED,
      VerificationSessionStatus.LIVENESS_IN_PROGRESS,
      VerificationSessionStatus.LIVENESS_PROCESSING,
      VerificationSessionStatus.LIVENESS_RETRY_REQUIRED,
      VerificationSessionStatus.COMPLETED
    ].includes(session.status)
  );

  const livenessProgress = buildLivenessProgressSummary(session);
  const maxRetries = session.maxLivenessRetries || 5;
  const usedRetries = session.livenessRetries || 0;

  return {
    sessionId: session.sessionId,
    status: session.status,
    processingStage: session.processingStage,
    currentStep: session.currentStep,
    consentAccepted: Boolean(session.consentAcceptedAt),
    expiresAt: session.expiresAt,
    completedAt: session.completedAt,
    documentAttempts: session.documentAttempts,
    maxDocumentAttempts: session.maxDocumentAttempts,
    remainingDocumentAttempts: Math.max(0, session.maxDocumentAttempts - session.documentAttempts),
    livenessRetries: usedRetries,
    maxLivenessRetries: maxRetries,
    remainingLivenessRetries: Math.max(0, maxRetries - usedRetries),
    documentVerified: Boolean(session.documentVerified),
    documentConfirmed: Boolean(session.documentConfirmed),
    livenessVerified: Boolean(session.livenessVerified),
    livenessProgress,
    failureCode: session.failureCode || '',
    failureReason: session.failureReason || '',
    ocrPreview: showOcrPreview
      ? {
          idNumberMasked: session.ocrSummary.idNumberMasked,
          fullName: session.ocrSummary.fullName,
          birthday: session.ocrSummary.birthday,
          sex: session.ocrSummary.sex,
          nationality: session.ocrSummary.nationality,
          issueDate: session.ocrSummary.issueDate,
          expiry: session.ocrSummary.expiryRaw,
          address: session.ocrSummary.address
        }
      : null,
    verificationScope: {
      verificationMethod: VerificationMethod.DOCUMENT_AND_LIVENESS,
      livenessVerified: Boolean(session.livenessVerified),
      faceMatchingVerified: null,
      cccdOwnershipVerified: false
    }
  };
};

const buildIdentityAad = (userId) => `ekyc-identity:${String(userId)}`;

const truncateDeviceInfo = (userAgent) => {
  if (typeof userAgent !== 'string') return '';
  return userAgent.trim().slice(0, 180);
};

const createEkycService = ({
  models = {
    User,
    IdentityProfile,
    VerificationSession,
    EkycTempAsset,
    AuditLog
  },
  provider = defaultViettelAiProvider,
  realtime = { emitEkycSessionUpdate },
  configGetter = getEkycConfig,
  trustScoreRecalculator = recalculateUserTrustScore,
  challengeGenerator = generateLivenessChallengeSequence,
  nowGetter = () => new Date()
} = {}) => {
  const deleteSessionTempAssets = async (sessionId) => {
    if (!sessionId || !models.EkycTempAsset) return;
    await models.EkycTempAsset.deleteMany({ sessionId: String(sessionId) });
  };

  const broadcastDesktopUpdate = (session) => {
    if (!session) return;
    realtime.emitEkycSessionUpdate(session.sessionId, toDesktopSafeSessionPayload(session));
  };

  const expireSessionIfNeeded = async (session) => {
    if (!session) return null;
    const now = nowGetter();

    if (
      !TERMINAL_SESSION_STATUSES.includes(session.status)
      && new Date(session.expiresAt) <= now
    ) {
      const updated = await models.VerificationSession.findOneAndUpdate(
        {
          sessionId: session.sessionId,
          status: { $nin: TERMINAL_SESSION_STATUSES }
        },
        {
          $set: {
            status: VerificationSessionStatus.EXPIRED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.RESULT,
            failureCode: 'SESSION_EXPIRED',
            failureReason: 'Phiên xác minh đã hết hạn. Vui lòng tạo phiên mới để tiếp tục.'
          }
        },
        { new: true }
      );
      await deleteSessionTempAssets(session.sessionId);
      const effective = updated || session;
      broadcastDesktopUpdate(effective);
      return effective;
    }

    return session;
  };

  const isUserVerificationCurrentlyValid = (user, now = nowGetter()) => {
    if (!user || user.ekycStatus !== UserEkycStatus.VERIFIED) {
      return false;
    }
    if (user.ekycExpiresAt && new Date(user.ekycExpiresAt) <= now) {
      return false;
    }
    return true;
  };

  /**
   * GET /api/ekyc/status
   */
  const getAccountEkycStatus = async (userId) => {
    const now = nowGetter();
    const user = await models.User.findById(userId)
      .select('_id fullName ekycStatus verificationMethod livenessVerified ekycVerifiedAt ekycExpiresAt trustScore');

    if (!user) {
      throw new EkycDomainError('Không tìm thấy tài khoản người dùng.', {
        statusCode: 404,
        code: 'USER_NOT_FOUND'
      });
    }

    const [profile, activeSessionRaw] = await Promise.all([
      models.IdentityProfile.findOne({ userId: user._id, isActive: true })
        .select('idNumberMasked fullName expiryRaw expiryDate isPermanentExpiry verificationMethod documentSpoofCheckPassed documentOcrPassed faceMatchingVerified faceMatchVerified livenessVerified cccdOwnershipVerified policyVersion verifiedAt'),
      models.VerificationSession.findOne({
        userId: user._id,
        status: { $in: ACTIVE_SESSION_STATUSES }
      }).sort({ createdAt: -1 })
    ]);

    const activeSession = activeSessionRaw ? await expireSessionIfNeeded(activeSessionRaw) : null;
    const hasActiveSession = activeSession && !TERMINAL_SESSION_STATUSES.includes(activeSession.status);

    const isExpiredDocument = Boolean(
      user.ekycStatus === UserEkycStatus.VERIFIED
      && user.ekycExpiresAt
      && new Date(user.ekycExpiresAt) <= now
    );

    const effectiveStatus = isExpiredDocument ? UserEkycStatus.UNVERIFIED : user.ekycStatus;
    const resolvedMethod = user.verificationMethod || profile?.verificationMethod || VerificationMethod.NONE;
    const faceMatchedHistorical = profile?.faceMatchingVerified ?? profile?.faceMatchVerified ?? null;

    return {
      ekycStatus: user.ekycStatus,
      verificationStatus: String(effectiveStatus || 'unverified').toUpperCase(),
      isVerifiedAndValid: isUserVerificationCurrentlyValid(user, now),
      reverificationRequired: isExpiredDocument,
      reverificationReason: isExpiredDocument
        ? 'Giấy tờ tùy thân đã hết hạn hiệu lực. Vui lòng thực hiện xác minh lại.'
        : '',
      verificationMethod: resolvedMethod,
      livenessVerified: Boolean(user.livenessVerified ?? profile?.livenessVerified ?? false),
      faceMatchingVerified: resolvedMethod === VerificationMethod.DOCUMENT_AND_FACE_MATCH
        ? Boolean(faceMatchedHistorical ?? true)
        : null,
      cccdOwnershipVerified: Boolean(profile?.cccdOwnershipVerified ?? false),
      verifiedAt: user.ekycVerifiedAt || profile?.verifiedAt || null,
      expiresAt: user.ekycExpiresAt || profile?.expiryDate || null,
      trustScore: user.trustScore,
      trustLevel: getTrustLevelFromScore(user.trustScore),
      identitySummary: profile
        ? {
            idNumberMasked: profile.idNumberMasked,
            fullName: profile.fullName,
            expiry: profile.expiryRaw,
            isPermanentExpiry: profile.isPermanentExpiry,
            policyVersion: profile.policyVersion
          }
        : null,
      activeSession: hasActiveSession ? toDesktopSafeSessionPayload(activeSession) : null
    };
  };

  /**
   * POST /api/ekyc/sessions
   */
  const createSession = async ({ userId, initiationMode = InitiationMode.QR, frontendBaseUrl, userAgent = '' }) => {
    const now = nowGetter();
    const config = configGetter();

    const user = await models.User.findById(userId)
      .select('_id ekycStatus ekycExpiresAt isBanned suspendedUntil');

    if (!user) {
      throw new EkycDomainError('Không tìm thấy tài khoản.', { statusCode: 404, code: 'USER_NOT_FOUND' });
    }

    if (isUserVerificationCurrentlyValid(user, now)) {
      throw new EkycDomainError('Tài khoản của bạn đã được xác minh danh tính và vẫn còn hiệu lực.', {
        statusCode: 409,
        code: 'ALREADY_VERIFIED'
      });
    }

    const existingSessions = await models.VerificationSession.find({
      userId: user._id,
      status: { $in: ACTIVE_SESSION_STATUSES }
    }).select('sessionId');

    if (existingSessions.length > 0) {
      const oldSessionIds = existingSessions.map((s) => s.sessionId);
      await models.VerificationSession.updateMany(
        { sessionId: { $in: oldSessionIds }, status: { $in: ACTIVE_SESSION_STATUSES } },
        {
          $set: {
            status: VerificationSessionStatus.CANCELLED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.RESULT,
            cancelledAt: now,
            failureCode: 'SUPERSEDED_BY_NEW_SESSION',
            failureReason: 'Phiên xác minh này đã bị hủy do bạn vừa tạo một phiên xác minh mới.'
          }
        }
      );
      if (models.EkycTempAsset) {
        await models.EkycTempAsset.deleteMany({ sessionId: { $in: oldSessionIds } });
      }

      for (const oldId of oldSessionIds) {
        const cancelledDoc = await models.VerificationSession.findOne({ sessionId: oldId });
        if (cancelledDoc) broadcastDesktopUpdate(cancelledDoc);
      }
    }

    const mode = initiationMode === InitiationMode.DIRECT ? InitiationMode.DIRECT : InitiationMode.QR;
    const sessionId = generateSessionId();
    const expiresAt = new Date(now.getTime() + config.sessionTtlMs);

    if (mode === InitiationMode.DIRECT) {
      const mobileToken = createEkycMobileSessionToken({ sessionId, expiresAt });
      const session = await models.VerificationSession.create({
        sessionId,
        userId: user._id,
        initiationMode: InitiationMode.DIRECT,
        status: VerificationSessionStatus.CLAIMED,
        processingStage: ProcessingStage.IDLE,
        currentStep: EkycStep.CONSENT,
        handoffTokenHash: null,
        handoffTokenUsed: true,
        mobileAccessTokenHash: hashToken(mobileToken),
        claimedDeviceInfo: truncateDeviceInfo(userAgent),
        claimedAt: now,
        expiresAt,
        maxDocumentAttempts: config.maxDocumentAttempts,
        maxLivenessRetries: config.maxLivenessRetries,
        livenessResults: createEmptyLivenessResults()
      });

      return {
        session: toDesktopSafeSessionPayload(session),
        mobileSession: toMobileSessionPayload(session),
        ekycSessionToken: mobileToken,
        qrUrl: null
      };
    }

    const rawHandoffToken = generateHandoffToken();
    const session = await models.VerificationSession.create({
      sessionId,
      userId: user._id,
      initiationMode: InitiationMode.QR,
      status: VerificationSessionStatus.CREATED,
      processingStage: ProcessingStage.IDLE,
      currentStep: EkycStep.WAITING_SCAN,
      handoffTokenHash: hashToken(rawHandoffToken),
      handoffTokenUsed: false,
      expiresAt,
      maxDocumentAttempts: config.maxDocumentAttempts,
      maxLivenessRetries: config.maxLivenessRetries,
      livenessResults: createEmptyLivenessResults()
    });

    const resolvedBaseUrl = (frontendBaseUrl || process.env.FRONTEND_URL || 'http://localhost:3000')
      .split(',')[0]
      .trim()
      .replace(/\/+$/, '');
    const qrUrl = `${resolvedBaseUrl}/verify-identity?token=${encodeURIComponent(rawHandoffToken)}`;

    return {
      session: toDesktopSafeSessionPayload(session),
      qrUrl,
      ttlSeconds: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000))
    };
  };

  /**
   * POST /api/ekyc/sessions/claim
   */
  const claimSession = async ({ handoffToken, userAgent = '' }) => {
    const trimmed = typeof handoffToken === 'string' ? handoffToken.trim() : '';
    if (!trimmed || trimmed.length < 24 || trimmed.length > 256) {
      throw new EkycDomainError('Mã xác minh không hợp lệ.', {
        statusCode: 401,
        code: 'INVALID_HANDOFF_TOKEN'
      });
    }

    const now = nowGetter();
    const tokenHash = hashToken(trimmed);

    const claimed = await models.VerificationSession.findOneAndUpdate(
      {
        handoffTokenHash: tokenHash,
        handoffTokenUsed: false,
        status: VerificationSessionStatus.CREATED,
        expiresAt: { $gt: now }
      },
      {
        $set: {
          handoffTokenUsed: true,
          status: VerificationSessionStatus.CLAIMED,
          currentStep: EkycStep.CONSENT,
          claimedAt: now,
          claimedDeviceInfo: truncateDeviceInfo(userAgent)
        }
      },
      { new: true }
    );

    if (!claimed) {
      const existing = await models.VerificationSession.findOne({ handoffTokenHash: tokenHash });
      if (!existing) {
        throw new EkycDomainError('Liên kết xác minh không hợp lệ hoặc không tồn tại.', {
          statusCode: 401,
          code: 'INVALID_HANDOFF_TOKEN'
        });
      }

      if (existing.status === VerificationSessionStatus.CANCELLED) {
        throw new EkycDomainError('Phiên xác minh này đã bị hủy trên thiết bị gốc.', {
          statusCode: 410,
          code: 'SESSION_CANCELLED'
        });
      }

      if (existing.status === VerificationSessionStatus.EXPIRED || new Date(existing.expiresAt) <= now) {
        await expireSessionIfNeeded(existing);
        throw new EkycDomainError('Mã QR xác minh đã hết hạn. Vui lòng tạo lại mã QR mới trên máy tính.', {
          statusCode: 410,
          code: 'SESSION_EXPIRED'
        });
      }

      throw new EkycDomainError('Mã QR này đã được sử dụng trên một thiết bị khác. Vui lòng tạo mã QR mới nếu cần.', {
        statusCode: 409,
        code: 'HANDOFF_TOKEN_ALREADY_USED'
      });
    }

    const ownerUser = await models.User.findById(claimed.userId).select('_id isBanned suspendedUntil');
    if (
      !ownerUser
      || ownerUser.isBanned
      || (ownerUser.suspendedUntil && now < new Date(ownerUser.suspendedUntil))
    ) {
      await models.VerificationSession.findOneAndUpdate(
        { sessionId: claimed.sessionId },
        {
          $set: {
            status: VerificationSessionStatus.CANCELLED,
            cancelledAt: now,
            failureCode: 'ACCOUNT_RESTRICTED',
            failureReason: 'Tài khoản liên kết hiện không đủ điều kiện xác minh.'
          }
        }
      );
      throw new EkycDomainError('Tài khoản liên kết không khả dụng.', {
        statusCode: 403,
        code: 'ACCOUNT_RESTRICTED'
      });
    }

    const mobileToken = createEkycMobileSessionToken({
      sessionId: claimed.sessionId,
      expiresAt: claimed.expiresAt
    });

    const finalizedClaim = await models.VerificationSession.findOneAndUpdate(
      { sessionId: claimed.sessionId },
      { $set: { mobileAccessTokenHash: hashToken(mobileToken) } },
      { new: true }
    );

    broadcastDesktopUpdate(finalizedClaim);

    return {
      sessionId: finalizedClaim.sessionId,
      ekycSessionToken: mobileToken,
      session: toMobileSessionPayload(finalizedClaim)
    };
  };

  const getSessionForOwner = async ({ sessionId, userId }) => {
    const session = await models.VerificationSession.findOne({ sessionId: String(sessionId) });
    if (!session) {
      throw new EkycDomainError('Không tìm thấy phiên xác minh.', {
        statusCode: 404,
        code: 'SESSION_NOT_FOUND'
      });
    }

    if (String(session.userId) !== String(userId)) {
      throw new EkycDomainError('Bạn không có quyền truy cập phiên xác minh này.', {
        statusCode: 403,
        code: 'FORBIDDEN_SESSION_ACCESS'
      });
    }

    const checked = await expireSessionIfNeeded(session);
    return toDesktopSafeSessionPayload(checked);
  };

  const getSessionForMobile = async ({ session }) => {
    const checked = await expireSessionIfNeeded(session);
    return toMobileSessionPayload(checked);
  };

  const ensureSessionActiveForMobileStep = async (session) => {
    const checked = await expireSessionIfNeeded(session);
    if (!checked) {
      throw new EkycDomainError('Không tìm thấy phiên xác minh.', {
        statusCode: 404,
        code: 'SESSION_NOT_FOUND'
      });
    }

    if (checked.status === VerificationSessionStatus.EXPIRED) {
      throw new EkycDomainError('Phiên xác minh đã hết hạn. Vui lòng tạo lại phiên mới.', {
        statusCode: 410,
        code: 'SESSION_EXPIRED'
      });
    }

    if (checked.status === VerificationSessionStatus.CANCELLED) {
      throw new EkycDomainError('Phiên xác minh đã bị hủy.', {
        statusCode: 410,
        code: 'SESSION_CANCELLED'
      });
    }

    if (checked.status === VerificationSessionStatus.COMPLETED) {
      throw new EkycDomainError('Phiên xác minh này đã hoàn tất.', {
        statusCode: 409,
        code: 'SESSION_ALREADY_COMPLETED'
      });
    }

    if (checked.status === VerificationSessionStatus.FAILED) {
      throw new EkycDomainError(
        checked.failureReason || 'Phiên xác minh đã vượt quá số lần thử cho phép. Vui lòng liên hệ bộ phận hỗ trợ.',
        { statusCode: 422, code: checked.failureCode || 'SESSION_FAILED' }
      );
    }

    return checked;
  };

  /**
   * POST /api/ekyc/sessions/:sessionId/consent
   */
  const acceptConsent = async ({ session, accepted }) => {
    if (accepted !== true) {
      throw new EkycDomainError('Bạn cần đồng ý với điều khoản xử lý dữ liệu cá nhân để bắt đầu xác minh.', {
        statusCode: 400,
        code: 'CONSENT_REQUIRED'
      });
    }

    const active = await ensureSessionActiveForMobileStep(session);
    if (active.consentAcceptedAt) {
      return toMobileSessionPayload(active);
    }

    if (active.status !== VerificationSessionStatus.CLAIMED) {
      throw new EkycDomainError('Trạng thái phiên không hợp lệ để xác nhận đồng ý.', {
        statusCode: 409,
        code: 'INVALID_SESSION_STATE'
      });
    }

    const config = configGetter();
    const now = nowGetter();

    const updated = await models.VerificationSession.findOneAndUpdate(
      {
        sessionId: active.sessionId,
        status: VerificationSessionStatus.CLAIMED
      },
      {
        $set: {
          status: VerificationSessionStatus.CONSENT_ACCEPTED,
          currentStep: EkycStep.DOCUMENT_CAPTURE,
          consentAcceptedAt: now,
          consentPolicyVersion: config.policyVersion,
          failureCode: '',
          failureReason: ''
        }
      },
      { new: true }
    );

    if (!updated) {
      throw new EkycDomainError('Không thể cập nhật trạng thái đồng ý cho phiên xác minh.', {
        statusCode: 409,
        code: 'INVALID_SESSION_STATE'
      });
    }

    broadcastDesktopUpdate(updated);
    return toMobileSessionPayload(updated);
  };

  /**
   * POST /api/ekyc/sessions/:sessionId/documents
   * Validates CCCD front & back locally -> ID Pack Spoof Check -> Document OCR.
   * No CCCD image buffer is persisted after this request completes.
   */
  const submitDocuments = async ({ session, frontBuffer, backBuffer }) => {
    const active = await ensureSessionActiveForMobileStep(session);

    if (!active.consentAcceptedAt) {
      throw new EkycDomainError('Vui lòng đồng ý điều khoản xử lý dữ liệu cá nhân trước khi gửi ảnh CCCD.', {
        statusCode: 409,
        code: 'CONSENT_REQUIRED'
      });
    }

    if (
      active.status === VerificationSessionStatus.DOCUMENT_PROCESSING
      || active.status === VerificationSessionStatus.LIVENESS_PROCESSING
    ) {
      throw new EkycDomainError('Hệ thống đang xử lý yêu cầu trước đó. Vui lòng đợi trong giây lát.', {
        statusCode: 409,
        code: 'SESSION_BUSY'
      });
    }

    const allowedSourceStatuses = [
      VerificationSessionStatus.CONSENT_ACCEPTED,
      VerificationSessionStatus.DOCUMENT_RETRY_REQUIRED,
      VerificationSessionStatus.DOCUMENT_VERIFIED,
      VerificationSessionStatus.DOCUMENT_CONFIRMED,
      VerificationSessionStatus.LIVENESS_IN_PROGRESS,
      VerificationSessionStatus.LIVENESS_RETRY_REQUIRED
    ];

    if (!allowedSourceStatuses.includes(active.status)) {
      throw new EkycDomainError('Trạng thái phiên xác minh không hợp lệ cho bước chụp giấy tờ.', {
        statusCode: 409,
        code: 'INVALID_SESSION_STATE'
      });
    }

    const frontCheck = validateEkycImageBuffer(frontBuffer, 'Ảnh CCCD mặt trước');
    if (!frontCheck.valid) {
      throw new EkycDomainError(frontCheck.message, {
        statusCode: 400,
        code: frontCheck.code
      });
    }

    const backCheck = validateEkycImageBuffer(backBuffer, 'Ảnh CCCD mặt sau');
    if (!backCheck.valid) {
      throw new EkycDomainError(backCheck.message, {
        statusCode: 400,
        code: backCheck.code
      });
    }

    if (frontCheck.sha256 === backCheck.sha256) {
      throw new EkycDomainError(
        'Ảnh mặt trước và mặt sau CCCD bị trùng nhau. Vui lòng chụp riêng từng mặt của thẻ CCCD.',
        { statusCode: 400, code: 'DUPLICATE_FRONT_BACK_IMAGE' }
      );
    }

    const pairHash = crypto
      .createHash('sha256')
      .update(`${frontCheck.sha256}:${backCheck.sha256}`)
      .digest('hex');

    if (
      active.lastDocumentPairHash === pairHash
      && active.documentVerified
      && [
        VerificationSessionStatus.DOCUMENT_VERIFIED,
        VerificationSessionStatus.DOCUMENT_CONFIRMED
      ].includes(active.status)
    ) {
      return toMobileSessionPayload(active);
    }

    if (active.documentAttempts >= active.maxDocumentAttempts) {
      const failedDoc = await models.VerificationSession.findOneAndUpdate(
        { sessionId: active.sessionId },
        {
          $set: {
            status: VerificationSessionStatus.FAILED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.RESULT,
            failureCode: 'MAX_DOCUMENT_ATTEMPTS_EXCEEDED',
            failureReason: 'Bạn đã vượt quá số lần chụp giấy tờ cho phép trong phiên này. Vui lòng tạo phiên mới hoặc liên hệ hỗ trợ.'
          }
        },
        { new: true }
      );
      broadcastDesktopUpdate(failedDoc);
      throw new EkycDomainError(failedDoc.failureReason, {
        statusCode: 422,
        code: 'MAX_DOCUMENT_ATTEMPTS_EXCEEDED',
        details: { session: toMobileSessionPayload(failedDoc) }
      });
    }

    const lockedSession = await models.VerificationSession.findOneAndUpdate(
      {
        sessionId: active.sessionId,
        status: { $in: allowedSourceStatuses },
        documentAttempts: { $lt: active.maxDocumentAttempts }
      },
      {
        $set: {
          status: VerificationSessionStatus.DOCUMENT_PROCESSING,
          processingStage: ProcessingStage.SPOOF_CHECK,
          currentStep: EkycStep.DOCUMENT_CAPTURE,
          spoofCheckPassed: false,
          documentVerified: false,
          documentConfirmed: false,
          livenessVerified: false,
          livenessChallenges: [],
          currentPoseIndex: 0,
          usedLivenessImageHashes: [],
          livenessResults: createEmptyLivenessResults(),
          ocrSummary: null,
          lastDocumentPairHash: '',
          failureCode: '',
          failureReason: ''
        }
      },
      { new: true }
    );

    if (!lockedSession) {
      throw new EkycDomainError('Hệ thống đang xử lý yêu cầu trước đó. Vui lòng đợi trong giây lát.', {
        statusCode: 409,
        code: 'SESSION_BUSY'
      });
    }

    broadcastDesktopUpdate(lockedSession);

    const handleDocumentStepFailure = async ({
      errorCode,
      message,
      isTechnicalError = false,
      clientHttpStatus = 422,
      traces = [],
      spoofInc = 0,
      ocrInc = 0
    }) => {
      if (isTechnicalError) {
        const reverted = await models.VerificationSession.findOneAndUpdate(
          { sessionId: lockedSession.sessionId },
          {
            $set: {
              status: lockedSession.documentAttempts > 0
                ? VerificationSessionStatus.DOCUMENT_RETRY_REQUIRED
                : VerificationSessionStatus.CONSENT_ACCEPTED,
              processingStage: ProcessingStage.IDLE,
              currentStep: EkycStep.DOCUMENT_CAPTURE,
              failureCode: errorCode,
              failureReason: message
            },
            $inc: {
              'apiCallCounts.spoofCheck': spoofInc,
              'apiCallCounts.ocr': ocrInc
            },
            ...(traces.length > 0 ? { $push: { providerRequestIds: { $each: traces } } } : {})
          },
          { new: true }
        );
        broadcastDesktopUpdate(reverted);
        throw new EkycDomainError(message, {
          statusCode: clientHttpStatus,
          code: errorCode,
          details: { session: toMobileSessionPayload(reverted) }
        });
      }

      const nextAttempts = lockedSession.documentAttempts + 1;
      const exhausted = nextAttempts >= lockedSession.maxDocumentAttempts;
      const finalReason = exhausted
        ? `${message} (Bạn đã sử dụng hết ${lockedSession.maxDocumentAttempts}/${lockedSession.maxDocumentAttempts} lượt kiểm tra giấy tờ. Vui lòng tạo phiên mới hoặc liên hệ CSKH để được hỗ trợ).`
        : message;

      const updatedFail = await models.VerificationSession.findOneAndUpdate(
        { sessionId: lockedSession.sessionId },
        {
          $set: {
            status: exhausted
              ? VerificationSessionStatus.FAILED
              : VerificationSessionStatus.DOCUMENT_RETRY_REQUIRED,
            processingStage: ProcessingStage.IDLE,
            currentStep: exhausted ? EkycStep.RESULT : EkycStep.DOCUMENT_CAPTURE,
            documentAttempts: nextAttempts,
            failureCode: exhausted ? 'MAX_DOCUMENT_ATTEMPTS_EXCEEDED' : errorCode,
            failureReason: finalReason
          },
          $inc: {
            'apiCallCounts.spoofCheck': spoofInc,
            'apiCallCounts.ocr': ocrInc
          },
          ...(traces.length > 0 ? { $push: { providerRequestIds: { $each: traces } } } : {})
        },
        { new: true }
      );

      broadcastDesktopUpdate(updatedFail);
      throw new EkycDomainError(finalReason, {
        statusCode: clientHttpStatus,
        code: exhausted ? 'MAX_DOCUMENT_ATTEMPTS_EXCEEDED' : errorCode,
        details: { session: toMobileSessionPayload(updatedFail) }
      });
    };

    const spoofResult = await provider.checkIdPackSpoof({
      frontImage: {
        buffer: frontBuffer,
        mimeType: frontCheck.mimeType,
        extension: frontCheck.extension
      },
      backImage: {
        buffer: backBuffer,
        mimeType: backCheck.mimeType,
        extension: backCheck.extension
      },
      sessionId: lockedSession.sessionId
    });

    const spoofTrace = {
      api: 'id_pack_spoof_check',
      pose: '',
      requestId: spoofResult.requestId || '',
      code: spoofResult.providerCode ?? null,
      httpStatus: spoofResult.httpStatus ?? null,
      durationMs: spoofResult.durationMs || 0,
      outcome: spoofResult.passed ? 'PASSED' : (spoofResult.errorCode || 'FAILED'),
      calledAt: nowGetter()
    };

    if (!spoofResult.passed) {
      return handleDocumentStepFailure({
        errorCode: spoofResult.errorCode,
        message: spoofResult.message,
        isTechnicalError: Boolean(spoofResult.isTechnicalError),
        clientHttpStatus: spoofResult.clientHttpStatus || 422,
        traces: [spoofTrace],
        spoofInc: 1,
        ocrInc: 0
      });
    }

    const ocrStageSession = await models.VerificationSession.findOneAndUpdate(
      { sessionId: lockedSession.sessionId },
      { $set: { processingStage: ProcessingStage.OCR, spoofCheckPassed: true } },
      { new: true }
    );
    broadcastDesktopUpdate(ocrStageSession);

    const ocrResult = await provider.extractIdCardOcr({
      frontImage: {
        buffer: frontBuffer,
        mimeType: frontCheck.mimeType,
        extension: frontCheck.extension
      },
      backImage: {
        buffer: backBuffer,
        mimeType: backCheck.mimeType,
        extension: backCheck.extension
      },
      sessionId: lockedSession.sessionId
    });

    const ocrTrace = {
      api: 'id_card',
      pose: '',
      requestId: ocrResult.requestId || '',
      code: ocrResult.providerCode ?? null,
      httpStatus: ocrResult.httpStatus ?? null,
      durationMs: ocrResult.durationMs || 0,
      outcome: ocrResult.passed ? 'PASSED' : (ocrResult.errorCode || 'FAILED'),
      calledAt: nowGetter()
    };

    if (!ocrResult.passed) {
      return handleDocumentStepFailure({
        errorCode: ocrResult.errorCode,
        message: ocrResult.message,
        isTechnicalError: Boolean(ocrResult.isTechnicalError),
        clientHttpStatus: ocrResult.clientHttpStatus || 422,
        traces: [spoofTrace, ocrTrace],
        spoofInc: 1,
        ocrInc: 1
      });
    }

    const now = nowGetter();
    const ocrValidation = validateAndNormalizeOcr(ocrResult.information, now);
    if (!ocrValidation.valid) {
      return handleDocumentStepFailure({
        errorCode: ocrValidation.code,
        message: ocrValidation.message,
        isTechnicalError: false,
        clientHttpStatus: 422,
        traces: [spoofTrace, ocrTrace],
        spoofInc: 1,
        ocrInc: 1
      });
    }

    const normalized = ocrValidation.normalized;
    const idNumberHmac = computeIdNumberHmac(normalized.idNumber);

    const duplicateProfile = await models.IdentityProfile.findOne({
      idNumberHmac,
      isActive: true,
      userId: { $ne: lockedSession.userId }
    }).select('_id userId');

    if (duplicateProfile) {
      return handleDocumentStepFailure({
        errorCode: 'DUPLICATE_IDENTITY_DOCUMENT',
        message: 'Số Căn cước công dân này đã được đăng ký xác minh cho một tài khoản khác trên hệ thống.',
        isTechnicalError: false,
        clientHttpStatus: 409,
        traces: [spoofTrace, ocrTrace],
        spoofInc: 1,
        ocrInc: 1
      });
    }

    const idNumberEncrypted = encryptSensitiveText(
      normalized.idNumber,
      buildIdentityAad(lockedSession.userId)
    );

    const verifiedSession = await models.VerificationSession.findOneAndUpdate(
      { sessionId: lockedSession.sessionId },
      {
        $set: {
          status: VerificationSessionStatus.DOCUMENT_VERIFIED,
          processingStage: ProcessingStage.IDLE,
          currentStep: EkycStep.DOCUMENT_REVIEW,
          spoofCheckPassed: true,
          documentVerified: true,
          documentConfirmed: false,
          lastDocumentPairHash: pairHash,
          documentAttempts: lockedSession.documentAttempts + 1,
          failureCode: '',
          failureReason: '',
          ocrSummary: {
            idNumberHmac,
            idNumberEncrypted,
            idNumberMasked: normalized.idNumberMasked,
            fullName: normalized.fullName,
            birthday: normalized.birthday,
            sex: normalized.sex,
            nationality: normalized.nationality,
            address: normalized.address,
            hometown: normalized.hometown,
            issueDate: normalized.issueDate,
            issueBy: normalized.issueBy,
            expiryRaw: normalized.expiryRaw,
            expiryDate: normalized.expiryDate,
            isPermanentExpiry: normalized.isPermanentExpiry,
            documentType: normalized.documentType,
            typeList: normalized.typeList
          }
        },
        $inc: {
          'apiCallCounts.spoofCheck': 1,
          'apiCallCounts.ocr': 1
        },
        $push: {
          providerRequestIds: { $each: [spoofTrace, ocrTrace] }
        }
      },
      { new: true }
    );

    broadcastDesktopUpdate(verifiedSession);
    return toMobileSessionPayload(verifiedSession);
  };

  /**
   * POST /api/ekyc/sessions/:sessionId/confirm-document
   * Generates the randomized 5-pose Liveness challenge sequence on CONFIRM.
   */
  const confirmDocumentOcr = async ({ session, action = 'CONFIRM' }) => {
    const active = await ensureSessionActiveForMobileStep(session);
    const normalizedAction = String(action || 'CONFIRM').toUpperCase();

    if (normalizedAction === 'RETAKE') {
      await deleteSessionTempAssets(active.sessionId);

      const resetSession = await models.VerificationSession.findOneAndUpdate(
        { sessionId: active.sessionId },
        {
          $set: {
            status: VerificationSessionStatus.CONSENT_ACCEPTED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.DOCUMENT_CAPTURE,
            spoofCheckPassed: false,
            documentVerified: false,
            documentConfirmed: false,
            livenessVerified: false,
            livenessChallenges: [],
            currentPoseIndex: 0,
            usedLivenessImageHashes: [],
            livenessResults: createEmptyLivenessResults(),
            lastDocumentPairHash: '',
            ocrSummary: null,
            failureCode: '',
            failureReason: ''
          }
        },
        { new: true }
      );

      broadcastDesktopUpdate(resetSession);
      return toMobileSessionPayload(resetSession);
    }

    if (normalizedAction !== 'CONFIRM') {
      throw new EkycDomainError('Hành động xác nhận thông tin không hợp lệ.', {
        statusCode: 400,
        code: 'INVALID_CONFIRM_ACTION'
      });
    }

    if (
      active.documentConfirmed
      && Array.isArray(active.livenessChallenges)
      && active.livenessChallenges.length === ALL_LIVENESS_POSES.length
      && [
        VerificationSessionStatus.DOCUMENT_CONFIRMED,
        VerificationSessionStatus.LIVENESS_IN_PROGRESS,
        VerificationSessionStatus.LIVENESS_RETRY_REQUIRED
      ].includes(active.status)
    ) {
      return toMobileSessionPayload(active);
    }

    if (
      active.status !== VerificationSessionStatus.DOCUMENT_VERIFIED
      || !active.documentVerified
      || !active.spoofCheckPassed
      || !active.ocrSummary?.fullName
    ) {
      throw new EkycDomainError('Vui lòng hoàn tất kiểm tra giấy tờ tùy thân trước khi xác nhận thông tin.', {
        statusCode: 409,
        code: 'DOCUMENT_NOT_VERIFIED'
      });
    }

    const now = nowGetter();
    const challenges = challengeGenerator();

    const confirmed = await models.VerificationSession.findOneAndUpdate(
      {
        sessionId: active.sessionId,
        status: VerificationSessionStatus.DOCUMENT_VERIFIED
      },
      {
        $set: {
          status: VerificationSessionStatus.DOCUMENT_CONFIRMED,
          processingStage: ProcessingStage.IDLE,
          currentStep: EkycStep.LIVENESS_CAPTURE,
          documentConfirmed: true,
          livenessVerified: false,
          livenessChallenges: challenges,
          currentPoseIndex: 0,
          livenessStartedAt: now,
          lastLivenessActivityAt: now,
          usedLivenessImageHashes: [],
          livenessResults: createEmptyLivenessResults(),
          failureCode: '',
          failureReason: ''
        }
      },
      { new: true }
    );

    if (!confirmed) {
      throw new EkycDomainError('Không thể xác nhận thông tin giấy tờ ở trạng thái hiện tại.', {
        statusCode: 409,
        code: 'INVALID_SESSION_STATE'
      });
    }

    broadcastDesktopUpdate(confirmed);
    return toMobileSessionPayload(confirmed);
  };

  /**
   * POST /api/ekyc/sessions/:sessionId/liveness
   * Verifies one pose at a time in the exact Backend-managed 5-pose sequence.
   * Preserves already-passed poses on single-pose retry without re-calling OCR/Spoof Check.
   * Finalizes verification ONLY when all 5 poses have passed.
   */
  const submitLivenessPose = async ({ session, poseBuffer, requestedPose }) => {
    const active = await ensureSessionActiveForMobileStep(session);
    const config = configGetter();
    const now = nowGetter();

    if (
      active.status === VerificationSessionStatus.LIVENESS_PROCESSING
      || active.status === VerificationSessionStatus.DOCUMENT_PROCESSING
    ) {
      throw new EkycDomainError('Hệ thống đang xử lý tư thế trước đó. Vui lòng đợi trong giây lát.', {
        statusCode: 409,
        code: 'SESSION_BUSY'
      });
    }

    const allowedStatuses = [
      VerificationSessionStatus.DOCUMENT_CONFIRMED,
      VerificationSessionStatus.LIVENESS_IN_PROGRESS,
      VerificationSessionStatus.LIVENESS_RETRY_REQUIRED
    ];

    if (
      !allowedStatuses.includes(active.status)
      || !active.spoofCheckPassed
      || !active.documentVerified
      || !active.documentConfirmed
      || !Array.isArray(active.livenessChallenges)
      || active.livenessChallenges.length !== ALL_LIVENESS_POSES.length
    ) {
      throw new EkycDomainError(
        'Không thể kiểm tra thực thể sống khi chưa hoàn tất kiểm tra và xác nhận thông tin CCCD.',
        { statusCode: 409, code: 'STEP_PREREQUISITE_NOT_MET' }
      );
    }

    // Security continuity check: if user abandoned mid-liveness longer than continuity window,
    // regenerate a fresh 5-pose challenge sequence while keeping verified CCCD OCR intact.
    if (
      active.currentPoseIndex > 0
      && active.lastLivenessActivityAt
      && now.getTime() - new Date(active.lastLivenessActivityAt).getTime() > config.livenessContinuityMs
    ) {
      const freshChallenges = challengeGenerator();
      const continuityReset = await models.VerificationSession.findOneAndUpdate(
        { sessionId: active.sessionId },
        {
          $set: {
            status: VerificationSessionStatus.LIVENESS_RETRY_REQUIRED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.LIVENESS_CAPTURE,
            livenessChallenges: freshChallenges,
            currentPoseIndex: 0,
            livenessStartedAt: now,
            lastLivenessActivityAt: now,
            usedLivenessImageHashes: [],
            livenessResults: createEmptyLivenessResults(),
            failureCode: 'LIVENESS_CONTINUITY_LOST',
            failureReason: 'Quá trình xác thực khuôn mặt bị gián đoạn quá lâu. Hệ thống đã tạo mới chuỗi 5 tư thế (kết quả CCCD trước đó vẫn được giữ nguyên).'
          }
        },
        { new: true }
      );
      broadcastDesktopUpdate(continuityReset);
      throw new EkycDomainError(continuityReset.failureReason, {
        statusCode: 409,
        code: 'LIVENESS_CONTINUITY_LOST',
        details: { session: toMobileSessionPayload(continuityReset) }
      });
    }

    const cleanPose = typeof requestedPose === 'string' ? requestedPose.trim() : '';
    if (!ALL_LIVENESS_POSES.includes(cleanPose)) {
      throw new EkycDomainError(
        'Tư thế khuôn mặt gửi lên không hợp lệ (chỉ chấp nhận Portrait, Left, Right, Top, Bottom).',
        { statusCode: 400, code: 'INVALID_LIVENESS_POSE' }
      );
    }

    const expectedPose = active.livenessChallenges[active.currentPoseIndex];
    if (cleanPose !== expectedPose) {
      throw new EkycDomainError(
        `Thứ tự tư thế không khớp. Tư thế cần thực hiện hiện tại là "${POSE_LABELS_VI[expectedPose] || expectedPose}" (${expectedPose}).`,
        {
          statusCode: 409,
          code: 'INVALID_LIVENESS_POSE_ORDER',
          details: { session: toMobileSessionPayload(active) }
        }
      );
    }

    const maxRetries = active.maxLivenessRetries || config.maxLivenessRetries;
    if ((active.livenessRetries || 0) >= maxRetries) {
      const failedSession = await models.VerificationSession.findOneAndUpdate(
        { sessionId: active.sessionId },
        {
          $set: {
            status: VerificationSessionStatus.FAILED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.RESULT,
            failureCode: 'MAX_LIVENESS_ATTEMPTS_EXCEEDED',
            failureReason: 'Bạn đã vượt quá số lần thử lại thực thể sống cho phép. Vui lòng tạo phiên mới hoặc liên hệ bộ phận hỗ trợ.'
          }
        },
        { new: true }
      );
      broadcastDesktopUpdate(failedSession);
      throw new EkycDomainError(failedSession.failureReason, {
        statusCode: 422,
        code: 'MAX_LIVENESS_ATTEMPTS_EXCEEDED',
        details: { session: toMobileSessionPayload(failedSession) }
      });
    }

    // Validate image binary before touching Viettel AI quota
    const liveCheck = validateEkycImageBuffer(poseBuffer, `Ảnh khuôn mặt (${POSE_LABELS_VI[expectedPose]})`);
    if (!liveCheck.valid) {
      throw new EkycDomainError(liveCheck.message, {
        statusCode: 400,
        code: liveCheck.code
      });
    }

    // Prevent frame replay / reusing the same image across poses or retries
    const sessionWithHashes = await models.VerificationSession.findOne({ sessionId: active.sessionId })
      .select('+usedLivenessImageHashes');
    const priorHashes = sessionWithHashes?.usedLivenessImageHashes || [];
    if (priorHashes.includes(liveCheck.sha256)) {
      throw new EkycDomainError(
        'Ảnh chụp khuôn mặt bị trùng lặp với khung hình trước đó. Vui lòng chụp mới trực tiếp từ camera.',
        { statusCode: 400, code: 'DUPLICATE_LIVENESS_FRAME' }
      );
    }

    // Acquire atomic processing lock on (sessionId + status + currentPoseIndex)
    const lockedSession = await models.VerificationSession.findOneAndUpdate(
      {
        sessionId: active.sessionId,
        status: { $in: allowedStatuses },
        currentPoseIndex: active.currentPoseIndex,
        livenessRetries: { $lt: maxRetries }
      },
      {
        $set: {
          status: VerificationSessionStatus.LIVENESS_PROCESSING,
          processingStage: ProcessingStage.FACE_LIVENESS,
          currentStep: EkycStep.LIVENESS_CAPTURE,
          lastLivenessActivityAt: now,
          failureCode: '',
          failureReason: ''
        },
        $push: {
          usedLivenessImageHashes: liveCheck.sha256
        }
      },
      { new: true }
    ).select('+ocrSummary.idNumberHmac +ocrSummary.idNumberEncrypted');

    if (!lockedSession) {
      throw new EkycDomainError('Hệ thống đang xử lý yêu cầu trước đó. Vui lòng đợi trong giây lát.', {
        statusCode: 409,
        code: 'SESSION_BUSY'
      });
    }

    broadcastDesktopUpdate(lockedSession);

    const livenessResult = await provider.checkFaceLiveness({
      image: {
        buffer: poseBuffer,
        mimeType: liveCheck.mimeType,
        extension: liveCheck.extension
      },
      labelPose: expectedPose,
      sessionId: lockedSession.sessionId
    });

    const callTrace = {
      api: 'face_liveness',
      pose: expectedPose,
      requestId: livenessResult.requestId || '',
      code: livenessResult.providerCode ?? null,
      httpStatus: livenessResult.httpStatus ?? null,
      durationMs: livenessResult.durationMs || 0,
      outcome: livenessResult.passed ? 'PASSED' : (livenessResult.errorCode || 'FAILED'),
      calledAt: nowGetter()
    };

    const prevPoseState = lockedSession.livenessResults?.[expectedPose] || {};
    const nextPoseAttempts = (prevPoseState.attempts || 0) + 1;

    if (!livenessResult.passed) {
      if (livenessResult.isTechnicalError) {
        const reverted = await models.VerificationSession.findOneAndUpdate(
          { sessionId: lockedSession.sessionId },
          {
            $set: {
              status: lockedSession.currentPoseIndex > 0 || (lockedSession.livenessRetries || 0) > 0
                ? VerificationSessionStatus.LIVENESS_IN_PROGRESS
                : VerificationSessionStatus.DOCUMENT_CONFIRMED,
              processingStage: ProcessingStage.IDLE,
              currentStep: EkycStep.LIVENESS_CAPTURE,
              lastLivenessActivityAt: nowGetter(),
              failureCode: livenessResult.errorCode,
              failureReason: livenessResult.message
            },
            $inc: { 'apiCallCounts.faceLiveness': 1 },
            $push: { providerRequestIds: callTrace }
          },
          { new: true }
        );
        broadcastDesktopUpdate(reverted);
        throw new EkycDomainError(livenessResult.message, {
          statusCode: livenessResult.clientHttpStatus || 502,
          code: livenessResult.errorCode,
          details: { session: toMobileSessionPayload(reverted) }
        });
      }

      const nextRetries = (lockedSession.livenessRetries || 0) + 1;
      const exhausted = nextRetries >= maxRetries;
      const poseRetryMessage = `${livenessResult.message} (Tư thế cần thực hiện: ${POSE_LABELS_VI[expectedPose]}).`;
      const finalReason = exhausted
        ? `${poseRetryMessage} Bạn đã sử dụng hết ${maxRetries}/${maxRetries} lượt thử lại. Vui lòng tạo phiên xác minh mới hoặc liên hệ CSKH.`
        : poseRetryMessage;

      const retryOrFailSession = await models.VerificationSession.findOneAndUpdate(
        { sessionId: lockedSession.sessionId },
        {
          $set: {
            status: exhausted
              ? VerificationSessionStatus.FAILED
              : VerificationSessionStatus.LIVENESS_RETRY_REQUIRED,
            processingStage: ProcessingStage.IDLE,
            currentStep: exhausted ? EkycStep.RESULT : EkycStep.LIVENESS_CAPTURE,
            livenessRetries: nextRetries,
            lastLivenessActivityAt: nowGetter(),
            [`livenessResults.${expectedPose}`]: {
              passed: false,
              score: livenessResult.score ?? null,
              requestId: livenessResult.requestId || '',
              attempts: nextPoseAttempts,
              verifiedAt: null
            },
            failureCode: exhausted ? 'MAX_LIVENESS_ATTEMPTS_EXCEEDED' : livenessResult.errorCode,
            failureReason: finalReason
          },
          $inc: { 'apiCallCounts.faceLiveness': 1 },
          $push: { providerRequestIds: callTrace }
        },
        { new: true }
      );

      broadcastDesktopUpdate(retryOrFailSession);
      throw new EkycDomainError(finalReason, {
        statusCode: livenessResult.clientHttpStatus || 422,
        code: exhausted ? 'MAX_LIVENESS_ATTEMPTS_EXCEEDED' : livenessResult.errorCode,
        details: {
          failedPose: expectedPose,
          session: toMobileSessionPayload(retryOrFailSession)
        }
      });
    }

    // Current pose passed!
    const verifiedNow = nowGetter();
    const updatedResults = {
      ...(lockedSession.livenessResults || createEmptyLivenessResults()),
      [expectedPose]: {
        passed: true,
        score: livenessResult.score,
        requestId: livenessResult.requestId || '',
        attempts: nextPoseAttempts,
        verifiedAt: verifiedNow
      }
    };

    const nextPoseIndex = lockedSession.currentPoseIndex + 1;
    const allFivePosesPassed = nextPoseIndex >= ALL_LIVENESS_POSES.length
      && ALL_LIVENESS_POSES.every((pose) => Boolean(updatedResults[pose]?.passed));

    // Still more poses remaining (1/5 .. 4/5): advance to next pose without completing account verification
    if (!allFivePosesPassed) {
      const progressedSession = await models.VerificationSession.findOneAndUpdate(
        { sessionId: lockedSession.sessionId },
        {
          $set: {
            status: VerificationSessionStatus.LIVENESS_IN_PROGRESS,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.LIVENESS_CAPTURE,
            currentPoseIndex: nextPoseIndex,
            lastLivenessActivityAt: verifiedNow,
            [`livenessResults.${expectedPose}`]: updatedResults[expectedPose],
            failureCode: '',
            failureReason: ''
          },
          $inc: { 'apiCallCounts.faceLiveness': 1 },
          $push: { providerRequestIds: callTrace }
        },
        { new: true }
      );

      broadcastDesktopUpdate(progressedSession);
      return {
        completed: false,
        passedPose: expectedPose,
        nextPose: lockedSession.livenessChallenges[nextPoseIndex] || null,
        session: toMobileSessionPayload(progressedSession)
      };
    }

    // All 5 poses passed -> Finalize verification!
    const finalizingSession = await models.VerificationSession.findOneAndUpdate(
      { sessionId: lockedSession.sessionId },
      {
        $set: {
          processingStage: ProcessingStage.FINALIZING,
          [`livenessResults.${expectedPose}`]: updatedResults[expectedPose]
        }
      },
      { new: true }
    );
    broadcastDesktopUpdate(finalizingSession);

    const ocr = lockedSession.ocrSummary;
    const allTraces = [...(lockedSession.providerRequestIds || []), callTrace];
    const findLastDocRequestId = (apiName) => {
      for (let i = allTraces.length - 1; i >= 0; i -= 1) {
        if (allTraces[i].api === apiName && allTraces[i].requestId) {
          return allTraces[i].requestId;
        }
      }
      return '';
    };

    const persistedLivenessResults = {};
    const persistedLivenessRequestIds = {};
    for (const pose of ALL_LIVENESS_POSES) {
      persistedLivenessResults[pose] = {
        passed: true,
        score: updatedResults[pose].score,
        requestId: updatedResults[pose].requestId || '',
        verifiedAt: updatedResults[pose].verifiedAt || verifiedNow
      };
      persistedLivenessRequestIds[pose] = updatedResults[pose].requestId || '';
    }

    try {
      await models.IdentityProfile.findOneAndUpdate(
        { userId: lockedSession.userId },
        {
          $set: {
            userId: lockedSession.userId,
            isActive: true,
            idNumberHmac: ocr.idNumberHmac,
            idNumberEncrypted: ocr.idNumberEncrypted,
            idNumberMasked: ocr.idNumberMasked,
            fullName: ocr.fullName,
            birthday: ocr.birthday,
            sex: ocr.sex,
            nationality: ocr.nationality,
            address: ocr.address,
            hometown: ocr.hometown,
            issueDate: ocr.issueDate,
            issueBy: ocr.issueBy,
            expiryRaw: ocr.expiryRaw,
            expiryDate: ocr.expiryDate,
            isPermanentExpiry: ocr.isPermanentExpiry,
            documentType: ocr.documentType,
            verificationMethod: VerificationMethod.DOCUMENT_AND_LIVENESS,
            documentSpoofCheckPassed: true,
            spoofCheckPassed: true,
            documentOcrPassed: true,
            faceMatchingVerified: null,
            faceMatchVerified: null,
            faceMatchScore: null,
            faceMatchThreshold: null,
            livenessVerified: true,
            cccdOwnershipVerified: false,
            livenessResults: persistedLivenessResults,
            policyVersion: config.policyVersion,
            providerRequestIds: {
              spoofCheck: findLastDocRequestId('id_pack_spoof_check'),
              ocr: findLastDocRequestId('id_card'),
              faceMatching: '',
              faceLiveness: persistedLivenessRequestIds
            },
            verifiedSessionId: lockedSession.sessionId,
            verifiedAt: verifiedNow,
            revokedAt: null,
            revokedReason: ''
          }
        },
        { upsert: true, new: true, runValidators: true }
      );
    } catch (dbErr) {
      if (dbErr && dbErr.code === 11000) {
        const dupFail = await models.VerificationSession.findOneAndUpdate(
          { sessionId: lockedSession.sessionId },
          {
            $set: {
              status: VerificationSessionStatus.FAILED,
              processingStage: ProcessingStage.IDLE,
              currentStep: EkycStep.RESULT,
              failureCode: 'DUPLICATE_IDENTITY_DOCUMENT',
              failureReason: 'Số Căn cước công dân này vừa được đăng ký xác minh cho một tài khoản khác trên hệ thống.'
            },
            $inc: { 'apiCallCounts.faceLiveness': 1 },
            $push: { providerRequestIds: callTrace }
          },
          { new: true }
        );
        broadcastDesktopUpdate(dupFail);
        throw new EkycDomainError(dupFail.failureReason, {
          statusCode: 409,
          code: 'DUPLICATE_IDENTITY_DOCUMENT',
          details: { session: toMobileSessionPayload(dupFail) }
        });
      }
      throw dbErr;
    }

    const userBefore = await models.User.findById(lockedSession.userId).select('ekycStatus trustScore address');
    const userUpdateFields = {
      ekycStatus: UserEkycStatus.VERIFIED,
      verificationMethod: VerificationMethod.DOCUMENT_AND_LIVENESS,
      livenessVerified: true,
      ekycVerifiedAt: verifiedNow,
      ekycExpiresAt: ocr.expiryDate || null,
      fullName: ocr.fullName,
      idCardNumber: ocr.idNumberMasked,
      idCardImages: []
    };

    if (!userBefore?.address && ocr.address) {
      userUpdateFields.address = ocr.address;
    }

    await models.User.findByIdAndUpdate(
      lockedSession.userId,
      { $set: userUpdateFields },
      { new: true, runValidators: true }
    );

    const updatedTrustUser = await trustScoreRecalculator(lockedSession.userId);

    await models.AuditLog.create({
      actorId: lockedSession.userId,
      action: 'user.ekyc.verified',
      targetType: 'User',
      targetId: lockedSession.userId,
      before: {
        ekycStatus: userBefore?.ekycStatus || UserEkycStatus.UNVERIFIED,
        trustScore: userBefore?.trustScore ?? 50
      },
      after: {
        ekycStatus: UserEkycStatus.VERIFIED,
        verificationMethod: VerificationMethod.DOCUMENT_AND_LIVENESS,
        livenessVerified: true,
        faceMatchingVerified: null,
        cccdOwnershipVerified: false,
        trustScore: updatedTrustUser?.trustScore ?? 70
      },
      reason: 'Verified via Viettel AI (ID Pack Spoof Check + Document OCR + 5-Pose Full Liveness Detection)',
      metadata: {
        sessionId: lockedSession.sessionId,
        policyVersion: config.policyVersion,
        providerRequestIds: {
          spoofCheck: findLastDocRequestId('id_pack_spoof_check'),
          ocr: findLastDocRequestId('id_card'),
          faceLiveness: persistedLivenessRequestIds
        }
      }
    });

    await deleteSessionTempAssets(lockedSession.sessionId);

    const completedSession = await models.VerificationSession.findOneAndUpdate(
      { sessionId: lockedSession.sessionId },
      {
        $set: {
          status: VerificationSessionStatus.COMPLETED,
          processingStage: ProcessingStage.IDLE,
          currentStep: EkycStep.RESULT,
          currentPoseIndex: ALL_LIVENESS_POSES.length,
          livenessVerified: true,
          completedAt: verifiedNow,
          lastLivenessActivityAt: verifiedNow,
          [`livenessResults.${expectedPose}`]: updatedResults[expectedPose],
          failureCode: '',
          failureReason: ''
        },
        $inc: { 'apiCallCounts.faceLiveness': 1 },
        $push: { providerRequestIds: callTrace }
      },
      { new: true }
    );

    broadcastDesktopUpdate(completedSession);
    return {
      completed: true,
      passedPose: expectedPose,
      nextPose: null,
      session: toMobileSessionPayload(completedSession)
    };
  };

  /**
   * POST /api/ekyc/sessions/:sessionId/cancel
   */
  const cancelSession = async ({ sessionId, userId = null, mobileSession = null }) => {
    const target = mobileSession || await models.VerificationSession.findOne({ sessionId: String(sessionId) });
    if (!target) {
      throw new EkycDomainError('Không tìm thấy phiên xác minh.', {
        statusCode: 404,
        code: 'SESSION_NOT_FOUND'
      });
    }

    if (userId && String(target.userId) !== String(userId)) {
      throw new EkycDomainError('Bạn không có quyền hủy phiên xác minh này.', {
        statusCode: 403,
        code: 'FORBIDDEN_SESSION_ACCESS'
      });
    }

    const checked = await expireSessionIfNeeded(target);
    if (checked.status === VerificationSessionStatus.COMPLETED) {
      throw new EkycDomainError('Phiên xác minh đã hoàn tất nên không thể hủy.', {
        statusCode: 409,
        code: 'SESSION_ALREADY_COMPLETED'
      });
    }

    if (TERMINAL_SESSION_STATUSES.includes(checked.status)) {
      await deleteSessionTempAssets(checked.sessionId);
      return toDesktopSafeSessionPayload(checked);
    }

    const now = nowGetter();
    const cancelled = await models.VerificationSession.findOneAndUpdate(
      {
        sessionId: checked.sessionId,
        status: { $nin: TERMINAL_SESSION_STATUSES }
      },
      {
        $set: {
          status: VerificationSessionStatus.CANCELLED,
          processingStage: ProcessingStage.IDLE,
          currentStep: EkycStep.RESULT,
          cancelledAt: now,
          mobileAccessTokenHash: '',
          failureCode: 'USER_CANCELLED',
          failureReason: 'Phiên xác minh đã bị hủy.'
        }
      },
      { new: true }
    );

    await deleteSessionTempAssets(checked.sessionId);
    const effective = cancelled || checked;
    broadcastDesktopUpdate(effective);
    return toDesktopSafeSessionPayload(effective);
  };

  const cleanupExpiredSessionsAndAssets = async () => {
    const now = nowGetter();
    const expiredSessions = await models.VerificationSession.find({
      status: { $in: ACTIVE_SESSION_STATUSES },
      expiresAt: { $lte: now }
    }).select('sessionId');

    if (expiredSessions.length > 0) {
      const expiredIds = expiredSessions.map((s) => s.sessionId);
      await models.VerificationSession.updateMany(
        { sessionId: { $in: expiredIds }, status: { $in: ACTIVE_SESSION_STATUSES } },
        {
          $set: {
            status: VerificationSessionStatus.EXPIRED,
            processingStage: ProcessingStage.IDLE,
            currentStep: EkycStep.RESULT,
            failureCode: 'SESSION_EXPIRED',
            failureReason: 'Phiên xác minh đã hết hạn.'
          }
        }
      );
      if (models.EkycTempAsset) {
        await models.EkycTempAsset.deleteMany({ sessionId: { $in: expiredIds } });
      }

      for (const sid of expiredIds) {
        const doc = await models.VerificationSession.findOne({ sessionId: sid });
        if (doc) broadcastDesktopUpdate(doc);
      }
    }

    if (models.EkycTempAsset) {
      await models.EkycTempAsset.deleteMany({ purgeAt: { $lte: now } });
    }
  };

  return {
    getAccountEkycStatus,
    createSession,
    claimSession,
    getSessionForOwner,
    getSessionForMobile,
    acceptConsent,
    submitDocuments,
    confirmDocumentOcr,
    submitLivenessPose,
    cancelSession,
    cleanupExpiredSessionsAndAssets,
    isUserVerificationCurrentlyValid
  };
};

const defaultEkycService = createEkycService();

module.exports = {
  EkycDomainError,
  POSE_LABELS_VI,
  generateLivenessChallengeSequence,
  parseCalendarDateParts,
  validateAndNormalizeOcr,
  getDesktopUiPhase,
  toDesktopSafeSessionPayload,
  toMobileSessionPayload,
  createEkycService,
  defaultEkycService
};
