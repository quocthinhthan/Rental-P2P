// backend/tests/ekyc.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.EKYC_HMAC_SECRET = 'test-hmac-secret-key-at-least-32-chars!!';
process.env.EKYC_ENCRYPTION_KEY = 'test-aes-256-gcm-secret-key-32-chars!!';
process.env.VIETTEL_AI_TOKEN = 'mock-viettel-secret-token-do-not-leak';
process.env.VIETTEL_AI_LIVENESS_ACCEPTED_VALUES = 'REAL_CONFIRMED';
process.env.EKYC_MAX_DOCUMENT_ATTEMPTS = '3';
process.env.EKYC_MAX_LIVENESS_RETRIES = '5';
process.env.EKYC_LIVENESS_CONTINUITY_SECONDS = '180';
process.env.FRONTEND_URL = 'https://rental.thanquocthinh.id.vn';

const { createViettelAiProvider } = require('../services/viettelAi.provider');
const { createEkycService } = require('../services/ekyc.service');
const { createEkycController } = require('../controllers/ekyc.controller');
const { createEkycAuthMiddleware } = require('../middleware/ekycAuth.middleware');
const { createEkycRouter } = require('../routes/ekyc.routes');
const { checkVerified } = require('../middleware/auth.middleware');
const { getTrustLevelFromScore } = require('../services/trustScore.service');
const { ALL_LIVENESS_POSES } = require('../enums/ekyc.enum');
const {
  createInMemoryEkycStore,
  makeValidPngBuffer
} = require('./helpers/inMemoryEkycModels');

const SAMPLE_OCR_INFO = Object.freeze({
  id: '079203001234',
  name: 'NGUYỄN VĂN MINH',
  birthday: '15/08/2000',
  sex: 'Nam',
  nationality: 'Việt Nam',
  address: '19 Nguyễn Hữu Thọ, Phường Tân Hưng, Quận 7, TP. Hồ Chí Minh',
  hometown: 'TP. Hồ Chí Minh',
  issue_date: '10/05/2022',
  issue_by: 'Cục Cảnh sát QLHC về TTXH',
  expiry: '15/08/2040',
  type_list: 'front, back',
  document: 'cccd_front_chip,cccd_back_chip'
});

const createMockProvider = (overrides = {}) => {
  const calls = {
    spoof: [],
    ocr: [],
    liveness: [],
    faceMatching: []
  };

  let spoofImpl = overrides.checkIdPackSpoof || (async () => ({
    passed: true,
    requestId: 'req-spoof-001',
    providerCode: 1,
    httpStatus: 200,
    durationMs: 40
  }));

  let ocrImpl = overrides.extractIdCardOcr || (async () => ({
    passed: true,
    requestId: 'req-ocr-001',
    providerCode: 1,
    httpStatus: 200,
    durationMs: 60,
    information: { ...SAMPLE_OCR_INFO }
  }));

  let livenessImpl = overrides.checkFaceLiveness || (async ({ labelPose }) => ({
    passed: true,
    requestId: `req-live-${labelPose}`,
    providerCode: 1,
    httpStatus: 200,
    durationMs: 50,
    score: 0.96
  }));

  return {
    calls,
    setSpoofImpl(fn) { spoofImpl = fn; },
    setOcrImpl(fn) { ocrImpl = fn; },
    setLivenessImpl(fn) { livenessImpl = fn; },
    async checkIdPackSpoof(args) {
      calls.spoof.push(args);
      return spoofImpl(args);
    },
    async extractIdCardOcr(args) {
      calls.ocr.push(args);
      return ocrImpl(args);
    },
    async checkFaceLiveness(args) {
      calls.liveness.push(args);
      return livenessImpl(args);
    }
  };
};

