// frontend/src/utils/ekycSessionStorage.js

const TOKEN_PREFIX = 'rentalp2p_ekyc_session_token:';
const LAST_SESSION_KEY = 'rentalp2p_ekyc_active_sid';

export function saveEkycMobileCredential(sessionId, token) {
  if (!sessionId || !token) return;
  try {
    sessionStorage.setItem(`${TOKEN_PREFIX}${sessionId}`, token);
    sessionStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // Ignore storage quota errors in restricted webviews
  }
}

export function loadEkycMobileCredential(sessionId) {
  try {
    const resolvedId = sessionId || sessionStorage.getItem(LAST_SESSION_KEY) || '';
    if (!resolvedId) return { sessionId: '', token: '' };
    const token = sessionStorage.getItem(`${TOKEN_PREFIX}${resolvedId}`) || '';
    return { sessionId: resolvedId, token };
  } catch {
    return { sessionId: sessionId || '', token: '' };
  }
}

export function clearEkycMobileCredential(sessionId) {
  try {
    if (sessionId) {
      sessionStorage.removeItem(`${TOKEN_PREFIX}${sessionId}`);
    }
    const lastId = sessionStorage.getItem(LAST_SESSION_KEY);
    if (!sessionId || lastId === sessionId) {
      sessionStorage.removeItem(LAST_SESSION_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function isMobileBrowserDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) {
    return true;
  }
  if (typeof window !== 'undefined' && navigator.maxTouchPoints > 1 && window.innerWidth <= 900) {
    return true;
  }
  return false;
}
