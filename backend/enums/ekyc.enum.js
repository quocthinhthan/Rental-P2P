// backend/enums/ekyc.enum.js

const VerificationSessionStatus = Object.freeze({
  CREATED: 'CREATED',
  CLAIMED: 'CLAIMED',
  CONSENT_ACCEPTED: 'CONSENT_ACCEPTED',
  DOCUMENT_PROCESSING: 'DOCUMENT_PROCESSING',
  DOCUMENT_RETRY_REQUIRED: 'DOCUMENT_RETRY_REQUIRED',
  DOCUMENT_VERIFIED: 'DOCUMENT_VERIFIED',
  DOCUMENT_CONFIRMED: 'DOCUMENT_CONFIRMED',
  LIVENESS_IN_PROGRESS: 'LIVENESS_IN_PROGRESS',
  LIVENESS_PROCESSING: 'LIVENESS_PROCESSING',
  LIVENESS_RETRY_REQUIRED: 'LIVENESS_RETRY_REQUIRED',
  // Kept for backward compatibility with historical session records
  FACE_PROCESSING: 'FACE_PROCESSING',
  FACE_RETRY_REQUIRED: 'FACE_RETRY_REQUIRED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

const EkycStep = Object.freeze({
  WAITING_SCAN: 'WAITING_SCAN',
  CONSENT: 'CONSENT',
  DOCUMENT_CAPTURE: 'DOCUMENT_CAPTURE',
  DOCUMENT_REVIEW: 'DOCUMENT_REVIEW',
  LIVENESS_CAPTURE: 'LIVENESS_CAPTURE',
  // Legacy alias preserved for historical records
  FACE_CAPTURE: 'FACE_CAPTURE',
  RESULT: 'RESULT'
});

const ProcessingStage = Object.freeze({
  IDLE: 'IDLE',
  SPOOF_CHECK: 'SPOOF_CHECK',
  OCR: 'OCR',
  FACE_LIVENESS: 'FACE_LIVENESS',
  FACE_MATCHING: 'FACE_MATCHING',
  FINALIZING: 'FINALIZING'
});

const InitiationMode = Object.freeze({
  QR: 'QR',
  DIRECT: 'DIRECT'
});

/**
 * Exact case-sensitive `label_pose` values specified by Viettel AI `/ekyc/face_liveness`.
 */
const LivenessPose = Object.freeze({
  PORTRAIT: 'Portrait',
  LEFT: 'Left',
  RIGHT: 'Right',
  TOP: 'Top',
  BOTTOM: 'Bottom'
});

const ALL_LIVENESS_POSES = Object.freeze([
  LivenessPose.PORTRAIT,
  LivenessPose.LEFT,
  LivenessPose.RIGHT,
  LivenessPose.TOP,
  LivenessPose.BOTTOM
]);

const DIRECTIONAL_LIVENESS_POSES = Object.freeze([
  LivenessPose.LEFT,
  LivenessPose.RIGHT,
  LivenessPose.TOP,
  LivenessPose.BOTTOM
]);

// Matches existing User.model.js lowercase convention for backward compatibility
const UserEkycStatus = Object.freeze({
  UNVERIFIED: 'unverified',
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected'
});

const VerificationMethod = Object.freeze({
  NONE: 'NONE',
  LEGACY_FPT_OCR: 'LEGACY_FPT_OCR',
  DOCUMENT_AND_FACE_MATCH: 'DOCUMENT_AND_FACE_MATCH',
  DOCUMENT_AND_LIVENESS: 'DOCUMENT_AND_LIVENESS'
});

const TERMINAL_SESSION_STATUSES = Object.freeze([
  VerificationSessionStatus.COMPLETED,
  VerificationSessionStatus.FAILED,
  VerificationSessionStatus.EXPIRED,
  VerificationSessionStatus.CANCELLED
]);

const ACTIVE_SESSION_STATUSES = Object.freeze(
  Object.values(VerificationSessionStatus).filter(
    (status) => !TERMINAL_SESSION_STATUSES.includes(status)
  )
);

module.exports = {
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
};