const setupTestServer = async ({
  providerOverrides = {},
  nowRef = { current: new Date('2026-11-28T12:00:00Z') },
  challengeGenerator = undefined
} = {}) => {
  const models = createInMemoryEkycStore();
  const mockProvider = createMockProvider(providerOverrides);
  const realtimeEvents = [];

  const trustScoreRecalculator = async (userId) => {
    const u = await models.User.findById(userId);
    if (!u) return null;
    const score = u.ekycStatus === 'verified' ? 70 : 50;
    return models.User.findByIdAndUpdate(
      userId,
      { $set: { trustScore: score } },
      { new: true }
    );
  };

  const ekycService = createEkycService({
    models,
    provider: mockProvider,
    realtime: {
      emitEkycSessionUpdate(sessionId, payload) {
        realtimeEvents.push({ sessionId, payload });
      }
    },
    trustScoreRecalculator,
    ...(challengeGenerator ? { challengeGenerator } : {}),
    nowGetter: () => nowRef.current
  });

  const protectUser = async (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized, no token' });
    }
    try {
      const token = auth.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id || decoded.purpose) {
        return res.status(401).json({ message: 'Unauthorized, invalid token scope' });
      }
      const user = await models.User.findById(decoded.id);
      if (!user) return res.status(401).json({ message: 'User not found' });
      if (user.isBanned) return res.status(403).json({ message: 'Banned' });
      req.user = user;
      return next();
    } catch {
      return res.status(401).json({ message: 'Unauthorized, token failed' });
    }
  };

  const ekycAuth = createEkycAuthMiddleware({
    SessionModel: models.VerificationSession,
    UserModel: models.User,
    protectMiddleware: protectUser
  });

  const controller = createEkycController({ ekycService });
  const router = createEkycRouter({
    controller,
    protectUser,
    protectMobile: ekycAuth.protectEkycMobileSession,
    protectOwnerOrMobile: ekycAuth.protectEkycOwnerOrMobile,
    enableRateLimit: false
  });

  const app = express();
  app.use(express.json());
  app.use('/api/ekyc', router);
  app.get('/api/auth/me', protectUser, (req, res) => res.status(200).json(req.user));
  app.post('/api/rentals-protected-probe', protectUser, checkVerified, (req, res) => {
    res.status(200).json({ ok: true });
  });

  const baseUrl = 'http://ekyc.local';

  const invokeApp = async (fullUrl, init = {}) => {
    const parsedUrl = new URL(fullUrl, baseUrl);
    const method = (init.method || 'GET').toUpperCase();
    const lowerHeaders = { host: parsedUrl.host };

    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        lowerHeaders[k.toLowerCase()] = String(v);
      }
    }

    let bodyBuffer = Buffer.alloc(0);
    if (init.body instanceof FormData) {
      const serialized = new Response(init.body);
      bodyBuffer = Buffer.from(await serialized.arrayBuffer());
      lowerHeaders['content-type'] = serialized.headers.get('content-type');
      lowerHeaders['content-length'] = String(bodyBuffer.length);
    } else if (typeof init.body === 'string') {
      bodyBuffer = Buffer.from(init.body, 'utf8');
      lowerHeaders['content-length'] = String(bodyBuffer.length);
    } else if (Buffer.isBuffer(init.body)) {
      bodyBuffer = init.body;
      lowerHeaders['content-length'] = String(bodyBuffer.length);
    }

    return new Promise((resolve, reject) => {
      const inSocket = new Duplex({
        read() {},
        write(_chunk, _enc, cb) { cb(); }
      });
      inSocket.remoteAddress = '127.0.0.1';

      const req = new http.IncomingMessage(inSocket);
      req.method = method;
      req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
      req.headers = lowerHeaders;

      const rawChunks = [];
      const outSocket = new Duplex({
        read() {},
        write(chunk, enc, cb) {
          rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
          cb();
        }
      });
      outSocket.remoteAddress = '127.0.0.1';

      const res = new http.ServerResponse(req);
      res.assignSocket(outSocket);

      res.on('finish', () => {
        const rawHttp = Buffer.concat(rawChunks);
        const sepIdx = rawHttp.indexOf('\r\n\r\n');
        const bodySlice = sepIdx >= 0 ? rawHttp.subarray(sepIdx + 4) : Buffer.alloc(0);
        const bodyText = bodySlice.toString('utf8');
        const resHeaders = res.getHeaders();

        resolve({
          status: res.statusCode,
          headers: {
            get(name) {
              const val = resHeaders[String(name).toLowerCase()];
              return val === undefined ? null : String(val);
            }
          },
          async text() { return bodyText; },
          async json() { return bodyText ? JSON.parse(bodyText) : null; }
        });
      });

      res.on('error', reject);

      app(req, res);
      if (bodyBuffer.length > 0) {
        req.push(bodyBuffer);
      }
      req.complete = true;
      req.push(null);
    });
  };

  const createUserAndToken = async (fields = {}) => {
    const user = await models.User.create({
      fullName: fields.fullName || 'Trần Thị B',
      email: fields.email || `user-${Math.random().toString(36).slice(2)}@example.com`,
      ...fields
    });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return { user, token };
  };

  const extractTokenFromQrUrl = (qrUrl) => new URL(qrUrl).searchParams.get('token');

  return {
    baseUrl,
    request: invokeApp,
    models,
    mockProvider,
    ekycService,
    realtimeEvents,
    nowRef,
    createUserAndToken,
    extractTokenFromQrUrl,
    close: async () => {}
  };
};

