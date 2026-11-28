// backend/routes/ekyc.routes.js
const express = require('express');
const { protect } = require('../middleware/auth.middleware');
const {
  protectEkycMobileSession,
  protectEkycOwnerOrMobile
} = require('../middleware/ekycAuth.middleware');
const {
  uploadEkycDocuments,
  uploadEkycLiveness
} = require('../middleware/ekycUpload.middleware');
const {
  ekycSessionLimiter,
  ekycClaimLimiter,
  ekycSubmitLimiter
} = require('../middleware/rateLimit.middleware');
const defaultEkycController = require('../controllers/ekyc.controller');

const noStoreHeaders = (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Referrer-Policy', 'no-referrer');
  next();
};

const createEkycRouter = ({
  controller = defaultEkycController,
  protectUser = protect,
  protectMobile = protectEkycMobileSession,
  protectOwnerOrMobile = protectEkycOwnerOrMobile,
  enableRateLimit = true
} = {}) => {
  const router = express.Router();
  const maybeLimit = (limiter) => (enableRateLimit && limiter ? limiter : (req, res, next) => next());

  router.use(noStoreHeaders);

  // Account verification summary (reusable by Web & future Mobile App)
  router.get('/status', protectUser, controller.getEkycStatus);

  // Create verification session (QR for Desktop or DIRECT for Mobile)
  router.post('/sessions', maybeLimit(ekycSessionLimiter), protectUser, controller.createVerificationSession);

  // Claim QR handoff token on Mobile browser (single-use atomic exchange)
  router.post('/sessions/claim', maybeLimit(ekycClaimLimiter), controller.claimVerificationSession);

  // Read session state (Desktop owner via Bearer OR Mobile session via X-Ekyc-Session-Token)
  router.get('/sessions/:sessionId', protectOwnerOrMobile, controller.getVerificationSession);

  // Step 1: Personal data processing consent
  router.post('/sessions/:sessionId/consent', protectMobile, controller.submitConsent);

  // Step 2-4: Upload front + back CCCD -> ID Pack Spoof Check -> Document OCR
  router.post(
    '/sessions/:sessionId/documents',
    maybeLimit(ekycSubmitLimiter),
    protectMobile,
    uploadEkycDocuments,
    controller.submitDocuments
  );

  // Step 5: Confirm read-only OCR fields or request retake
  router.post('/sessions/:sessionId/confirm-document', protectMobile, controller.confirmDocument);

  // Step 6-7: Full 5-pose Face Liveness Detection (Portrait + 4 randomized directional poses)
  router.post(
    '/sessions/:sessionId/liveness',
    maybeLimit(ekycSubmitLimiter),
    protectMobile,
    uploadEkycLiveness,
    controller.submitLivenessPose
  );

  // Deprecated Face Matching route (explicitly disabled in the Full Liveness workflow)
  router.post('/sessions/:sessionId/face', protectMobile, controller.deprecatedFaceMatching);

  // Cancel active verification session
  router.post('/sessions/:sessionId/cancel', protectOwnerOrMobile, controller.cancelVerificationSession);

  return router;
};

const router = createEkycRouter();
router.createEkycRouter = createEkycRouter;

module.exports = router;
