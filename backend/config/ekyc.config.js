// backend/config/ekyc.config.js

const parsePositiveInt = (raw, fallback, { min = 1, max = 1000 } = {}) => {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parseOptionalThreshold = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return null;
  }
  return parsed;
};

const parseAcceptedValues = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeBaseUrl = (raw) => {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : 'https://viettelai.vn';
  return value.replace(/\/+$/, '');
};

const getEkycConfig = () => {
  const sessionTtlMinutes = parsePositiveInt(process.env.EKYC_SESSION_TTL_MINUTES, 15, { min: 3, max: 60 });
  const timeoutSeconds = parsePositiveInt(process.env.VIETTEL_AI_TIMEOUT_SECONDS, 30, { min: 5, max: 120 });
  const livenessContinuitySeconds = parsePositiveInt(
    process.env.EKYC_LIVENESS_CONTINUITY_SECONDS,
    180,
    { min: 30, max: 900 }
  );
  const maxLivenessRetries = parsePositiveInt(
    process.env.EKYC_MAX_LIVENESS_RETRIES || process.env.EKYC_MAX_FACE_ATTEMPTS,
    5,
    { min: 1, max: 15 }
  );

  return {
    viettelBaseUrl: normalizeBaseUrl(process.env.VIETTEL_AI_BASE_URL),
    viettelToken: typeof process.env.VIETTEL_AI_TOKEN === 'string' ? process.env.VIETTEL_AI_TOKEN.trim() : '',
    // Do NOT assume undocumented string values or score thresholds for face_liveness unless configured
    livenessAcceptedResults: parseAcceptedValues(process.env.VIETTEL_AI_LIVENESS_ACCEPTED_VALUES),
    livenessMinScore: parseOptionalThreshold(process.env.VIETTEL_AI_LIVENESS_MIN_SCORE),
    livenessCookie: typeof process.env.VIETTEL_AI_LIVENESS_COOKIE === 'string'
      ? process.env.VIETTEL_AI_LIVENESS_COOKIE.trim()
      : '',
    timeoutSeconds,
    timeoutMs: timeoutSeconds * 1000,
    sessionTtlMinutes,
    sessionTtlMs: sessionTtlMinutes * 60 * 1000,
    livenessContinuitySeconds,
    livenessContinuityMs: livenessContinuitySeconds * 1000,
    maxDocumentAttempts: parsePositiveInt(process.env.EKYC_MAX_DOCUMENT_ATTEMPTS, 3, { min: 1, max: 10 }),
    maxLivenessRetries,
    maxImageBytes: parsePositiveInt(process.env.EKYC_MAX_IMAGE_BYTES, 5 * 1024 * 1024, {
      min: 256 * 1024,
      max: 10 * 1024 * 1024
    }),
    minImageBytes: 4096,
    minImageWidth: 320,
    minImageHeight: 200,
    maxImageWidth: 8000,
    maxImageHeight: 8000,
    maxImagePixels: 25 * 1000 * 1000,
    policyVersion: (process.env.EKYC_POLICY_VERSION || '2026.2-doc-liveness-5pose').trim()
  };
};

module.exports = {
  getEkycConfig
};
