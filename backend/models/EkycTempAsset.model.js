// backend/models/EkycTempAsset.model.js
const mongoose = require('mongoose');

/**
 * Encrypted temporary holder for the verified CCCD front image required as
 * reference (`image_cmt`) in Step 6 (Face Matching).
 *
 * Security guarantees:
 * - Zero public URL (never uploaded to public object storage).
 * - Encrypted at rest with AES-256-GCM bound to sessionId + userId as AAD.
 * - Explicitly deleted upon session completion, failure, cancellation, or retry.
 * - Automatically purged by MongoDB TTL index via `purgeAt` as a safety net.
 */
const EkycTempAssetSchema = new mongoose.Schema({
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
  iv: {
    type: String,
    required: true
  },
  authTag: {
    type: String,
    required: true
  },
  ciphertext: {
    type: Buffer,
    required: true
  },
  mimeType: {
    type: String,
    required: true
  },
  extension: {
    type: String,
    default: 'jpg'
  },
  byteLength: {
    type: Number,
    required: true
  },
  sha256: {
    type: String,
    required: true
  },
  purgeAt: {
    type: Date,
    required: true
  }
}, { timestamps: true });

EkycTempAssetSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EkycTempAsset', EkycTempAssetSchema);
