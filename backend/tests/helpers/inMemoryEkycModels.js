// backend/tests/helpers/inMemoryEkycModels.js
const crypto = require('crypto');

const cloneDeep = (value) => {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneDeep(v);
    }
    return out;
  }
  return value;
};

const getByPath = (obj, dottedPath) => {
  const parts = dottedPath.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
};

const setByPath = (obj, dottedPath, val) => {
  const parts = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = cloneDeep(val);
};

const toComparable = (v) => (v instanceof Date ? v.getTime() : v);

const matchesCondition = (actual, cond) => {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Buffer.isBuffer(cond)) {
    const ops = Object.keys(cond);
    const hasOperator = ops.some((k) => k.startsWith('$'));
    if (hasOperator) {
      for (const [op, expected] of Object.entries(cond)) {
        if (op === '$in') {
          if (!expected.map(String).includes(String(actual))) return false;
        } else if (op === '$nin') {
          if (expected.map(String).includes(String(actual))) return false;
        } else if (op === '$ne') {
          if (String(actual) === String(expected)) return false;
        } else if (op === '$gt') {
          if (!(toComparable(actual) > toComparable(expected))) return false;
        } else if (op === '$gte') {
          if (!(toComparable(actual) >= toComparable(expected))) return false;
        } else if (op === '$lt') {
          if (!(toComparable(actual) < toComparable(expected))) return false;
        } else if (op === '$lte') {
          if (!(toComparable(actual) <= toComparable(expected))) return false;
        }
      }
      return true;
    }
  }

  if (actual === undefined && cond === null) return true;
  if (actual instanceof Date || cond instanceof Date) {
    return toComparable(actual) === toComparable(cond);
  }
  return String(actual) === String(cond);
};

const matchesFilter = (doc, filter = {}) => {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    const actual = getByPath(doc, key);
    if (!matchesCondition(actual, cond)) return false;
  }
  return true;
};

const applyUpdateOps = (doc, update = {}) => {
  if (!update.$set && !update.$inc && !update.$push) {
    for (const [k, v] of Object.entries(update)) {
      if (!k.startsWith('$')) setByPath(doc, k, v);
    }
  }

  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      setByPath(doc, k, v);
    }
  }

  if (update.$inc) {
    for (const [k, delta] of Object.entries(update.$inc)) {
      const prev = Number(getByPath(doc, k) || 0);
      setByPath(doc, k, prev + Number(delta));
    }
  }

  if (update.$push) {
    for (const [k, spec] of Object.entries(update.$push)) {
      const arr = Array.isArray(getByPath(doc, k)) ? cloneDeep(getByPath(doc, k)) : [];
      if (spec && typeof spec === 'object' && Array.isArray(spec.$each)) {
        arr.push(...cloneDeep(spec.$each));
      } else {
        arr.push(cloneDeep(spec));
      }
      setByPath(doc, k, arr);
    }
  }

  doc.updatedAt = new Date();
};

const wrapQueryResult = (value, hiddenPaths = []) => {
  let selectedSpec = '';

  const applyProjection = (item) => {
    if (!item) return null;
    const copy = cloneDeep(item);
    const plusFields = new Set(
      selectedSpec
        .split(/\s+/)
        .filter((t) => t.startsWith('+'))
        .map((t) => t.slice(1))
    );

    for (const hp of hiddenPaths) {
      if (!plusFields.has(hp)) {
        const parts = hp.split('.');
        if (parts.length === 1) {
          delete copy[hp];
        } else if (copy[parts[0]] && typeof copy[parts[0]] === 'object') {
          delete copy[parts[0]][parts[1]];
        }
      }
    }
    return copy;
  };

  const finalize = () => (Array.isArray(value) ? value.map(applyProjection) : applyProjection(value));

  const queryObj = {
    select(spec = '') {
      selectedSpec = spec;
      return queryObj;
    },
    sort(sortSpec = {}) {
      if (Array.isArray(value)) {
        const [[field, dir]] = Object.entries(sortSpec);
        value.sort((a, b) => {
          const av = toComparable(getByPath(a, field));
          const bv = toComparable(getByPath(b, field));
          return dir === -1 ? bv - av : av - bv;
        });
      }
      return queryObj;
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve().then(finalize).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve().then(finalize).catch(onRejected);
    }
  };

  return queryObj;
};

