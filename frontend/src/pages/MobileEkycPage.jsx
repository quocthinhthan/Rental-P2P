import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiService from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import {
  saveEkycMobileCredential,
  loadEkycMobileCredential,
  clearEkycMobileCredential,
} from '../utils/ekycSessionStorage';
import '../styles/Ekyc.css';

const STEP = Object.freeze({
  CONSENT: 1,
  FRONT_CAPTURE: 2,
  BACK_CAPTURE: 3,
  DOCUMENT_CHECKING: 4,
  OCR_CONFIRM: 5,
  LIVENESS_CAPTURE: 6,
  RESULT: 7,
});

const STEP_TITLES = Object.freeze({
  [STEP.CONSENT]: 'Giới thiệu & Đồng ý xử lý dữ liệu',
  [STEP.FRONT_CAPTURE]: 'Chụp CCCD mặt trước',
  [STEP.BACK_CAPTURE]: 'Chụp CCCD mặt sau',
  [STEP.DOCUMENT_CHECKING]: 'Kiểm tra giấy tờ tùy thân',
  [STEP.OCR_CONFIRM]: 'Xác nhận thông tin CCCD',
  [STEP.LIVENESS_CAPTURE]: 'Thực thể sống (5 tư thế)',
  [STEP.RESULT]: 'Kết quả xác minh',
});

const POSE_UI_META = Object.freeze({
  Portrait: {
    shortLabel: 'Nhìn thẳng',
    title: 'Nhìn thẳng vào camera',
    hint: 'Giữ đầu thẳng tự nhiên, đặt toàn bộ khuôn mặt nằm gọn giữa khung oval.',
    arrowIcon: null,
    arrowPosition: '',
  },
  Left: {
    shortLabel: 'Quay trái',
    title: 'Quay đầu sang trái',
    hint: 'Từ từ xoay mặt sang phía bên trái của bạn khoảng 25–35° và giữ yên khi chụp.',
    arrowIcon: 'fa-arrow-left',
    arrowPosition: 'left',
  },
  Right: {
    shortLabel: 'Quay phải',
    title: 'Quay đầu sang phải',
    hint: 'Từ từ xoay mặt sang phía bên phải của bạn khoảng 25–35° và giữ yên khi chụp.',
    arrowIcon: 'fa-arrow-right',
    arrowPosition: 'right',
  },
  Top: {
    shortLabel: 'Ngẩng lên',
    title: 'Ngẩng đầu lên',
    hint: 'Hơi ngẩng nhẹ cằm hướng lên trên (vẫn giữ khuôn mặt nằm trong khung oval).',
    arrowIcon: 'fa-arrow-up',
    arrowPosition: 'top',
  },
  Bottom: {
    shortLabel: 'Cúi xuống',
    title: 'Cúi đầu xuống',
    hint: 'Hơi cúi nhẹ đầu hướng xuống dưới (vẫn nhìn thấy rõ khuôn mặt trong khung oval).',
    arrowIcon: 'fa-arrow-down',
    arrowPosition: 'bottom',
  },
});

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED']);

// Configurable horizontal flip for Liveness frames if provider calibration requires mirrored selfie coordinates
const MIRROR_LIVENESS_CAPTURE = import.meta.env.REACT_APP_EKYC_MIRROR_LIVENESS === 'true';

let recentBootstrapHandoff = { token: '', timestamp: 0 };
const inFlightClaimMap = new Map();

const claimHandoffTokenOnce = (rawToken) => {
  if (inFlightClaimMap.has(rawToken)) {
    return inFlightClaimMap.get(rawToken);
  }

  const promise = apiService
    .claimEkycSession(rawToken)
    .then((claimRes) => {
      const claimedSid = claimRes.data.sessionId;
      const mobileTok = claimRes.data.ekycSessionToken;
      const mobileSession = claimRes.data.session;

      saveEkycMobileCredential(claimedSid, mobileTok);
      window.history.replaceState(
        {},
        document.title,
        `/verify-identity?sessionId=${encodeURIComponent(claimedSid)}`
      );

      return { claimedSid, mobileTok, mobileSession };
    })
    .finally(() => {
      window.setTimeout(() => {
        inFlightClaimMap.delete(rawToken);
        if (recentBootstrapHandoff.token === rawToken) {
          recentBootstrapHandoff = { token: '', timestamp: 0 };
        }
      }, 5000);
    });

  inFlightClaimMap.set(rawToken, promise);
  return promise;
};

const formatCountdown = (seconds) => {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = String(Math.floor(clamped / 60)).padStart(2, '0');
  const secs = String(clamped % 60).padStart(2, '0');
  return `${mins}:${secs}`;
};

const deriveStepFromBackendSession = (sessionData) => {
  if (!sessionData) return STEP.CONSENT;

  if (TERMINAL_STATUSES.has(sessionData.status)) {
    return STEP.RESULT;
  }

  switch (sessionData.status) {
    case 'CREATED':
    case 'CLAIMED':
      return STEP.CONSENT;
    case 'CONSENT_ACCEPTED':
      return STEP.FRONT_CAPTURE;
    case 'DOCUMENT_PROCESSING':
      return STEP.DOCUMENT_CHECKING;
    case 'DOCUMENT_RETRY_REQUIRED':
      return STEP.RESULT;
    case 'DOCUMENT_VERIFIED':
      return STEP.OCR_CONFIRM;
    case 'DOCUMENT_CONFIRMED':
    case 'LIVENESS_IN_PROGRESS':
    case 'LIVENESS_PROCESSING':
    case 'LIVENESS_RETRY_REQUIRED':
      return STEP.LIVENESS_CAPTURE;
    default:
      return STEP.CONSENT;
  }
};

const revokeObjectUrlSafely = (url) => {
  if (url && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
};

const captureVideoFrameToJpegBlob = (
  videoEl,
  { maxDimension = 2400, quality = 0.92, mirrorHorizontal = false } = {}
) =>
  new Promise((resolve, reject) => {
    const rawW = videoEl?.videoWidth || 0;
    const rawH = videoEl?.videoHeight || 0;
    if (!rawW || !rawH) {
      reject(new Error('Camera chưa sẵn sàng khung hình. Vui lòng đợi 1 giây rồi chụp lại.'));
      return;
    }

    const scale = Math.min(1, maxDimension / Math.max(rawW, rawH));
    const width = Math.max(320, Math.round(rawW * scale));
    const height = Math.max(240, Math.round(rawH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Trình duyệt không hỗ trợ xử lý khung hình camera.'));
      return;
    }

    if (mirrorHorizontal) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(videoEl, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Không thể chụp ảnh từ camera. Vui lòng thử lại.'));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      quality
    );
  });

const scoreRearCameraCandidate = (device, index) => {
  const label = (device.label || '').toLowerCase();
  let score = 0;

  if (/ultra|wide-angle|0\.5|0,5|macro|depth|fisheye|tele/i.test(label)) {
    score -= 100;
  }
  if (/camera2?\s*0\b/.test(label)) {
    score += 80;
  }
  if (/main|chính|standard|1x/i.test(label)) {
    score += 40;
  }

  score -= index * 5;
  return score;
};

const applyBestTrackFocusAndZoom = async (stream, desiredZoom = null) => {
  const track = stream?.getVideoTracks?.()?.[0];
  if (!track || typeof track.getCapabilities !== 'function') {
    return { supportedZoom: false, min: 1, max: 1, current: 1 };
  }

  let caps = {};
  try {
    caps = track.getCapabilities() || {};
  } catch {
    return { supportedZoom: false, min: 1, max: 1, current: 1 };
  }

  const advanced = {};
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    advanced.focusMode = 'continuous';
  }
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
    advanced.exposureMode = 'continuous';
  }
  if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) {
    advanced.whiteBalanceMode = 'continuous';
  }

  let zoomInfo = { supportedZoom: false, min: 1, max: 1, current: 1 };
  if (caps.zoom && typeof caps.zoom.min === 'number' && typeof caps.zoom.max === 'number' && caps.zoom.max > 1.1) {
    const minZ = Math.max(1, caps.zoom.min);
    const maxZ = caps.zoom.max;
    const targetZ = desiredZoom !== null
      ? Math.min(maxZ, Math.max(minZ, desiredZoom))
      : Math.min(maxZ, Math.max(minZ, 1));
    advanced.zoom = targetZ;
    zoomInfo = { supportedZoom: true, min: minZ, max: maxZ, current: targetZ };
  }

  if (Object.keys(advanced).length > 0 && typeof track.applyConstraints === 'function') {
    try {
      await track.applyConstraints({ advanced: [advanced] });
    } catch {
      // ignore unsupported advanced constraints
    }
  }

  return zoomInfo;
};

