// backend/models/IdentityProfile.model.js
const mongoose = require('mongoose');
const { VerificationMethod } = require('../enums/ekyc.enum');

const LivenessPoseResultSchema = new mongoose.Schema({
  passed: { type: Boolean, default: false },
  score: { type: Number, default: null, min: 0, max: 1 },
  requestId: { type: String, default: '' },
  verifiedAt: { type: Date, default: null }
}, { _id: false });

const IdentityProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  // Keyed HMAC-SHA256 for duplicate CCCD enforcement across accounts
  idNumberHmac: {
    type: String,
    required: true,
    select: false
  },
  // AES-256-GCM encrypted CCCD number (never returned in API responses)
  idNumberEncrypted: {
    type: String,
    required: true,
    select: false
  },
  idNumberMasked: {
    type: String,
    required: true
  },
  fullName: {
    type: String,
    required: true
  },
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
  verificationMethod: {
    type: String,
    enum: Object.values(VerificationMethod),
    default: VerificationMethod.DOCUMENT_AND_LIVENESS
  },
  documentSpoofCheckPassed: {
    type: Boolean,
    default: true
  },
  // Retained alias for backward compatibility with historical DOCUMENT_AND_FACE_MATCH records
  spoofCheckPassed: {
    type: Boolean,
    default: true
  },
  documentOcrPassed: {
    type: Boolean,
    default: true
  },
  // Null in DOCUMENT_AND_LIVENESS workflow; preserved as boolean on historical DOCUMENT_AND_FACE_MATCH records
  faceMatchingVerified: {
    type: Boolean,
    default: null
  },
  faceMatchVerified: {
    type: Boolean,
    default: null
  },
  faceMatchScore: {
    type: Number,
    default: null,
    min: 0,
    max: 1
  },
  faceMatchThreshold: {
    type: Number,
    default: null,
    min: 0,
    max: 1
  },
  livenessVerified: {
    type: Boolean,
    default: false
  },
  livenessResults: {
    Portrait: { type: LivenessPoseResultSchema, default: undefined },
    Left: { type: LivenessPoseResultSchema, default: undefined },
    Right: { type: LivenessPoseResultSchema, default: undefined },
    Top: { type: LivenessPoseResultSchema, default: undefined },
    Bottom: { type: LivenessPoseResultSchema, default: undefined }
  },
  // Explicitly false: neither workflow verifies against National Population DB, and DOCUMENT_AND_LIVENESS does not match face to CCCD
  cccdOwnershipVerified: {
    type: Boolean,
    default: false
  },
  policyVersion: {
    type: String,
    default: '2026.2-doc-liveness-5pose'
  },
  providerRequestIds: {
    spoofCheck: { type: String, default: '' },
    ocr: { type: String, default: '' },
    faceMatching: { type: String, default: '' },
    faceLiveness: {
      Portrait: { type: String, default: '' },
      Left: { type: String, default: '' },
      Right: { type: String, default: '' },
      Top: { type: String, default: '' },
      Bottom: { type: String, default: '' }
    }
  },
  verifiedSessionId: {
    type: String,
    default: ''
  },
  verifiedAt: {
    type: Date,
    required: true
  },
  revokedAt: {
    type: Date,
    default: null
  },
  revokedReason: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// Keep a CCCD bound to its account after revocation or a ban.
// The descending key can coexist with the old ascending partial index.
IdentityProfileSchema.index(
  { idNumberHmac: -1 },
  { unique: true, name: 'identity_profile_unique_cccd' }
);

module.exports = mongoose.model('IdentityProfile', IdentityProfileSchema);
