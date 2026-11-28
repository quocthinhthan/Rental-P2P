// backend/utils/ekycCrypto.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ENCRYPTION_VERSION = 'v1';

const getBaseSecret = () => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required for cryptographic operations');
  }
  return jwtSecret;
};

const deriveKey = (explicitSecret, purposeInfo) => {
  const rawMaterial = (typeof explicitSecret === 'string' && explicitSecret.trim().length >= 16)
    ? explicitSecret.trim()
    : getBaseSecret();

  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(rawMaterial, 'utf8'),
      Buffer.from('rentalp2p-ekyc-salt-v1', 'utf8'),
      Buffer.from(purposeInfo, 'utf8'),
      32
    )
  );
};

const getHmacKey = () => deriveKey(process.env.EKYC_HMAC_SECRET, 'rentalp2p-ekyc-id-hmac-v1');
const getEncryptionKey = () => deriveKey(process.env.EKYC_ENCRYPTION_KEY, 'rentalp2p-ekyc-aes-256-gcm-v1');
const getMobileJwtSecret = () => deriveKey(process.env.EKYC_SESSION_JWT_SECRET, 'rentalp2p-ekyc-mobile-jwt-v1');

/**
 * Generates a cryptographically secure random handoff token (256 bits of entropy).
 */
const generateHandoffToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Generates a public session identifier with 128+ bits of randomness.
 */
const generateSessionId = () => crypto.randomUUID();

/**
 * Hashes an opaque session or handoff token with SHA-256 for storage/lookup.
 */
const hashToken = (token) => {
  if (typeof token !== 'string' || !token) return '';
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
};

/**
 * Keyed HMAC-SHA256 for duplicate CCCD detection without storing plaintext ID numbers.
 */
const computeIdNumberHmac = (idNumber) => {
  const normalized = String(idNumber || '').trim();
  if (!normalized) {
    throw new Error('Cannot compute HMAC for empty ID number');
  }
  return crypto
    .createHmac('sha256', getHmacKey())
    .update(normalized, 'utf8')
    .digest('hex');
};

/**
 * Masks an ID card number for UI display (e.g. ********1234).
 */
const maskIdNumber = (idNumber) => {
  const normalized = String(idNumber || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 4) return '*'.repeat(normalized.length);
  const visibleTail = normalized.slice(-4);
  return `${'*'.repeat(Math.max(4, normalized.length - 4))}${visibleTail}`;
};

/**
 * Encrypts sensitive UTF-8 text using AES-256-GCM with optional AAD binding.
 */
const encryptSensitiveText = (plainText, aad = '') => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  if (aad) {
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  }
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTION_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptSensitiveText = (serialized, aad = '') => {
  if (typeof serialized !== 'string' || !serialized) return '';
  const parts = serialized.split(':');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error('Unsupported encrypted payload format');
  }
  const [, ivHex, tagHex, cipherHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivHex, 'hex')
  );
  if (aad) {
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  }
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
};

/**
 * Encrypts binary image buffers (temporary reference front ID image) using AES-256-GCM.
 */
const encryptBuffer = (buffer, aad = '') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('encryptBuffer requires a non-empty Buffer');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  if (aad) {
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  }
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext
  };
};

const decryptBuffer = ({ iv, authTag, ciphertext }, aad = '') => {
  const rawCipher = Buffer.isBuffer(ciphertext)
    ? ciphertext
    : Buffer.from(ciphertext?.buffer || ciphertext || []);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(iv, 'hex')
  );
  if (aad) {
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  }
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return Buffer.concat([decipher.update(rawCipher), decipher.final()]);
};

/**
 * Issues a short-lived token strictly scoped to a single eKYC session.
 * Uses a dedicated derived signing key AND purpose='ekyc_session' claim so it
 * can never authenticate general user endpoints.
 */
const createEkycMobileSessionToken = ({ sessionId, expiresAt }) => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Math.max(nowSeconds + 60, Math.floor(new Date(expiresAt).getTime() / 1000));

  return jwt.sign(
    {
      purpose: 'ekyc_session',
      sid: String(sessionId),
      jti: crypto.randomBytes(16).toString('hex'),
      exp: expSeconds
    },
    getMobileJwtSecret()
  );
};

const verifyEkycMobileSessionToken = (token) => {
  const decoded = jwt.verify(token, getMobileJwtSecret());
  if (!decoded || decoded.purpose !== 'ekyc_session' || !decoded.sid) {
    throw new Error('Invalid eKYC session token scope');
  }
  return decoded;
};

module.exports = {
  generateHandoffToken,
  generateSessionId,
  hashToken,
  computeIdNumberHmac,
  maskIdNumber,
  encryptSensitiveText,
  decryptSensitiveText,
  encryptBuffer,
  decryptBuffer,
  createEkycMobileSessionToken,
  verifyEkycMobileSessionToken
};