const createCollection = ({ defaults = {}, hiddenPaths = [], beforeWrite = null } = {}) => {
  const rows = [];

  return {
    _rows: rows,

    async create(payload) {
      const now = new Date();
      const doc = {
        _id: payload._id || crypto.randomBytes(12).toString('hex'),
        createdAt: now,
        updatedAt: now,
        ...cloneDeep(defaults),
        ...cloneDeep(payload)
      };
      if (beforeWrite) beforeWrite(doc, rows, null);
      rows.push(doc);
      return cloneDeep(doc);
    },

    findById(id) {
      const found = rows.find((r) => String(r._id) === String(id)) || null;
      return wrapQueryResult(found ? cloneDeep(found) : null, hiddenPaths);
    },

    findOne(filter = {}) {
      const found = rows.find((r) => matchesFilter(r, filter)) || null;
      return wrapQueryResult(found ? cloneDeep(found) : null, hiddenPaths);
    },

    find(filter = {}) {
      const matched = rows.filter((r) => matchesFilter(r, filter)).map(cloneDeep);
      return wrapQueryResult(matched, hiddenPaths);
    },

    findByIdAndUpdate(id, update, options = {}) {
      return this.findOneAndUpdate({ _id: id }, update, options);
    },

    findOneAndUpdate(filter, update, options = {}) {
      const idx = rows.findIndex((r) => matchesFilter(r, filter));
      if (idx === -1) {
        if (!options.upsert) {
          return wrapQueryResult(null, hiddenPaths);
        }
        const now = new Date();
        const inserted = {
          _id: crypto.randomBytes(12).toString('hex'),
          createdAt: now,
          updatedAt: now,
          ...cloneDeep(defaults)
        };
        for (const [k, v] of Object.entries(filter || {})) {
          if (!k.startsWith('$') && (typeof v !== 'object' || v === null)) {
            setByPath(inserted, k, v);
          }
        }
        applyUpdateOps(inserted, update);
        if (beforeWrite) beforeWrite(inserted, rows, null);
        rows.push(inserted);
        return wrapQueryResult(cloneDeep(inserted), hiddenPaths);
      }

      const candidate = cloneDeep(rows[idx]);
      applyUpdateOps(candidate, update);
      if (beforeWrite) beforeWrite(candidate, rows, rows[idx]._id);
      rows[idx] = candidate;
      return wrapQueryResult(cloneDeep(options.new ? candidate : rows[idx]), hiddenPaths);
    },

    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (let i = 0; i < rows.length; i += 1) {
        if (matchesFilter(rows[i], filter)) {
          applyUpdateOps(rows[i], update);
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },

    async deleteMany(filter = {}) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matchesFilter(rows[i], filter)) {
          rows.splice(i, 1);
        }
      }
      return { deletedCount: before - rows.length };
    },

    async countDocuments(filter = {}) {
      return rows.filter((r) => matchesFilter(r, filter)).length;
    }
  };
};

const createInMemoryEkycStore = () => {
  const User = createCollection({
    defaults: {
      fullName: 'Người dùng thử nghiệm',
      email: 'test@example.com',
      password: 'hashed-password',
      role: 'user',
      isBanned: false,
      suspendedUntil: null,
      trustScore: 50,
      averageRating: 0,
      totalReviews: 0,
      ekycStatus: 'unverified',
      verificationMethod: 'NONE',
      livenessVerified: false,
      ekycVerifiedAt: null,
      ekycExpiresAt: null,
      idCardNumber: '',
      idCardImages: [],
      address: ''
    }
  });

  const IdentityProfile = createCollection({
    defaults: {
      isActive: true,
      livenessVerified: false
    },
    hiddenPaths: ['idNumberHmac', 'idNumberEncrypted'],
    beforeWrite: (candidate, rows, existingId) => {
      if (candidate.isActive && candidate.idNumberHmac) {
        const dup = rows.find(
          (r) =>
            r.isActive
            && r.idNumberHmac === candidate.idNumberHmac
            && String(r._id) !== String(existingId || '')
        );
        if (dup) {
          const err = new Error('E11000 duplicate key error collection: identityprofiles index: idNumberHmac_1');
          err.code = 11000;
          throw err;
        }
      }
    }
  });

  const VerificationSession = createCollection({
    defaults: {
      initiationMode: 'QR',
      status: 'CREATED',
      processingStage: 'IDLE',
      currentStep: 'WAITING_SCAN',
      handoffTokenHash: null,
      handoffTokenUsed: false,
      mobileAccessTokenHash: '',
      claimedDeviceInfo: '',
      consentAcceptedAt: null,
      consentPolicyVersion: '',
      claimedAt: null,
      completedAt: null,
      cancelledAt: null,
      documentAttempts: 0,
      maxDocumentAttempts: 3,
      livenessRetries: 0,
      maxLivenessRetries: 5,
      spoofCheckPassed: false,
      documentVerified: false,
      documentConfirmed: false,
      livenessVerified: false,
      livenessChallenges: [],
      currentPoseIndex: 0,
      livenessStartedAt: null,
      lastLivenessActivityAt: null,
      usedLivenessImageHashes: [],
      livenessResults: {
        Portrait: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
        Left: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
        Right: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
        Top: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null },
        Bottom: { passed: false, score: null, requestId: '', attempts: 0, verifiedAt: null }
      },
      lastDocumentPairHash: '',
      ocrSummary: null,
      failureCode: '',
      failureReason: '',
      apiCallCounts: { spoofCheck: 0, ocr: 0, faceLiveness: 0, faceMatching: 0 },
      providerRequestIds: []
    },
    hiddenPaths: [
      'handoffTokenHash',
      'mobileAccessTokenHash',
      'usedLivenessImageHashes',
      'ocrSummary.idNumberHmac',
      'ocrSummary.idNumberEncrypted'
    ]
  });

  const EkycTempAsset = createCollection({
    defaults: {
      extension: 'png'
    }
  });

  const AuditLog = createCollection({
    defaults: {
      before: null,
      after: null,
      reason: '',
      metadata: {}
    }
  });

  return {
    User,
    IdentityProfile,
    VerificationSession,
    EkycTempAsset,
    AuditLog
  };
};

/**
 * Generates a syntactically valid binary PNG buffer of arbitrary width/height (> 4 KB)
 * with controllable seed byte so front/back/face test images have distinct SHA-256 hashes.
 */
const makeValidPngBuffer = ({ width = 800, height = 500, seedByte = 0x41, totalBytes = 6000 } = {}) => {
  const buf = Buffer.alloc(totalBytes, seedByte);
  // PNG 8-byte signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR chunk length = 13
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type RGB
  return buf;
};

module.exports = {
  createInMemoryEkycStore,
  makeValidPngBuffer
};
