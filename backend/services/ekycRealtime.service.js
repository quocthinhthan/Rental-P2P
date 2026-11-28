// backend/services/ekycRealtime.service.js

let ioInstance = null;

const getEkycRoomName = (sessionId) => `ekyc_session:${String(sessionId)}`;

const setEkycSocketServer = (io) => {
  ioInstance = io;
};

/**
 * Emits sanitized session progress to the authenticated Desktop owner room.
 * Must NEVER include raw OCR fields, unmasked ID numbers, tokens, or images.
 */
const emitEkycSessionUpdate = (sessionId, desktopSafePayload) => {
  if (!ioInstance || !sessionId || !desktopSafePayload) return;
  ioInstance.to(getEkycRoomName(sessionId)).emit('ekyc_session_updated', desktopSafePayload);
};

module.exports = {
  getEkycRoomName,
  setEkycSocketServer,
  emitEkycSessionUpdate
};