function PoseIllustration({ pose }) {
  const offsetMap = {
    Portrait: { cx: 28, cy: 26, noseX: 28, noseY: 27 },
    Left: { cx: 24, cy: 26, noseX: 19, noseY: 27 },
    Right: { cx: 32, cy: 26, noseX: 37, noseY: 27 },
    Top: { cx: 28, cy: 23, noseX: 28, noseY: 19 },
    Bottom: { cx: 28, cy: 30, noseX: 28, noseY: 34 },
  };
  const cfg = offsetMap[pose] || offsetMap.Portrait;

  return (
    <div className="mekyc-pose-illus" aria-hidden="true">
      <svg width="46" height="46" viewBox="0 0 56 56" fill="none">
        <ellipse cx="28" cy="28" rx="22" ry="25" stroke="#93c5fd" strokeWidth="2" strokeDasharray="4 3" />
        <ellipse cx={cfg.cx} cy={cfg.cy} rx="11" ry="14" fill="#dbeafe" stroke="#2563eb" strokeWidth="2" />
        <circle cx={cfg.noseX - 4} cy={cfg.noseY - 3} r="1.6" fill="#1e40af" />
        <circle cx={cfg.noseX + 4} cy={cfg.noseY - 3} r="1.6" fill="#1e40af" />
        <path
          d={`M${cfg.noseX} ${cfg.noseY - 1} L${cfg.noseX} ${cfg.noseY + 3}`}
          stroke="#1d4ed8"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d={`M${cfg.noseX - 4} ${cfg.noseY + 6} Q${cfg.noseX} ${cfg.noseY + 8.5} ${cfg.noseX + 4} ${cfg.noseY + 6}`}
          stroke="#1d4ed8"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

export default function MobileEkycPage() {
  const navigate = useNavigate();
  const { isLoggedIn, updateUser } = useAuth();

  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(null);

  const [sessionId, setSessionId] = useState('');
  const [ekycToken, setEkycToken] = useState('');
  const [session, setSession] = useState(null);
  const [uiStep, setUiStep] = useState(STEP.CONSENT);

  const [consentChecked, setConsentChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stepError, setStepError] = useState('');
  const [poseSuccessToast, setPoseSuccessToast] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  // In-memory transient CCCD capture blobs (never persisted in browser storage)
  const [frontBlob, setFrontBlob] = useState(null);
  const [frontPreviewUrl, setFrontPreviewUrl] = useState('');
  const [backBlob, setBackBlob] = useState(null);
  const [backPreviewUrl, setBackPreviewUrl] = useState('');

  // Camera state
  const videoRef = useRef(null);
  const activeStreamRef = useRef(null);
  const [cameraStatus, setCameraStatus] = useState('IDLE'); // IDLE | STARTING | READY | DENIED | NO_CAMERA | UNSUPPORTED
  const [cameraErrorMsg, setCameraErrorMsg] = useState('');
  const [cameraRetryNonce, setCameraRetryNonce] = useState(0);
  const [rearCameras, setRearCameras] = useState([]);
  const [selectedRearDeviceId, setSelectedRearDeviceId] = useState('');
  const [zoomState, setZoomState] = useState({ supportedZoom: false, min: 1, max: 1, current: 1 });

  const stopCameraStream = useCallback(() => {
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      activeStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraStatus('IDLE');
  }, []);

  const clearDocumentBlobs = useCallback(() => {
    setFrontBlob(null);
    setFrontPreviewUrl((prev) => {
      revokeObjectUrlSafely(prev);
      return '';
    });
    setBackBlob(null);
    setBackPreviewUrl((prev) => {
      revokeObjectUrlSafely(prev);
      return '';
    });
  }, []);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);

    return () => {
      stopCameraStream();
      if (meta.parentNode) {
        meta.parentNode.removeChild(meta);
      }
    };
  }, [stopCameraStream]);

  useEffect(() => () => {
    revokeObjectUrlSafely(frontPreviewUrl);
    revokeObjectUrlSafely(backPreviewUrl);
  }, [frontPreviewUrl, backPreviewUrl]);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Bootstrap: Claim QR token OR recover active session on page refresh
  useEffect(() => {
    let mounted = true;

    const initSession = async () => {
      setBootstrapping(true);
      setBootstrapError(null);

      const searchParams = new URLSearchParams(window.location.search);
      const urlToken = searchParams.get('token') || '';
      const querySessionId = searchParams.get('sessionId') || '';

      let effectiveToken = urlToken;
      if (urlToken) {
        recentBootstrapHandoff = { token: urlToken, timestamp: Date.now() };
        window.history.replaceState({}, document.title, '/verify-identity');
      } else if (
        recentBootstrapHandoff.token
        && Date.now() - recentBootstrapHandoff.timestamp < 3000
      ) {
        effectiveToken = recentBootstrapHandoff.token;
      }

      try {
        if (effectiveToken) {
          const { claimedSid, mobileTok, mobileSession } = await claimHandoffTokenOnce(effectiveToken);
          if (!mounted) return;

          setSessionId(claimedSid);
          setEkycToken(mobileTok);
          setSession(mobileSession);
          setUiStep(deriveStepFromBackendSession(mobileSession));
          return;
        }

        const stored = loadEkycMobileCredential(querySessionId);
        if (!stored.sessionId || !stored.token) {
          setBootstrapError({
            title: 'Không tìm thấy phiên xác minh hợp lệ',
            message:
              'Vui lòng dùng điện thoại quét mã QR mới nhất từ trang Tài khoản trên máy tính, hoặc bắt đầu xác minh từ mục Tài khoản.',
          });
          return;
        }

        const recoverRes = await apiService.getEkycSessionMobile(stored.sessionId, stored.token);
        if (!mounted) return;
        const recoveredSession = recoverRes.data?.session;
        setSessionId(stored.sessionId);
        setEkycToken(stored.token);
        setSession(recoveredSession);
        if (recoveredSession?.status === 'LIVENESS_RETRY_REQUIRED' && recoveredSession.failureReason) {
          setStepError(recoveredSession.failureReason);
        }
        setUiStep(deriveStepFromBackendSession(recoveredSession));
      } catch (err) {
        if (!mounted) return;
        const code = err.response?.data?.code || '';
        const msg =
          err.response?.data?.message
          || 'Liên kết xác minh không hợp lệ hoặc đã hết hạn. Vui lòng tạo lại mã QR mới.';

        if (code === 'SESSION_EXPIRED' || code === 'SESSION_CANCELLED') {
          clearEkycMobileCredential(querySessionId);
        }

        setBootstrapError({
          title:
            code === 'HANDOFF_TOKEN_ALREADY_USED'
              ? 'Mã QR đã được sử dụng'
              : code === 'SESSION_EXPIRED'
                ? 'Phiên xác minh đã hết hạn'
                : code === 'SESSION_CANCELLED'
                  ? 'Phiên xác minh đã bị hủy'
                  : 'Không thể kết nối phiên xác minh',
          message: msg,
        });
      } finally {
        if (mounted) setBootstrapping(false);
      }
    };

    initSession();
    return () => {
      mounted = false;
    };
  }, []);

  // Session expiration countdown
  useEffect(() => {
    if (!session?.expiresAt || TERMINAL_STATUSES.has(session?.status)) {
      setRemainingSeconds(0);
      return undefined;
    }

    const tick = () => {
      const diff = Math.max(
        0,
        Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
      );
      setRemainingSeconds(diff);

      if (diff <= 0 && !TERMINAL_STATUSES.has(session.status)) {
        stopCameraStream();
        clearDocumentBlobs();
        setSession((prev) =>
          prev
            ? {
                ...prev,
                status: 'EXPIRED',
                failureCode: 'SESSION_EXPIRED',
                failureReason: 'Phiên xác minh đã hết hạn. Vui lòng tạo lại phiên mới trên thiết bị gốc.',
              }
            : prev
        );
        setUiStep(STEP.RESULT);
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [session?.expiresAt, session?.status, stopCameraStream, clearDocumentBlobs]);

  // Periodic lightweight check so Desktop cancellation immediately reflects on Mobile
  useEffect(() => {
    if (!sessionId || !ekycToken || !session || TERMINAL_STATUSES.has(session.status) || submitting) {
      return undefined;
    }

    const checkRemoteCancel = async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        const res = await apiService.getEkycSessionMobile(sessionId, ekycToken);
        const remote = res.data?.session;
        if (remote && TERMINAL_STATUSES.has(remote.status)) {
          stopCameraStream();
          clearDocumentBlobs();
          setSession(remote);
          setUiStep(STEP.RESULT);
        }
      } catch (err) {
        if (err.response?.data?.code === 'SESSION_CANCELLED') {
          stopCameraStream();
          clearDocumentBlobs();
          setSession((prev) => ({
            ...(prev || {}),
            status: 'CANCELLED',
            failureCode: 'SESSION_CANCELLED',
            failureReason: 'Phiên xác minh đã bị hủy từ thiết bị gốc.',
          }));
          setUiStep(STEP.RESULT);
        }
      }
    };

    const interval = window.setInterval(checkRemoteCancel, 6000);
    return () => window.clearInterval(interval);
  }, [sessionId, ekycToken, session, submitting, stopCameraStream, clearDocumentBlobs]);

  // Camera lifecycle controller:
  // - Rear camera runs when capturing CCCD Front/Back (and stops on preview).
  // - Front camera stays CONTINUOUSLY active across all 5 Liveness poses until completed/cancelled/expired!
  const needsRearCamera =
    (uiStep === STEP.FRONT_CAPTURE && !frontBlob)
    || (uiStep === STEP.BACK_CAPTURE && !backBlob);
  const needsFrontCamera = uiStep === STEP.LIVENESS_CAPTURE;
  const shouldRunCamera = needsRearCamera || needsFrontCamera;
  const preferredFacingMode = needsFrontCamera ? 'user' : 'environment';

  useEffect(() => {
    if (!shouldRunCamera) {
      stopCameraStream();
      return undefined;
    }

    let cancelled = false;

    const startCamera = async () => {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setCameraStatus('UNSUPPORTED');
        setCameraErrorMsg(
          'Trình duyệt yêu cầu kết nối bảo mật (HTTPS hoặc localhost) để mở camera trực tiếp.'
        );
        return;
      }

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setCameraStatus('UNSUPPORTED');
        setCameraErrorMsg('Trình duyệt trên thiết bị này không hỗ trợ truy cập camera trực tiếp.');
        return;
      }

      setCameraStatus('STARTING');
      setCameraErrorMsg('');

      const videoConstraint = !needsFrontCamera && selectedRearDeviceId
        ? {
            deviceId: { exact: selectedRearDeviceId },
            width: { ideal: 2560 },
            height: { ideal: 1920 },
          }
        : {
            facingMode: needsFrontCamera ? { ideal: 'user' } : { ideal: 'environment' },
            width: { ideal: needsFrontCamera ? 1280 : 2560 },
            height: { ideal: needsFrontCamera ? 960 : 1920 },
          };

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraint,
        });
      } catch (primaryErr) {
        const errName = primaryErr?.name || '';
        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
          if (!cancelled) {
            setCameraStatus('DENIED');
            setCameraErrorMsg(
              'Bạn đã từ chối quyền truy cập camera. Vui lòng cấp quyền Camera trong cài đặt trình duyệt rồi nhấn "Thử mở lại camera".'
            );
          }
          return;
        }

        if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
          if (!cancelled) {
            setCameraStatus('NO_CAMERA');
            setCameraErrorMsg('Không tìm thấy phần cứng camera trên thiết bị hiện tại.');
          }
          return;
        }

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: needsFrontCamera ? { facingMode: 'user' } : true,
            audio: false,
          });
        } catch (fallbackErr) {
          if (!cancelled) {
            const fbName = fallbackErr?.name || '';
            if (fbName === 'NotAllowedError' || fbName === 'PermissionDeniedError') {
              setCameraStatus('DENIED');
              setCameraErrorMsg(
                'Quyền truy cập camera bị chặn. Vui lòng bật quyền Camera cho trang web trong cài đặt trình duyệt.'
              );
            } else {
              setCameraStatus('NO_CAMERA');
              setCameraErrorMsg(
                'Không thể khởi động camera (có thể camera đang được sử dụng bởi ứng dụng khác).'
              );
            }
          }
          return;
        }
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      // Select primary 1x autofocus rear sensor automatically (avoid 0.5x ultra-wide on multi-camera phones)
      if (!needsFrontCamera && typeof navigator.mediaDevices.enumerateDevices === 'function') {
        try {
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = allDevices.filter((d) => d.kind === 'videoinput');
          const backCandidates = videoInputs.filter(
            (d) => !/front|trước|user|selfie|facetime/i.test(d.label || '')
          );
          const candidatePool = backCandidates.length > 0 ? backCandidates : videoInputs;

          if (!cancelled) {
            setRearCameras(candidatePool);
          }

          if (!selectedRearDeviceId && candidatePool.length > 1) {
            const ranked = candidatePool
              .map((dev, idx) => ({ dev, score: scoreRearCameraCandidate(dev, idx) }))
              .sort((a, b) => b.score - a.score);

            const bestMainRear = ranked[0]?.dev;
            const currentTrackSettings = stream.getVideoTracks?.()?.[0]?.getSettings?.() || {};

            if (
              bestMainRear?.deviceId
              && currentTrackSettings.deviceId
              && bestMainRear.deviceId !== currentTrackSettings.deviceId
            ) {
              try {
                const betterStream = await navigator.mediaDevices.getUserMedia({
                  audio: false,
                  video: {
                    deviceId: { exact: bestMainRear.deviceId },
                    width: { ideal: 2560 },
                    height: { ideal: 1920 },
                  },
                });
                stream.getTracks().forEach((t) => t.stop());
                stream = betterStream;
                if (!cancelled) {
                  setSelectedRearDeviceId(bestMainRear.deviceId);
                }
              } catch {
                // keep initial stream
              }
            } else if (bestMainRear?.deviceId && !cancelled) {
              setSelectedRearDeviceId(bestMainRear.deviceId);
            }
          }
        } catch {
          // ignore
        }
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const detectedZoom = await applyBestTrackFocusAndZoom(stream);
      if (!cancelled) {
        setZoomState(detectedZoom);
      }

      activeStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {
          // autoPlay handles playback
        }
      }
      setCameraStatus('READY');
    };

    startCamera();

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopCameraStream();
      } else if (document.visibilityState === 'visible') {
        setCameraRetryNonce((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      stopCameraStream();
    };
  }, [shouldRunCamera, preferredFacingMode, needsFrontCamera, selectedRearDeviceId, cameraRetryNonce, stopCameraStream]);

  const handleSwitchRearLens = () => {
    if (rearCameras.length <= 1) return;
    const currentIdx = rearCameras.findIndex((d) => d.deviceId === selectedRearDeviceId);
    const nextIdx = (currentIdx + 1) % rearCameras.length;
    setSelectedRearDeviceId(rearCameras[nextIdx].deviceId);
  };

  const handleChangeZoom = async (targetZoom) => {
    if (!activeStreamRef.current) return;
    const updatedZoom = await applyBestTrackFocusAndZoom(activeStreamRef.current, targetZoom);
    setZoomState(updatedZoom);
  };

  const handleTapRefocus = async () => {
    const track = activeStreamRef.current?.getVideoTracks?.()?.[0];
    if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') {
      return;
    }
    try {
      const caps = track.getCapabilities() || {};
      if (Array.isArray(caps.focusMode)) {
        if (caps.focusMode.includes('single-shot')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
        }
        if (caps.focusMode.includes('continuous')) {
          window.setTimeout(() => {
            track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
          }, 350);
        }
      }
    } catch {
      // ignore
    }
  };

  // ── Step Handlers ──

  const handleAcceptConsent = async () => {
    if (!consentChecked || submitting) return;
    setSubmitting(true);
    setStepError('');

    try {
      const res = await apiService.submitEkycConsent(sessionId, true, ekycToken);
      const updated = res.data?.session;
      setSession(updated);
      setUiStep(STEP.FRONT_CAPTURE);
    } catch (err) {
      setStepError(err.response?.data?.message || 'Không thể xác nhận đồng ý điều khoản.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCaptureDocumentPhoto = async (target) => {
    setStepError('');
    try {
      const blob = await captureVideoFrameToJpegBlob(videoRef.current, {
        maxDimension: 2400,
        quality: 0.92,
        mirrorHorizontal: false,
      });
      stopCameraStream();
      const preview = URL.createObjectURL(blob);

      if (target === 'FRONT') {
        setFrontPreviewUrl((prev) => {
          revokeObjectUrlSafely(prev);
          return preview;
        });
        setFrontBlob(blob);
      } else if (target === 'BACK') {
        setBackPreviewUrl((prev) => {
          revokeObjectUrlSafely(prev);
          return preview;
        });
        setBackBlob(blob);
      }
    } catch (err) {
      setStepError(err.message || 'Không thể chụp ảnh. Vui lòng thử lại.');
    }
  };

  // Fallback native camera file input ONLY for CCCD document steps when WebRTC is unavailable.
  // Never allowed for Liveness Detection (§5: no face image file upload).
  const handleFallbackDocumentFile = (event, target) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setStepError('');
    const preview = URL.createObjectURL(file);
    if (target === 'FRONT') {
      setFrontPreviewUrl((prev) => {
        revokeObjectUrlSafely(prev);
        return preview;
      });
      setFrontBlob(file);
    } else if (target === 'BACK') {
      setBackPreviewUrl((prev) => {
        revokeObjectUrlSafely(prev);
        return preview;
      });
      setBackBlob(file);
    }
  };

  const handleSubmitDocuments = async () => {
    if (!frontBlob || !backBlob || submitting) return;
    setSubmitting(true);
    setStepError('');
    setUiStep(STEP.DOCUMENT_CHECKING);

    try {
      const res = await apiService.submitEkycDocuments(sessionId, frontBlob, backBlob, ekycToken);
      const updated = res.data?.session;
      clearDocumentBlobs();
      setSession(updated);
      setUiStep(STEP.OCR_CONFIRM);
    } catch (err) {
      clearDocumentBlobs();
      const errSession = err.response?.data?.session;
      const errMsg =
        err.response?.data?.message
        || 'Không thể kiểm tra giấy tờ tùy thân. Vui lòng kiểm tra ảnh chụp và thử lại.';

      if (errSession) {
        setSession(errSession);
        setUiStep(STEP.RESULT);
      } else {
        setStepError(errMsg);
        setUiStep(STEP.FRONT_CAPTURE);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmOcr = async (action) => {
    if (submitting) return;
    setSubmitting(true);
    setStepError('');
    setPoseSuccessToast('');

    try {
      const res = await apiService.confirmEkycDocument(sessionId, action, ekycToken);
      const updated = res.data?.session;
      setSession(updated);

      if (action === 'RETAKE') {
        clearDocumentBlobs();
        setUiStep(STEP.FRONT_CAPTURE);
      } else {
        setUiStep(STEP.LIVENESS_CAPTURE);
      }
    } catch (err) {
      setStepError(err.response?.data?.message || 'Không thể xác nhận thông tin CCCD.');
    } finally {
      setSubmitting(false);
    }
  };

  // Captures current live pose frame without stopping the front camera stream,
  // submits to Backend, and auto-transitions to the next pose (or final result at 5/5).
  const handleCaptureAndVerifyLivenessPose = async () => {
    const currentPose = session?.livenessProgress?.currentPose;
    if (!currentPose || submitting || cameraStatus !== 'READY') return;

    setSubmitting(true);
    setStepError('');
    setPoseSuccessToast('');

    try {
      const frameBlob = await captureVideoFrameToJpegBlob(videoRef.current, {
        maxDimension: 1280,
        quality: 0.9,
        mirrorHorizontal: MIRROR_LIVENESS_CAPTURE,
      });

      const res = await apiService.submitEkycLivenessPose(sessionId, currentPose, frameBlob, ekycToken);
      const data = res.data;
      const updatedSession = data?.session;
      setSession(updatedSession);

      if (data?.completed || updatedSession?.status === 'COMPLETED') {
        stopCameraStream();
        clearEkycMobileCredential(sessionId);
        setUiStep(STEP.RESULT);

        if (isLoggedIn) {
          try {
            const meRes = await apiService.getMe();
            if (meRes?.data) updateUser(meRes.data);
          } catch {
            // ignore
          }
        }
        return;
      }

      const completedNum = updatedSession?.livenessProgress?.completedCount || 0;
      const totalNum = updatedSession?.livenessProgress?.totalPoses || 5;
      setPoseSuccessToast(
        `Đạt tư thế ${completedNum}/${totalNum}! Chuyển sang tư thế tiếp theo...`
      );
      window.setTimeout(() => {
        setPoseSuccessToast((prev) => (prev ? '' : prev));
      }, 2200);
    } catch (err) {
      const errSession = err.response?.data?.session;
      const errMsg =
        err.response?.data?.message
        || 'Tư thế khuôn mặt chưa đạt yêu cầu. Vui lòng giữ mặt trong khung oval và thực hiện lại.';

      if (errSession) {
        setSession(errSession);
        if (TERMINAL_STATUSES.has(errSession.status)) {
          stopCameraStream();
          setUiStep(STEP.RESULT);
          return;
        }
      }
      setStepError(errMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryDocumentFromResult = () => {
    setStepError('');
    clearDocumentBlobs();
    setUiStep(STEP.FRONT_CAPTURE);
  };

  // ── Render Document Camera Viewport (Steps 2 & 3) ──
  const renderDocumentCameraBox = (target) => {
    const canFallbackInput = cameraStatus === 'NO_CAMERA' || cameraStatus === 'UNSUPPORTED';
    const currentLensIndex = rearCameras.findIndex((d) => d.deviceId === selectedRearDeviceId);

    return (
      <>
        <div className="mekyc-camera-stage">
          {cameraStatus === 'READY' || cameraStatus === 'STARTING' ? (
            <>
              <video
                ref={videoRef}
                className="mekyc-video"
                playsInline
                muted
                autoPlay
                onClick={handleTapRefocus}
              />

              {cameraStatus === 'READY' && (rearCameras.length > 1 || zoomState.supportedZoom) && (
                <div className="mekyc-cam-toolbar">
                  {rearCameras.length > 1 ? (
                    <button
                      type="button"
                      className="mekyc-cam-tool-btn"
                      onClick={handleSwitchRearLens}
                    >
                      <i className="fas fa-sync-alt" />
                      Đổi ống kính ({currentLensIndex >= 0 ? currentLensIndex + 1 : 1}/{rearCameras.length})
                    </button>
                  ) : (
                    <span />
                  )}

                  {zoomState.supportedZoom && (
                    <div className="mekyc-cam-zoom-group">
                      {[1, 1.5, 2]
                        .filter((z) => z >= zoomState.min && z <= zoomState.max)
                        .map((z) => (
                          <button
                            key={z}
                            type="button"
                            className={`mekyc-cam-zoom-pill ${
                              Math.abs(zoomState.current - z) < 0.2 ? 'is-active' : ''
                            }`}
                            onClick={() => handleChangeZoom(z)}
                          >
                            {z}x
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}

              <div className="mekyc-frame-overlay">
                <div className="mekyc-idcard-guide" />
              </div>

              {cameraStatus === 'STARTING' && (
                <div className="position-absolute text-white small d-flex align-items-center gap-2 bg-dark bg-opacity-75 px-3 py-2 rounded-pill">
                  <span className="spinner-border spinner-border-sm" />
                  Đang khởi động camera...
                </div>
              )}
            </>
          ) : (
            <div className="text-center text-white px-4 py-4">
              <i className="fas fa-video-slash fs-2 text-warning mb-2 d-block" />
              <div className="small mb-3">{cameraErrorMsg || 'Camera chưa sẵn sàng.'}</div>
              {cameraStatus === 'DENIED' && (
                <button
                  type="button"
                  className="btn btn-sm btn-light fw-bold"
                  onClick={() => setCameraRetryNonce((n) => n + 1)}
                >
                  <i className="fas fa-sync-alt me-1" />
                  Thử mở lại camera
                </button>
              )}
              {canFallbackInput && (
                <label className="btn btn-sm btn-primary fw-bold mb-0">
                  <i className="fas fa-camera me-1" />
                  Mở ứng dụng Camera thiết bị
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    className="d-none"
                    onChange={(e) => handleFallbackDocumentFile(e, target)}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        {(cameraStatus === 'READY' || cameraStatus === 'STARTING') && (
          <button
            type="button"
            className="mekyc-shutter-btn"
            onClick={() => handleCaptureDocumentPhoto(target)}
            disabled={cameraStatus !== 'READY' || submitting}
          >
            <i className="fas fa-camera" />
            Chụp ảnh ngay
          </button>
        )}
      </>
    );
  };

  // ── Bootstrap Loading / Fatal Session Claim Error ──
  if (bootstrapping) {
    return (
      <div className="mekyc-shell justify-content-center">
        <div className="mekyc-container">
          <div className="mekyc-card text-center py-5">
            <div className="spinner-border text-primary mb-3" role="status" />
            <div className="fw-bold text-dark">Đang thiết lập phiên xác minh bảo mật...</div>
            <div className="text-muted small mt-1">Vui lòng đợi trong giây lát</div>
          </div>
        </div>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div className="mekyc-shell">
        <div className="mekyc-container">
          <div className="mekyc-topbar">
            <div className="mekyc-brand">
              <i className="fas fa-shield-alt text-info" />
              <span>RentalP2P eKYC</span>
            </div>
          </div>

          <div className="mekyc-card text-center py-4">
            <div className="mekyc-result-icon mekyc-result-icon--error">
              <i className="fas fa-unlink" />
            </div>
            <h1 className="mekyc-title">{bootstrapError.title}</h1>
            <p className="mekyc-subtitle mb-4">{bootstrapError.message}</p>

            {isLoggedIn ? (
              <button
                type="button"
                className="mekyc-shutter-btn"
                onClick={() => navigate('/account')}
              >
                <i className="fas fa-arrow-left" />
                Quay lại trang Tài khoản
              </button>
            ) : (
              <div className="mekyc-alert mekyc-alert--info mb-0 text-start">
                <i className="fas fa-desktop me-2" />
                Hãy quay lại màn hình máy tính và nhấn <strong>&ldquo;Tạo lại mã QR&rdquo;</strong> để nhận mã mới.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isTerminal = session && TERMINAL_STATUSES.has(session.status);
  const livenessProgress = session?.livenessProgress || {
    totalPoses: 5,
    completedCount: 0,
    currentPoseNumber: 1,
    currentPose: 'Portrait',
    poses: [],
  };
  const currentPoseMeta = POSE_UI_META[livenessProgress.currentPose] || POSE_UI_META.Portrait;

  return (
    <div className="mekyc-shell">
      <div className="mekyc-container">
        {/* Topbar */}
        <div className="mekyc-topbar">
          <div className="mekyc-brand">
            <i className="fas fa-shield-alt text-info" />
            <span>RentalP2P · Xác minh danh tính</span>
          </div>

          {!isTerminal && remainingSeconds > 0 && (
            <span
              className={`mekyc-timer-chip ${remainingSeconds <= 120 ? 'mekyc-timer-chip--urgent' : ''}`}
            >
              <i className="far fa-clock me-1" />
              {formatCountdown(remainingSeconds)}
            </span>
          )}
        </div>

        {/* 7-Step Progress Indicator */}
        <div className="mekyc-stepper">
          <div className="mekyc-stepper-top">
            <span className="fw-bold">Bước {uiStep}/7</span>
            <span className="text-white-50">{STEP_TITLES[uiStep]}</span>
          </div>
          <div className="mekyc-progress-track">
            {[1, 2, 3, 4, 5, 6, 7].map((seg) => (
              <div
                key={seg}
                className={`mekyc-progress-bar-seg ${
                  seg < uiStep || (uiStep === STEP.RESULT && session?.status === 'COMPLETED')
                    ? 'is-done'
                    : seg === uiStep
                      ? 'is-current'
                      : ''
                }`}
              />
            ))}
          </div>
        </div>

        {isOffline && (
          <div className="mekyc-offline-banner">
            <i className="fas fa-wifi" />
            Thiết bị đang mất kết nối mạng. Vui lòng kiểm tra Wi-Fi/4G trước khi gửi dữ liệu.
          </div>
        )}

        {/* Main Step Card */}
        <div className="mekyc-card">
          {stepError && (
            <div className="mekyc-alert mekyc-alert--error">
              <i className="fas fa-exclamation-circle me-2" />
              {stepError}
            </div>
          )}

          {/* ── STEP 1: CONSENT ── */}
          {uiStep === STEP.CONSENT && (
            <div>
              <h1 className="mekyc-title">Xác minh danh tính (eKYC)</h1>
              <p className="mekyc-subtitle">
                Nhằm tăng cường an toàn giao dịch thuê &amp; cho thuê tài sản trên nền tảng, hệ thống thực hiện kiểm tra giấy tờ CCCD và xác thực thực thể sống.
              </p>

              <ul className="mekyc-info-list">
                <li>
                  <i className="fas fa-id-card" />
                  <div>
                    <strong>Dữ liệu thu thập:</strong> Ảnh chụp mặt trước &amp; mặt sau thẻ CCCD, thông tin OCR từ CCCD và 5 ảnh tư thế khuôn mặt chụp trực tiếp từ camera trước.
                  </div>
                </li>
                <li>
                  <i className="fas fa-check-double" />
                  <div>
                    <strong>Chuẩn bị giấy tờ:</strong> Sử dụng <strong>thẻ CCCD bản gốc</strong> còn hạn sử dụng. Không dùng bản photocopy, ảnh chụp màn hình hoặc giấy tờ bị cắt góc.
                  </div>
                </li>
                <li>
                  <i className="fas fa-user-lock" />
                  <div>
                    <strong>Đối tác xử lý &amp; Bảo mật:</strong> Hình ảnh được kiểm tra giả mạo giấy tờ, bóc tách OCR và kiểm tra thực thể sống (Full Liveness 5 tư thế) qua dịch vụ <strong>Viettel AI</strong>. Ảnh chụp không lưu trữ công khai.
                  </div>
                </li>
              </ul>

              <div className="mekyc-consent-box">
                <label className="mekyc-consent-label" htmlFor="ekyc-consent-check">
                  <input
                    id="ekyc-consent-check"
                    type="checkbox"
                    checked={consentChecked}
                    onChange={(e) => setConsentChecked(e.target.checked)}
                  />
                  <span>
                    Tôi đã đọc, hiểu rõ mục đích và đồng ý cho phép RentalP2P thu thập, xử lý dữ liệu cá nhân &amp; hình ảnh khuôn mặt thông qua dịch vụ Viettel AI để thực hiện eKYC.
                  </span>
                </label>
              </div>

              <button
                type="button"
                className="mekyc-shutter-btn"
                disabled={!consentChecked || submitting || isOffline}
                onClick={handleAcceptConsent}
              >
                {submitting ? (
                  <>
                    <span className="spinner-border spinner-border-sm" />
                    Đang bắt đầu...
                  </>
                ) : (
                  <>
                    Bắt đầu xác minh
                    <i className="fas fa-arrow-right" />
                  </>
                )}
              </button>
            </div>
          )}

          {/* ── STEP 2: FRONT CCCD CAPTURE ── */}
          {uiStep === STEP.FRONT_CAPTURE && (
            <div>
              <h1 className="mekyc-title">Chụp mặt trước CCCD</h1>
              <p className="mekyc-subtitle">
                Đặt mặt trước thẻ CCCD bản gốc nằm gọn trong khung hướng dẫn, rõ chữ và không bị chói sáng.
              </p>

              <div className="mekyc-tips-row">
                <span className="mekyc-tip-pill">
                  <i className="fas fa-sun text-warning" /> Đủ ánh sáng
                </span>
                <span className="mekyc-tip-pill">
                  <i className="fas fa-crop-alt text-primary" /> Không mất góc
                </span>
                <span className="mekyc-tip-pill">
                  <i className="fas fa-ban text-danger" /> Không chụp qua màn hình
                </span>
              </div>

              {!frontBlob ? (
                renderDocumentCameraBox('FRONT')
              ) : (
                <>
                  <div className="mekyc-camera-stage">
                    <img
                      src={frontPreviewUrl}
                      alt="Xem trước CCCD mặt trước"
                      className="mekyc-preview-img"
                    />
                  </div>
                  <div className="mekyc-action-row">
                    <button
                      type="button"
                      className="ekyc-secondary-btn"
                      onClick={() => {
                        setFrontBlob(null);
                        setFrontPreviewUrl((prev) => {
                          revokeObjectUrlSafely(prev);
                          return '';
                        });
                      }}
                    >
                      <i className="fas fa-redo" />
                      Chụp lại
                    </button>
                    <button
                      type="button"
                      className="ekyc-primary-btn"
                      onClick={() => {
                        setStepError('');
                        setUiStep(STEP.BACK_CAPTURE);
                      }}
                    >
                      Xác nhận ảnh
                      <i className="fas fa-arrow-right" />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP 3: BACK CCCD CAPTURE ── */}
          {uiStep === STEP.BACK_CAPTURE && (
            <div>
              <h1 className="mekyc-title">Chụp mặt sau CCCD</h1>
              <p className="mekyc-subtitle">
                Lật mặt sau của cùng thẻ CCCD vừa chụp và căn chỉnh nằm gọn trong khung hình.
              </p>

              <div className="mekyc-tips-row">
                <span className="mekyc-tip-pill">
                  <i className="fas fa-id-card text-primary" /> Đúng thẻ vừa chụp mặt trước
                </span>
                <span className="mekyc-tip-pill">
                  <i className="fas fa-eye text-success" /> Rõ ngày cấp &amp; dòng mã MRZ
                </span>
              </div>

              {!backBlob ? (
                <>
                  {renderDocumentCameraBox('BACK')}
                  <button
                    type="button"
                    className="btn btn-link btn-sm text-secondary w-100 mt-2 text-decoration-none"
                    onClick={() => setUiStep(STEP.FRONT_CAPTURE)}
                  >
                    <i className="fas fa-chevron-left me-1" />
                    Quay lại xem ảnh mặt trước
                  </button>
                </>
              ) : (
                <>
                  <div className="mekyc-camera-stage">
                    <img
                      src={backPreviewUrl}
                      alt="Xem trước CCCD mặt sau"
                      className="mekyc-preview-img"
                    />
                  </div>
                  <div className="mekyc-action-row">
                    <button
                      type="button"
                      className="ekyc-secondary-btn"
                      disabled={submitting}
                      onClick={() => {
                        setBackBlob(null);
                        setBackPreviewUrl((prev) => {
                          revokeObjectUrlSafely(prev);
                          return '';
                        });
                      }}
                    >
                      <i className="fas fa-redo" />
                      Chụp lại
                    </button>
                    <button
                      type="button"
                      className="ekyc-primary-btn"
                      disabled={submitting || isOffline}
                      onClick={handleSubmitDocuments}
                    >
                      <i className="fas fa-check-circle" />
                      Kiểm tra giấy tờ
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP 4: CHECKING DOCUMENTS LOADING ── */}
          {uiStep === STEP.DOCUMENT_CHECKING && (
            <div className="text-center py-4">
              <div
                className="spinner-border text-primary mb-3"
                style={{ width: '3rem', height: '3rem' }}
                role="status"
              />
              <h2 className="mekyc-title">Đang kiểm tra tính hợp lệ của giấy tờ</h2>
              <p className="mekyc-subtitle mb-0">
                Hệ thống đang kiểm tra dấu hiệu giả mạo hai mặt CCCD và bóc tách thông tin định danh qua Viettel AI. Vui lòng giữ màn hình mở trong giây lát...
              </p>
            </div>
          )}

          {/* ── STEP 5: CONFIRM READ-ONLY OCR INFORMATION ── */}
          {uiStep === STEP.OCR_CONFIRM && (
            <div>
              <h1 className="mekyc-title">Kiểm tra &amp; Xác nhận thông tin</h1>
              <p className="mekyc-subtitle">
                Vui lòng đối chiếu các thông tin được nhận dạng từ CCCD. Để đảm bảo tính toàn vẹn, dữ liệu OCR không thể chỉnh sửa thủ công.
              </p>

              {session?.ocrPreview ? (
                <div className="mekyc-ocr-table">
                  <div className="mekyc-ocr-row">
                    <span className="mekyc-ocr-label">Số CCCD</span>
                    <span className="mekyc-ocr-value">{session.ocrPreview.idNumberMasked}</span>
                  </div>
                  <div className="mekyc-ocr-row">
                    <span className="mekyc-ocr-label">Họ và tên</span>
                    <span className="mekyc-ocr-value">{session.ocrPreview.fullName}</span>
                  </div>
                  <div className="mekyc-ocr-row">
                    <span className="mekyc-ocr-label">Ngày sinh</span>
                    <span className="mekyc-ocr-value">{session.ocrPreview.birthday}</span>
                  </div>
                  {session.ocrPreview.sex && (
                    <div className="mekyc-ocr-row">
                      <span className="mekyc-ocr-label">Giới tính</span>
                      <span className="mekyc-ocr-value">{session.ocrPreview.sex}</span>
                    </div>
                  )}
                  <div className="mekyc-ocr-row">
                    <span className="mekyc-ocr-label">Ngày cấp</span>
                    <span className="mekyc-ocr-value">{session.ocrPreview.issueDate}</span>
                  </div>
                  <div className="mekyc-ocr-row">
                    <span className="mekyc-ocr-label">Ngày hết hạn</span>
                    <span className="mekyc-ocr-value">{session.ocrPreview.expiry}</span>
                  </div>
                  {session.ocrPreview.address && (
                    <div className="mekyc-ocr-row">
                      <span className="mekyc-ocr-label">Địa chỉ</span>
                      <span className="mekyc-ocr-value">{session.ocrPreview.address}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mekyc-alert mekyc-alert--error">
                  Không tìm thấy thông tin OCR. Vui lòng chụp lại giấy tờ CCCD.
                </div>
              )}

              <div className="d-flex flex-column gap-2">
                <button
                  type="button"
                  className="mekyc-shutter-btn"
                  disabled={submitting || isOffline || !session?.ocrPreview}
                  onClick={() => handleConfirmOcr('CONFIRM')}
                >
                  {submitting ? (
                    <>
                      <span className="spinner-border spinner-border-sm" />
                      Đang khởi tạo thử thách...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-check" />
                      Thông tin chính xác, tiếp tục
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="ekyc-secondary-btn w-100"
                  disabled={submitting || isOffline}
                  onClick={() => handleConfirmOcr('RETAKE')}
                >
                  <i className="fas fa-camera-retro" />
                  Thông tin chưa đúng, chụp lại CCCD
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 6: FULL 5-POSE LIVENESS DETECTION (Front Camera Only, No File Upload) ── */}
          {uiStep === STEP.LIVENESS_CAPTURE && (
            <div className="mekyc-liveness-step">
              <div className="mekyc-liveness-header">
                <h1 className="mekyc-title mb-0">Kiểm tra thực thể sống</h1>
                <span className="mekyc-pose-count-badge">
                  Tư thế {livenessProgress.currentPoseNumber}/{livenessProgress.totalPoses}
                </span>
              </div>
              <p className="mekyc-subtitle mekyc-subtitle--compact">
                Thực hiện đủ 5 tư thế khuôn mặt nơi đủ sáng, không đeo khẩu trang hoặc kính râm.
              </p>

              {/* 1/5 .. 5/5 Pose Progress Chips */}
              {livenessProgress.poses?.length > 0 && (
                <div className="mekyc-liveness-progress">
                  {livenessProgress.poses.map((item) => {
                    const meta = POSE_UI_META[item.pose] || { shortLabel: item.pose };
                    return (
                      <div
                        key={item.pose}
                        className={`mekyc-pose-step-chip ${
                          item.passed ? 'is-done' : item.isCurrent ? 'is-current' : ''
                        }`}
                      >
                        <div className="mekyc-pose-step-num">
                          {item.passed ? (
                            <i className="fas fa-check-circle" />
                          ) : (
                            <span>{item.index}/5</span>
                          )}
                        </div>
                        <div className="mekyc-pose-step-label">{meta.shortLabel}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Status Feedback Banner */}
              {submitting && (
                <div className="mekyc-pose-feedback mekyc-pose-feedback--checking">
                  <span className="spinner-border spinner-border-sm flex-shrink-0" />
                  <span>
                    Đang kiểm tra tư thế {livenessProgress.currentPoseNumber}/5 ({currentPoseMeta.shortLabel})...
                  </span>
                </div>
              )}

              {!submitting && poseSuccessToast && (
                <div className="mekyc-pose-feedback mekyc-pose-feedback--success">
                  <i className="fas fa-check-circle flex-shrink-0" />
                  <span>{poseSuccessToast}</span>
                </div>
              )}

              {/* Current Pose Instruction + Illustration */}
              <div className="mekyc-pose-prompt-card">
                <PoseIllustration pose={livenessProgress.currentPose} />
                <div className="mekyc-pose-prompt-body">
                  <div className="mekyc-pose-prompt-title">
                    {livenessProgress.currentPoseNumber}/5 · {currentPoseMeta.title}
                  </div>
                  <div className="mekyc-pose-prompt-hint">
                    {currentPoseMeta.hint}
                  </div>
                </div>
              </div>

              {/* Continuous Live Front Camera Stage (Strictly NO file upload) */}
              <div className="mekyc-camera-stage mekyc-camera-stage--portrait">
                {cameraStatus === 'READY' || cameraStatus === 'STARTING' ? (
                  <>
                    <video
                      ref={videoRef}
                      className="mekyc-video mekyc-video--mirrored"
                      playsInline
                      muted
                      autoPlay
                    />
                    <div className="mekyc-frame-overlay">
                      <div
                        className={`mekyc-oval-guide ${
                          submitting
                            ? 'mekyc-oval-guide--checking'
                            : poseSuccessToast
                              ? 'mekyc-oval-guide--passed'
                              : ''
                        }`}
                      >
                        {currentPoseMeta.arrowIcon && (
                          <span
                            className={`mekyc-pose-arrow-badge mekyc-pose-arrow-badge--${currentPoseMeta.arrowPosition}`}
                          >
                            <i className={`fas ${currentPoseMeta.arrowIcon}`} />
                          </span>
                        )}
                      </div>
                    </div>
                    {cameraStatus === 'STARTING' && (
                      <div className="position-absolute text-white small d-flex align-items-center gap-2 bg-dark bg-opacity-75 px-3 py-2 rounded-pill">
                        <span className="spinner-border spinner-border-sm" />
                        Đang mở camera trước...
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center text-white px-3 py-3">
                    <i className="fas fa-video-slash fs-3 text-warning mb-2 d-block" />
                    <div className="small mb-3">
                      {cameraErrorMsg || 'Bước kiểm tra thực thể sống bắt buộc sử dụng camera trước trực tiếp.'}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-light fw-bold"
                      onClick={() => setCameraRetryNonce((n) => n + 1)}
                    >
                      <i className="fas fa-sync-alt me-1" />
                      Thử mở lại camera trước
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                className="mekyc-shutter-btn"
                disabled={cameraStatus !== 'READY' || submitting || isOffline}
                onClick={handleCaptureAndVerifyLivenessPose}
              >
                {submitting ? (
                  <>
                    <span className="spinner-border spinner-border-sm flex-shrink-0" />
                    <span>Đang xác thực tư thế {livenessProgress.currentPoseNumber}/5...</span>
                  </>
                ) : (
                  <>
                    <i className="fas fa-camera flex-shrink-0" />
                    <span>Chụp tư thế {livenessProgress.currentPoseNumber}/5 ({currentPoseMeta.shortLabel})</span>
                  </>
                )}
              </button>

              {session?.remainingLivenessRetries !== undefined && (
                <div className="text-center text-muted mt-2" style={{ fontSize: '0.75rem' }}>
                  Số lượt thử lại còn lại trong phiên: <strong>{session.remainingLivenessRetries}</strong>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 7: VERIFICATION RESULT ── */}
          {uiStep === STEP.RESULT && (
            <div className="text-center py-2">
              {session?.status === 'COMPLETED' ? (
                <>
                  <div className="mekyc-result-icon mekyc-result-icon--success">
                    <i className="fas fa-check" />
                  </div>
                  <h1 className="mekyc-title text-success">Hoàn tất xác minh eKYC!</h1>
                  <p className="mekyc-subtitle">
                    Đã kiểm tra hợp lệ CCCD hai mặt và hoàn thành 5/5 tư thế thực thể sống. Kết quả đã tự động đồng bộ về thiết bị ban đầu.
                  </p>

                  {session.ocrPreview && (
                    <div className="mekyc-ocr-table text-start mb-3">
                      <div className="mekyc-ocr-row">
                        <span className="mekyc-ocr-label">Họ và tên</span>
                        <span className="mekyc-ocr-value">{session.ocrPreview.fullName}</span>
                      </div>
                      <div className="mekyc-ocr-row">
                        <span className="mekyc-ocr-label">Số CCCD</span>
                        <span className="mekyc-ocr-value">{session.ocrPreview.idNumberMasked}</span>
                      </div>
                    </div>
                  )}

                  {isLoggedIn ? (
                    <button
                      type="button"
                      className="mekyc-shutter-btn"
                      onClick={() => navigate('/account')}
                    >
                      <i className="fas fa-user-check" />
                      Quay về Tài khoản của tôi
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ekyc-secondary-btn w-100 mb-2"
                        onClick={() => {
                          window.close();
                        }}
                      >
                        <i className="fas fa-check-circle text-success" />
                        Đóng trang xác minh
                      </button>
                      <div className="text-muted small">
                        Bạn có thể đóng tab trình duyệt này trên điện thoại và tiếp tục thao tác trên máy tính.
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="mekyc-result-icon mekyc-result-icon--error">
                    <i className="fas fa-exclamation-triangle" />
                  </div>
                  <h1 className="mekyc-title text-danger">
                    {session?.status === 'EXPIRED'
                      ? 'Phiên xác minh đã hết hạn'
                      : session?.status === 'CANCELLED'
                        ? 'Phiên xác minh đã bị hủy'
                        : 'Chưa thể hoàn tất xác minh'}
                  </h1>
                  <p className="mekyc-subtitle">
                    {session?.failureReason || 'Quá trình kiểm tra chưa đạt yêu cầu. Vui lòng kiểm tra lại và thử lại bước phù hợp.'}
                  </p>

                  {session?.status === 'DOCUMENT_RETRY_REQUIRED' && session.remainingDocumentAttempts > 0 && (
                    <div className="mb-3">
                      <div className="mekyc-alert mekyc-alert--info text-start">
                        <i className="fas fa-info-circle me-1" />
                        Bạn còn <strong>{session.remainingDocumentAttempts}</strong> lượt chụp và kiểm tra giấy tờ trong phiên này.
                      </div>
                      <button
                        type="button"
                        className="mekyc-shutter-btn"
                        onClick={handleRetryDocumentFromResult}
                      >
                        <i className="fas fa-id-card" />
                        Chụp lại CCCD hai mặt
                      </button>
                    </div>
                  )}

                  {(session?.status === 'FAILED' || session?.status === 'EXPIRED' || session?.status === 'CANCELLED') && (
                    <div className="mekyc-alert mekyc-alert--info text-start mt-2">
                      <div className="fw-bold mb-1">
                        <i className="fas fa-headset me-1" />
                        Hướng dẫn tiếp theo &amp; Liên hệ hỗ trợ
                      </div>
                      <div className="small">
                        {session?.status === 'FAILED'
                          ? 'Bạn đã sử dụng hết số lần thử trong phiên hiện tại. Bạn có thể tạo một phiên mới từ trang Tài khoản hoặc liên hệ bộ phận Chăm sóc khách hàng để được hỗ trợ:'
                          : 'Vui lòng quay lại trang Tài khoản trên thiết bị gốc và nhấn "Tạo lại mã QR" để bắt đầu phiên mới.'}
                      </div>
                      <div className="mt-2 small fw-semibold">
                        <div>Hotline hỗ trợ: <a href="tel:+84364123957">+84 364 123 957</a></div>
                        <div>Email: <a href="mailto:thanquocthinh287@gmail.com">thanquocthinh287@gmail.com</a></div>
                      </div>
                      {isLoggedIn && (
                        <button
                          type="button"
                          className="ekyc-primary-btn w-100 mt-3"
                          onClick={() => navigate('/account')}
                        >
                          <i className="fas fa-arrow-left" />
                          Quay lại trang Tài khoản
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
