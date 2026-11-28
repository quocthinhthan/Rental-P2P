// backend/models/VerificationSession.model.js
const mongoose = require('mongoose');
const {
  VerificationSessionStatus,
  EkycStep,
  ProcessingStage,
  InitiationMode,
  ALL_LIVENESS_POSES
} = require('../enums/ekyc.enum');

const ProviderCallTraceSchema = new mongoose.Schema({
  api: { type: String, required: true },
  pose: { type: String, default: '' },
  requestId: { type: String, default: '' },
  code: { type: Number, default: null },
  httpStatus: { type: Number, default: null },
  durationMs: { type: Number, default: 0 },
  outcome: { type: String, default: '' },
  calledAt: { type: Date, default: Date.now }
}, { _id: false });

const SessionLivenessPoseStateSchema = new mongoose.Schema({
  passed: { type: Boolean, default: false },
  score: { type: Number, default: null },
  requestId: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  verifiedAt: { type: Date, default: null }
}, { _id: false });

const OcrSummarySchema = new mongoose.Schema({
  idNumberHmac: { type: String, default: '', select: false },
  idNumberEncrypted: { type: String, default: '', select: false },
  idNumberMasked: { type: String, default: '' },
  fullName: { type: String, default: '' },
  birthday: { type: String, default: '' },
  sex: { type: String, default: '' },
  nationality: { type: String, default: '' },
  address: { type: String, default: '' },
  hometown: { type: String, default: '' },
  issueDate: { type: String, default: '' },
  issueBy: { type: String, default: '' },
  expiryRaw: { type: String, default: '' },
  expiryDate: { type: Date, default: null },
  isPermanentExpiry: { type: Boolean, default: false },
  documentType: { type: String, default: '' },
  typeList: { type: String, default: '' }
}, { _id: false });

const VerificationSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  initiationMode: {
    type: String,
    enum: Object.values(InitiationMode),
    default: InitiationMode.QR
  },
  status: {
    type: String,
    enum: Object.values(VerificationSessionStatus),
    default: VerificationSessionStatus.CREATED,
    index: true
  },
  processingStage: {
    type: String,
    enum: Object.values(ProcessingStage),
    default: ProcessingStage.IDLE
  },
  currentStep: {
    type: String,
    enum: Object.values(EkycStep),
    default: EkycStep.WAITING_SCAN
  },
  handoffTokenHash: {
    type: String,
    index: true,
    select: false
  },
  handoffTokenUsed: {
    type: Boolean,
    default: false
  },
  mobileAccessTokenHash: {
    type: String,
    default: '',
    select: false
  },
  claimedDeviceInfo: {
    type: String,
    default: ''
  },
  consentAcceptedAt: {
    type: Date,
    default: null
  },
  consentPolicyVersion: {
    type: String,
    default: ''
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  claimedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  cancelledAt: {
    type: Date,
    default: null
  },
  documentAttempts: {
    type: Number,
    default: 0
  },
  maxDocumentAttempts: {
    type: Number,
    default: 3
  },
  livenessRetries: {
    type: Number,
    default: 0
  },
  maxLivenessRetries: {
    type: Number,
    default: 5
  },
  spoofCheckPassed: {
    type: Boolean,
    default: false
  },
  documentVerified: {
    type: Boolean,
    default: false
  },
  documentConfirmed: {
    type: Boolean,
    default: false
  },
  livenessVerified: {
    type: Boolean,
    default: false
  },
  // Ordered 5-pose challenge list: ['Portrait', ...shuffled(['Left', 'Right', 'Top', 'Bottom'])]
  livenessChallenges: {
    type: [{ type: String, enum: ALL_LIVENESS_POSES }],
    default: []
  },
  currentPoseIndex: {
    type: Number,
    default: 0
  },
  livenessStartedAt: {
    type: Date,
    default: null
  },
  lastLivenessActivityAt: {
    type: Date,
    default: null
  },
  // Prevents replay/reuse of identical frames across poses or retries
  usedLivenessImageHashes: {
    type: [String],
    default: [],
    select: false
  },
  livenessResults: {
    Portrait: { type: SessionLivenessPoseStateSchema, default: () => ({}) },
    Left: { type: SessionLivenessPoseStateSchema, default: () => ({}) },
    Right: { type: SessionLivenessPoseStateSchema, default: () => ({}) },
    Top: { type: SessionLivenessPoseStateSchema, default: () => ({}) },
    Bottom: { type: SessionLivenessPoseStateSchema, default: () => ({}) }
  },
  lastDocumentPairHash: {
    type: String,
    default: ''
  },
  ocrSummary: {
    type: OcrSummarySchema,
    default: null
  },
  failureCode: {
    type: String,
    default: ''
  },
  failureReason: {
    type: String,
    default: ''
  },
  apiCallCounts: {
    spoofCheck: { type: Number, default: 0 },
    ocr: { type: Number, default: 0 },
    faceLiveness: { type: Number, default: 0 },
    faceMatching: { type: Number, default: 0 }
  },
  providerRequestIds: {
    type: [ProviderCallTraceSchema],
    default: []
  }
}, { timestamps: true });

VerificationSessionSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('VerificationSession', VerificationSessionSchema);