const postDocumentForm = async ({ request, baseUrl, sessionId, mobileToken, frontBuf, backBuf }) => {
  const form = new FormData();
  if (frontBuf) {
    form.append('frontImage', new Blob([frontBuf], { type: 'image/png' }), 'front.png');
  }
  if (backBuf) {
    form.append('backImage', new Blob([backBuf], { type: 'image/png' }), 'back.png');
  }
  const res = await request(`${baseUrl}/api/ekyc/sessions/${sessionId}/documents`, {
    method: 'POST',
    headers: { 'X-Ekyc-Session-Token': mobileToken },
    body: form
  });
  return { status: res.status, body: await res.json() };
};

const postLivenessForm = async ({ request, baseUrl, sessionId, mobileToken, pose, frameBuf }) => {
  const form = new FormData();
  if (frameBuf) {
    form.append('file', new Blob([frameBuf], { type: 'image/png' }), `pose-${pose}.png`);
  }
  if (pose !== undefined) {
    form.append('pose', pose);
  }
  const res = await request(`${baseUrl}/api/ekyc/sessions/${sessionId}/liveness`, {
    method: 'POST',
    headers: { 'X-Ekyc-Session-Token': mobileToken },
    body: form
  });
  return { status: res.status, body: await res.json() };
};

// ============================================================================
// 1. Desktop -> QR -> Mobile 5-Pose Full Liveness Happy Path (7 Requests Total)
// ============================================================================
test('Full Desktop -> QR -> Mobile 5-pose Liveness workflow completes in 7 Viettel AI calls, never calls Face Matching, blocks at 4/5, and syncs Desktop safely', async (t) => {
  const ctx = await setupTestServer();
  t.after(() => ctx.close());

  const { user, token } = await ctx.createUserAndToken();

  // Create QR session on Desktop
  const createRes = await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ initiationMode: 'QR' })
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  const handoffToken = ctx.extractTokenFromQrUrl(created.qrUrl);

  // Claim QR on Mobile
  const claimRes = await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: handoffToken })
  });
  assert.equal(claimRes.status, 200);
  const { sessionId, ekycSessionToken } = await claimRes.json();

  // Accept Consent
  await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sessionId}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': ekycSessionToken },
    body: JSON.stringify({ accepted: true })
  });

  // Upload Front & Back CCCD -> 1 Spoof Check + 1 OCR
  const docRes = await postDocumentForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId,
    mobileToken: ekycSessionToken,
    frontBuf: makeValidPngBuffer({ seedByte: 0x11 }),
    backBuf: makeValidPngBuffer({ seedByte: 0x12 })
  });
  assert.equal(docRes.status, 200);
  assert.equal(docRes.body.session.status, 'DOCUMENT_VERIFIED');

  // Confirm OCR -> Backend generates 5-pose sequence starting with 'Portrait'
  const confirmRes = await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sessionId}/confirm-document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': ekycSessionToken },
    body: JSON.stringify({ action: 'CONFIRM' })
  });
  assert.equal(confirmRes.status, 200);
  const confirmedBody = await confirmRes.json();
  const challengePoses = confirmedBody.session.livenessProgress.poses.map((p) => p.pose);

  assert.equal(challengePoses.length, 5);
  assert.equal(challengePoses[0], 'Portrait');
  assert.deepEqual([...challengePoses].sort(), [...ALL_LIVENESS_POSES].sort());

  // Legacy /face endpoint MUST be disabled (410 Gone)
  const legacyFaceRes = await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sessionId}/face`, {
    method: 'POST',
    headers: { 'X-Ekyc-Session-Token': ekycSessionToken }
  });
  assert.equal(legacyFaceRes.status, 410);
  assert.equal((await legacyFaceRes.json()).code, 'FACE_MATCHING_REPLACED_BY_LIVENESS');

  // Execute first 4/5 poses -> MUST NOT mark account verified yet!
  for (let i = 0; i < 4; i += 1) {
    const pose = challengePoses[i];
    const pRes = await postLivenessForm({
      request: ctx.request,
      baseUrl: ctx.baseUrl,
      sessionId,
      mobileToken: ekycSessionToken,
      pose,
      frameBuf: makeValidPngBuffer({ width: 640, height: 800, seedByte: 0x20 + i })
    });
    assert.equal(pRes.status, 200);
    assert.equal(pRes.body.completed, false);
    assert.equal(pRes.body.session.status, 'LIVENESS_IN_PROGRESS');
    assert.equal(pRes.body.session.livenessProgress.completedCount, i + 1);
  }

  const userAt4of5 = await ctx.models.User.findById(user._id);
  assert.equal(userAt4of5.ekycStatus, 'unverified');

  // Execute 5th pose -> completes verification!
  const fifthPose = challengePoses[4];
  const finalPoseRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId,
    mobileToken: ekycSessionToken,
    pose: fifthPose,
    frameBuf: makeValidPngBuffer({ width: 640, height: 800, seedByte: 0x29 })
  });
  assert.equal(finalPoseRes.status, 200);
  assert.equal(finalPoseRes.body.completed, true);
  assert.equal(finalPoseRes.body.session.status, 'COMPLETED');

  // Ideal API budget: 1 Spoof + 1 OCR + 5 Face Liveness = 7 calls, 0 Face Matching!
  assert.equal(ctx.mockProvider.calls.spoof.length, 1);
  assert.equal(ctx.mockProvider.calls.ocr.length, 1);
  assert.equal(ctx.mockProvider.calls.liveness.length, 5);
  assert.equal(ctx.mockProvider.calls.faceMatching.length, 0);

  // Verify User & IdentityProfile data contract
  const verifiedUser = await ctx.models.User.findById(user._id);
  assert.equal(verifiedUser.ekycStatus, 'verified');
  assert.equal(verifiedUser.verificationMethod, 'DOCUMENT_AND_LIVENESS');
  assert.equal(verifiedUser.livenessVerified, true);
  assert.equal(verifiedUser.trustScore, 70);
  assert.equal(getTrustLevelFromScore(verifiedUser.trustScore), 'medium');

  const profile = await ctx.models.IdentityProfile.findOne({ userId: user._id });
  assert.equal(profile.verificationMethod, 'DOCUMENT_AND_LIVENESS');
  assert.equal(profile.documentSpoofCheckPassed, true);
  assert.equal(profile.documentOcrPassed, true);
  assert.equal(profile.faceMatchingVerified, null);
  assert.equal(profile.livenessVerified, true);
  assert.equal(profile.cccdOwnershipVerified, false);
  for (const poseName of ALL_LIVENESS_POSES) {
    assert.equal(profile.livenessResults[poseName].passed, true);
    assert.equal(typeof profile.livenessResults[poseName].score, 'number');
  }

  // Desktop realtime sync updated to COMPLETED without leaking unmasked CCCD
  const realtimeDump = JSON.stringify(ctx.realtimeEvents);
  assert.ok(!realtimeDump.includes('079203001234'));
  const lastDesktopEvt = ctx.realtimeEvents[ctx.realtimeEvents.length - 1];
  assert.equal(lastDesktopEvt.payload.status, 'COMPLETED');
  assert.equal(lastDesktopEvt.payload.resultSummary.verificationMethod, 'DOCUMENT_AND_LIVENESS');
  assert.equal(lastDesktopEvt.payload.resultSummary.livenessVerified, true);
  assert.equal(lastDesktopEvt.payload.resultSummary.faceMatchingVerified, null);
});

// ============================================================================
// 2. Pose Order Enforcement, Anti-Replay Frame Guard, Single-Pose Retry (No Re-OCR),
//    and Continuity Timeout Reset
// ============================================================================
test('Enforces exact pose order, blocks frame replay, preserves passed poses when retrying a failed pose, and resets sequence on continuity loss', async (t) => {
  const nowRef = { current: new Date('2026-11-28T12:00:00Z') };
  const fixedSequence = ['Portrait', 'Right', 'Top', 'Left', 'Bottom'];
  const ctx = await setupTestServer({
    nowRef,
    challengeGenerator: () => [...fixedSequence]
  });
  t.after(() => ctx.close());

  const { token } = await ctx.createUserAndToken();
  const created = await (await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ initiationMode: 'DIRECT' })
  })).json();
  const sid = created.session.sessionId;
  const mToken = created.ekycSessionToken;

  await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sid}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': mToken },
    body: JSON.stringify({ accepted: true })
  });
  await postDocumentForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    frontBuf: makeValidPngBuffer({ seedByte: 0x31 }),
    backBuf: makeValidPngBuffer({ seedByte: 0x32 })
  });
  await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sid}/confirm-document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': mToken },
    body: JSON.stringify({ action: 'CONFIRM' })
  });

  // 1. Out-of-order pose submission ('Right' when 'Portrait' is expected) -> 409, 0 Liveness API calls!
  const wrongOrderRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Right',
    frameBuf: makeValidPngBuffer({ seedByte: 0x40 })
  });
  assert.equal(wrongOrderRes.status, 409);
  assert.equal(wrongOrderRes.body.code, 'INVALID_LIVENESS_POSE_ORDER');
  assert.equal(ctx.mockProvider.calls.liveness.length, 0);

  // 2. Wrong-case pose label ('portrait' instead of 'Portrait') -> 400
  const badCaseRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'portrait',
    frameBuf: makeValidPngBuffer({ seedByte: 0x40 })
  });
  assert.equal(badCaseRes.status, 400);
  assert.equal(badCaseRes.body.code, 'INVALID_LIVENESS_POSE');

  // 3. Pass Pose 1 ('Portrait')
  const frame1 = makeValidPngBuffer({ seedByte: 0x41 });
  const p1Res = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Portrait',
    frameBuf: frame1
  });
  assert.equal(p1Res.status, 200);
  assert.equal(p1Res.body.nextPose, 'Right');

  // 4. Replay exact same frame1 for Pose 2 ('Right') -> 400 DUPLICATE_LIVENESS_FRAME (0 extra provider calls!)
  const replayRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Right',
    frameBuf: frame1
  });
  assert.equal(replayRes.status, 400);
  assert.equal(replayRes.body.code, 'DUPLICATE_LIVENESS_FRAME');
  assert.equal(ctx.mockProvider.calls.liveness.length, 1);

  // 5. Pose 2 ('Right') fails Liveness -> keeps Pose 1 ('Portrait') passed and stays at index 1 ('Right') without re-OCR!
  ctx.mockProvider.setLivenessImpl(async () => ({
    passed: false,
    errorCode: 'LIVENESS_POSE_FAILED',
    isTechnicalError: false,
    clientHttpStatus: 422,
    providerCode: 400,
    httpStatus: 200,
    requestId: 'req-live-fail-right',
    score: 0.2,
    message: 'Chưa quay đúng hướng phải.'
  }));

  const failRight = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Right',
    frameBuf: makeValidPngBuffer({ seedByte: 0x42 })
  });
  assert.equal(failRight.status, 422);
  assert.equal(failRight.body.session.status, 'LIVENESS_RETRY_REQUIRED');
  assert.equal(failRight.body.session.livenessProgress.completedCount, 1);
  assert.equal(failRight.body.session.livenessProgress.currentPose, 'Right');
  assert.equal(ctx.mockProvider.calls.ocr.length, 1);

  // Restore passing provider and retry ONLY Pose 2 ('Right')
  ctx.mockProvider.setLivenessImpl(async ({ labelPose }) => ({
    passed: true,
    requestId: `req-live-ok-${labelPose}`,
    providerCode: 1,
    httpStatus: 200,
    durationMs: 30,
    score: 0.95
  }));

  const retryRight = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Right',
    frameBuf: makeValidPngBuffer({ seedByte: 0x43 })
  });
  assert.equal(retryRight.status, 200);
  assert.equal(retryRight.body.session.livenessProgress.completedCount, 2);
  assert.equal(retryRight.body.nextPose, 'Top');

  // 6. Continuity loss: user abandons phone for 4 minutes (> 180s continuity window) -> resets 5-pose sequence while keeping OCR!
  nowRef.current = new Date(nowRef.current.getTime() + 4 * 60 * 1000);
  const continuityLostRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Top',
    frameBuf: makeValidPngBuffer({ seedByte: 0x44 })
  });
  assert.equal(continuityLostRes.status, 409);
  assert.equal(continuityLostRes.body.code, 'LIVENESS_CONTINUITY_LOST');
  assert.equal(continuityLostRes.body.session.livenessProgress.completedCount, 0);
  assert.equal(continuityLostRes.body.session.livenessProgress.currentPose, 'Portrait');
  assert.equal(continuityLostRes.body.session.documentConfirmed, true);
  assert.equal(ctx.mockProvider.calls.ocr.length, 1);
});

// ============================================================================
// 3. Viettel AI Face Liveness Provider Contract, Fail-Closed `verify_result`,
//    Timeout, Quota, Session Expiry & Historical Face-Match Compatibility
// ============================================================================
test('Viettel AI face_liveness sends exact multipart parameters, enforces fail-closed verify_result, handles timeout/quota/expiry, and preserves historical DOCUMENT_AND_FACE_MATCH profiles', async (t) => {
  const captured = [];
  const fakeHttp = {
    async post(url, form, cfg) {
      captured.push({ url, rawBody: form.getBuffer().toString('latin1'), headers: cfg.headers });
      return {
        status: 200,
        headers: { request_id: 'hdr-live-99' },
        data: {
          code: 1,
          message: 'Success.',
          request_id: 'body-live-99',
          verify_result: 'SOME_UNCONFIRMED_STRING',
          score: 0.97
        }
      };
    }
  };

  // A. When VIETTEL_AI_LIVENESS_ACCEPTED_VALUES is empty, unconfirmed string `verify_result` MUST fail closed!
  const unconfirmedProvider = createViettelAiProvider({
    httpClient: fakeHttp,
    configGetter: () => ({
      viettelBaseUrl: 'https://viettelai.vn',
      viettelToken: 'secret-token',
      livenessAcceptedResults: [],
      livenessMinScore: null,
      livenessCookie: '',
      timeoutMs: 5000,
      maxImageBytes: 5 * 1024 * 1024
    })
  });

  const img = { buffer: makeValidPngBuffer({ seedByte: 0x55 }), mimeType: 'image/png', extension: 'png' };
  const failClosedRes = await unconfirmedProvider.checkFaceLiveness({
    image: img,
    labelPose: 'Left',
    sessionId: 's-contract'
  });
  assert.equal(failClosedRes.passed, false);
  assert.equal(failClosedRes.errorCode, 'UNCONFIRMED_LIVENESS_VERIFY_RESULT_LITERAL');
  assert.equal(failClosedRes.isTechnicalError, true);

  // Verify exact multipart parameters: file, token, label_pose=Left
  assert.ok(captured[0].url.endsWith('/ekyc/face_liveness'));
  assert.match(captured[0].rawBody, /name="file"/);
  assert.match(captured[0].rawBody, /name="token"/);
  assert.match(captured[0].rawBody, /name="label_pose"\r\n\r\nLeft/);

  // B. Once exact literal is confirmed in config, it passes cleanly!
  const confirmedProvider = createViettelAiProvider({
    httpClient: fakeHttp,
    configGetter: () => ({
      viettelBaseUrl: 'https://viettelai.vn',
      viettelToken: 'secret-token',
      livenessAcceptedResults: ['SOME_UNCONFIRMED_STRING'],
      livenessMinScore: 0.85,
      livenessCookie: '',
      timeoutMs: 5000,
      maxImageBytes: 5 * 1024 * 1024
    })
  });
  const confirmedRes = await confirmedProvider.checkFaceLiveness({
    image: img,
    labelPose: 'Bottom',
    sessionId: 's-contract'
  });
  assert.equal(confirmedRes.passed, true);
  assert.equal(confirmedRes.score, 0.97);
  assert.match(captured[1].rawBody, /name="label_pose"\r\n\r\nBottom/);

  // C. Timeout, Quota & Session Expiry resilience
  const nowRef = { current: new Date('2026-11-28T12:00:00Z') };
  const ctx = await setupTestServer({ nowRef });
  t.after(() => ctx.close());

  const { token } = await ctx.createUserAndToken();
  const created = await (await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ initiationMode: 'DIRECT' })
  })).json();
  const sid = created.session.sessionId;
  const mToken = created.ekycSessionToken;

  await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sid}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': mToken },
    body: JSON.stringify({ accepted: true })
  });
  await postDocumentForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    frontBuf: makeValidPngBuffer({ seedByte: 0x61 }),
    backBuf: makeValidPngBuffer({ seedByte: 0x62 })
  });
  await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${sid}/confirm-document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': mToken },
    body: JSON.stringify({ action: 'CONFIRM' })
  });

  // Timeout does NOT increment livenessRetries
  ctx.mockProvider.setLivenessImpl(async () => ({
    passed: false,
    errorCode: 'PROVIDER_TIMEOUT',
    isTechnicalError: true,
    clientHttpStatus: 504,
    message: 'Timeout'
  }));
  const tRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Portrait',
    frameBuf: makeValidPngBuffer({ seedByte: 0x63 })
  });
  assert.equal(tRes.status, 504);
  assert.equal(tRes.body.session.livenessRetries, 0);

  // Quota exceeded (403/429) -> 503, does NOT increment livenessRetries
  ctx.mockProvider.setLivenessImpl(async () => ({
    passed: false,
    errorCode: 'PROVIDER_QUOTA_OR_FORBIDDEN',
    isTechnicalError: true,
    clientHttpStatus: 503,
    message: 'Quota'
  }));
  const qRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Portrait',
    frameBuf: makeValidPngBuffer({ seedByte: 0x64 })
  });
  assert.equal(qRes.status, 503);
  assert.equal(qRes.body.session.livenessRetries, 0);

  // Session expiry (> 15m) -> 410 SESSION_EXPIRED
  nowRef.current = new Date(nowRef.current.getTime() + 20 * 60 * 1000);
  const expRes = await postLivenessForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: sid,
    mobileToken: mToken,
    pose: 'Portrait',
    frameBuf: makeValidPngBuffer({ seedByte: 0x65 })
  });
  assert.equal(expRes.status, 410);
  assert.equal(expRes.body.code, 'SESSION_EXPIRED');

  // D. Historical DOCUMENT_AND_FACE_MATCH account remains intact & accurately reported
  const legacy = await ctx.createUserAndToken({
    email: 'historical@example.com',
    ekycStatus: 'verified',
    verificationMethod: 'DOCUMENT_AND_FACE_MATCH',
    livenessVerified: false,
    ekycVerifiedAt: new Date('2026-11-01T00:00:00Z')
  });
  await ctx.models.IdentityProfile.create({
    userId: legacy.user._id,
    isActive: true,
    idNumberHmac: 'legacy-hmac-001',
    idNumberEncrypted: 'v1:00:00:00',
    idNumberMasked: '********9999',
    fullName: 'LÊ LỊCH SỬ',
    verificationMethod: 'DOCUMENT_AND_FACE_MATCH',
    spoofCheckPassed: true,
    faceMatchVerified: true,
    faceMatchScore: 0.94,
    livenessVerified: false,
    verifiedAt: new Date('2026-11-01T00:00:00Z')
  });

  const histStatusRes = await ctx.request(`${ctx.baseUrl}/api/ekyc/status`, {
    headers: { Authorization: `Bearer ${legacy.token}` }
  });
  assert.equal(histStatusRes.status, 200);
  const histStatus = await histStatusRes.json();
  assert.equal(histStatus.verificationMethod, 'DOCUMENT_AND_FACE_MATCH');
  assert.equal(histStatus.faceMatchingVerified, true);
  assert.equal(histStatus.livenessVerified, false);
});

// ============================================================================
// 4. QR Security, Spoof/OCR Validation & Local QR Matrix Generator
// ============================================================================
test('Preserves QR single-use atomic claim, IDOR protection, Spoof->OCR stop rule, duplicate CCCD block, and ISO QR generator', async (t) => {
  const ctx = await setupTestServer();
  t.after(() => ctx.close());

  const userA = await ctx.createUserAndToken({ email: 'qa@example.com' });
  const userB = await ctx.createUserAndToken({ email: 'qb@example.com' });

  const createQr = await (await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userA.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ initiationMode: 'QR' })
  })).json();
  const qrTok = ctx.extractTokenFromQrUrl(createQr.qrUrl);

  const [c1, c2] = await Promise.all([
    ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: qrTok })
    }),
    ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: qrTok })
    })
  ]);
  assert.deepEqual([c1.status, c2.status].sort((a, b) => a - b), [200, 409]);

  // IDOR check
  const idor = await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${createQr.session.sessionId}`, {
    headers: { Authorization: `Bearer ${userB.token}` }
  });
  assert.equal(idor.status, 403);

  // Spoof failure stops before OCR
  const winner = c1.status === 200 ? await c1.json() : await c2.json();
  await ctx.request(`${ctx.baseUrl}/api/ekyc/sessions/${winner.sessionId}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ekyc-Session-Token': winner.ekycSessionToken },
    body: JSON.stringify({ accepted: true })
  });
  ctx.mockProvider.setSpoofImpl(async () => ({
    passed: false,
    errorCode: 'SPOOF_PHOTOCOPY',
    isTechnicalError: false,
    clientHttpStatus: 422,
    providerCode: 267,
    httpStatus: 200,
    message: 'Bản photocopy'
  }));
  const spoofFail = await postDocumentForm({
    request: ctx.request,
    baseUrl: ctx.baseUrl,
    sessionId: winner.sessionId,
    mobileToken: winner.ekycSessionToken,
    frontBuf: makeValidPngBuffer({ seedByte: 0x71 }),
    backBuf: makeValidPngBuffer({ seedByte: 0x72 })
  });
  assert.equal(spoofFail.status, 422);
  assert.equal(ctx.mockProvider.calls.ocr.length, 0);

  // QR matrix verification
  const qrModuleUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'qrCode.js')
  ).href;
  const { encodeQrMatrix, buildQrSvgPath } = await import(qrModuleUrl);
  const qr = encodeQrMatrix(createQr.qrUrl);
  assert.equal(qr.size, qr.version * 4 + 17);
  assert.ok(buildQrSvgPath(qr.modules, 4).startsWith('M'));
});
