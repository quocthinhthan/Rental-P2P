import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Swal from 'sweetalert2';
import apiService from '../../services/api';
import { createEkycSessionSocket } from '../../services/ekycSocket';
import { encodeQrMatrix, buildQrSvgPath } from '../../utils/qrCode';
import {
  isMobileBrowserDevice,
  saveEkycMobileCredential,
} from '../../utils/ekycSessionStorage';
import '../../styles/Ekyc.css';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED']);

const formatCountdown = (seconds) => {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = String(Math.floor(clamped / 60)).padStart(2, '0');
  const secs = String(clamped % 60).padStart(2, '0');
  return `${mins}:${secs}`;
};

const maskVerificationUrlForDisplay = (rawUrl) => {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const tok = parsed.searchParams.get('token') || '';
    const maskedTok = tok.length > 10 ? `${tok.slice(0, 6)}...${tok.slice(-4)}` : '***';
    return `${parsed.origin}${parsed.pathname}?token=${maskedTok}`;
  } catch {
    return rawUrl.slice(0, 42);
  }
};

const getStepProgressIndex = (session) => {
  if (!session) return 0;
  switch (session.status) {
    case 'CREATED':
      return 0;
    case 'CLAIMED':
    case 'CONSENT_ACCEPTED':
      return 1;
    case 'DOCUMENT_PROCESSING':
    case 'DOCUMENT_RETRY_REQUIRED':
    case 'DOCUMENT_VERIFIED':
      return 2;
    case 'DOCUMENT_CONFIRMED':
    case 'LIVENESS_IN_PROGRESS':
    case 'LIVENESS_PROCESSING':
    case 'LIVENESS_RETRY_REQUIRED':
    case 'FACE_PROCESSING':
    case 'FACE_RETRY_REQUIRED':
      return 3;
    case 'COMPLETED':
      return 4;
    default:
      return 0;
  }
};

function QrCodeGraphic({ value, dimmed = false }) {
  const qrData = useMemo(() => {
    if (!value) return null;
    try {
      const matrix = encodeQrMatrix(value);
      const quietZone = 4;
      return {
        viewSize: matrix.size + quietZone * 2,
        pathData: buildQrSvgPath(matrix.modules, quietZone),
      };
    } catch (err) {
      console.error('QR generation failed:', err);
      return null;
    }
  }, [value]);

  if (!qrData) {
    return (
      <div className="ekyc-qr-svg-wrap text-muted small px-2">
        Không thể hiển thị mã QR
      </div>
    );
  }

  return (
    <div className={`ekyc-qr-svg-wrap ${dimmed ? 'ekyc-qr-svg-wrap--dimmed' : ''}`}>
      <svg
        viewBox={`0 0 ${qrData.viewSize} ${qrData.viewSize}`}
        width="100%"
        height="100%"
        shapeRendering="crispEdges"
        role="img"
        aria-label="Mã QR xác minh danh tính"
      >
        <rect width={qrData.viewSize} height={qrData.viewSize} fill="#ffffff" />
        <path d={qrData.pathData} fill="#0f172a" />
      </svg>
    </div>
  );
}

export default function DesktopEkycPanel({ user, onVerifiedSuccess }) {
  const navigate = useNavigate();
  const isMobileDevice = useMemo(() => isMobileBrowserDevice(), []);

  const [statusLoading, setStatusLoading] = useState(true);
  const [accountStatus, setAccountStatus] = useState(null);
  const [session, setSession] = useState(null);
  const [qrUrl, setQrUrl] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [socketConnected, setSocketConnected] = useState(false);

  const syncedCompletionRef = useRef('');

  const refreshAccountUser = useCallback(async () => {
    try {
      const [statusRes, meRes] = await Promise.all([
        apiService.getEkycStatus(),
        apiService.getMe(),
      ]);
      setAccountStatus(statusRes.data);
      if (meRes?.data && onVerifiedSuccess) {
        onVerifiedSuccess(meRes.data);
      }
    } catch (err) {
      console.error('Failed to sync verified user state:', err);
    }
  }, [onVerifiedSuccess]);

  const handleIncomingSessionState = useCallback(
    (nextSession) => {
      if (!nextSession) return;
      setSession(nextSession);

      if (
        nextSession.status === 'COMPLETED'
        && syncedCompletionRef.current !== nextSession.sessionId
      ) {
        syncedCompletionRef.current = nextSession.sessionId;
        refreshAccountUser();
      }
    },
    [refreshAccountUser]
  );

  // Initial status fetch
  useEffect(() => {
    let mounted = true;
    const loadInitialStatus = async () => {
      setStatusLoading(true);
      try {
        const res = await apiService.getEkycStatus();
        if (!mounted) return;
        setAccountStatus(res.data);
        if (res.data?.activeSession) {
          setSession(res.data.activeSession);
        }
      } catch {
        // Fallback to user prop if status call fails
      } finally {
        if (mounted) setStatusLoading(false);
      }
    };

    loadInitialStatus();
    return () => {
      mounted = false;
    };
  }, [user?.ekycStatus]);

  // Network online/offline awareness
  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Countdown timer for active session
  useEffect(() => {
    if (!session?.expiresAt || TERMINAL_STATUSES.has(session.status)) {
      setRemainingSeconds(0);
      return undefined;
    }

    const updateRemaining = () => {
      const diffSec = Math.max(
        0,
        Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
      );
      setRemainingSeconds(diffSec);

      if (diffSec <= 0 && !TERMINAL_STATUSES.has(session.status)) {
        setSession((prev) => (prev && !TERMINAL_STATUSES.has(prev.status)
          ? {
              ...prev,
              status: 'EXPIRED',
              uiPhase: 'SESSION_EXPIRED',
              uiPhaseLabel: 'Phiên xác minh đã hết hạn',
              failureReason: 'Phiên xác minh đã hết hạn. Vui lòng tạo lại mã QR mới.',
            }
          : prev));
      }
    };

    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [session?.sessionId, session?.expiresAt, session?.status]);

  // Realtime Socket.IO subscription + resilient fallback polling
  useEffect(() => {
    const activeSessionId = session?.sessionId;
    if (!activeSessionId || TERMINAL_STATUSES.has(session?.status)) {
      setSocketConnected(false);
      return undefined;
    }

    const socket = createEkycSessionSocket();

    const handleConnect = () => {
      setSocketConnected(true);
      socket.emit('join_ekyc_session', activeSessionId);
    };

    const handleDisconnect = () => {
      setSocketConnected(false);
    };

    const handleSessionUpdated = (payload) => {
      if (payload?.sessionId === activeSessionId) {
        handleIncomingSessionState(payload);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('ekyc_session_updated', handleSessionUpdated);
    socket.connect();

    const pollSession = async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        const res = await apiService.getEkycSessionOwner(activeSessionId);
        if (res.data?.session) {
          handleIncomingSessionState(res.data.session);
        }
      } catch {
        // Ignore transient poll errors while socket is active
      }
    };

    const pollInterval = window.setInterval(pollSession, 4500);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        pollSession();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      socket.emit('leave_ekyc_session', activeSessionId);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('ekyc_session_updated', handleSessionUpdated);
      socket.disconnect();
      setSocketConnected(false);
    };
  }, [session?.sessionId, session?.status, handleIncomingSessionState]);

  const handleStartVerification = async (preferredMode) => {
    const mode = preferredMode || (isMobileDevice ? 'DIRECT' : 'QR');
    setActionLoading(true);
    setActionError('');
    setCopiedLink(false);

    try {
      const res = await apiService.createEkycSession(mode);
      const data = res.data;

      if (mode === 'DIRECT' && data.ekycSessionToken && data.session?.sessionId) {
        saveEkycMobileCredential(data.session.sessionId, data.ekycSessionToken);
        navigate(`/verify-identity?sessionId=${encodeURIComponent(data.session.sessionId)}`);
        return;
      }

      setSession(data.session);
      setQrUrl(data.qrUrl || '');
    } catch (err) {
      setActionError(
        err.response?.data?.message || 'Không thể khởi tạo phiên xác minh danh tính. Vui lòng thử lại.'
      );
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelVerification = async () => {
    if (!session?.sessionId) return;

    const confirmRes = await Swal.fire({
      title: 'Hủy phiên xác minh?',
      text: 'Mã QR hiện tại và tiến trình đang thực hiện trên điện thoại sẽ bị vô hiệu hóa ngay lập tức.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Đồng ý hủy',
      cancelButtonText: 'Tiếp tục chờ',
      confirmButtonColor: '#dc2626',
    });

    if (!confirmRes.isConfirmed) return;

    setActionLoading(true);
    setActionError('');
    try {
      const res = await apiService.cancelEkycSessionOwner(session.sessionId);
      setSession(res.data?.session || null);
      setQrUrl('');
    } catch (err) {
      setActionError(err.response?.data?.message || 'Không thể hủy phiên xác minh.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!qrUrl) return;
    try {
      await navigator.clipboard.writeText(qrUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      Swal.fire('Sao chép thủ công', qrUrl, 'info');
    }
  };

  const isVerifiedAndValid = accountStatus
    ? Boolean(accountStatus.isVerifiedAndValid)
    : user?.ekycStatus === 'verified';

  const reverificationRequired = Boolean(accountStatus?.reverificationRequired);

  if (statusLoading) {
    return (
      <div className="ekyc-desk-card text-center py-4 text-muted">
        <span className="spinner-border spinner-border-sm me-2 text-primary" />
        Đang kiểm tra trạng thái xác minh danh tính...
      </div>
    );
  }

  // ── 1. Verified & Valid State ──
  if (isVerifiedAndValid && session?.status !== 'COMPLETED') {
    const maskedId = accountStatus?.identitySummary?.idNumberMasked || user?.idCardNumber || '';
    const expiryText = accountStatus?.identitySummary?.expiry || '';

    return (
      <div className="ekyc-desk-card">
        <div className="acc-ekyc-verified-banner">
          <div className="acc-ekyc-verified-icon">
            <i className="fas fa-shield-alt" />
          </div>
          <div className="flex-grow-1">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <div className="acc-ekyc-verified-title mb-0">Danh tính đã được xác minh</div>
              <span className="ekyc-status-pill ekyc-status-pill--verified">
                <i className="fas fa-check-circle" /> Đã xác thực
              </span>
            </div>
            <div className="acc-ekyc-verified-sub mt-1">
              Tài khoản của bạn đã hoàn tất xác minh danh tính và đủ điều kiện thực hiện mọi giao dịch trên nền tảng.
            </div>
            {(maskedId || expiryText) && (
              <div className="d-flex flex-wrap gap-3 mt-2 small text-dark">
                {maskedId && (
                  <span>
                    <i className="fas fa-id-card text-success me-1" />
                    Số CCCD: <strong>{maskedId}</strong>
                  </span>
                )}
                {expiryText && (
                  <span>
                    <i className="fas fa-calendar-check text-success me-1" />
                    Hiệu lực giấy tờ: <strong>{expiryText}</strong>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── 2. Active / Terminal Verification Session View (Desktop QR & Live Sync) ──
  if (session) {
    const isExpired = session.status === 'EXPIRED';
    const isCancelled = session.status === 'CANCELLED';
    const isCompleted = session.status === 'COMPLETED';
    const isRetryOrFailed = [
      'DOCUMENT_RETRY_REQUIRED',
      'LIVENESS_RETRY_REQUIRED',
      'FACE_RETRY_REQUIRED',
      'FAILED',
    ].includes(session.status);
    const isTerminal = TERMINAL_STATUSES.has(session.status);
    const stepIdx = getStepProgressIndex(session);

    let bannerVariant = '';
    if (isCompleted) bannerVariant = 'ekyc-live-status-banner--success';
    else if (isExpired || isCancelled) bannerVariant = 'ekyc-live-status-banner--danger';
    else if (isRetryOrFailed) bannerVariant = 'ekyc-live-status-banner--warn';

    return (
      <div className="ekyc-desk-card">
        {isOffline && (
          <div className="mekyc-offline-banner">
            <i className="fas fa-wifi" />
            Mất kết nối mạng trên máy tính. Hệ thống sẽ tự động đồng bộ lại ngay khi có mạng.
          </div>
        )}

        {/* Live Status Header */}
        <div className={`ekyc-live-status-banner ${bannerVariant}`}>
          <div className="d-flex align-items-center gap-2">
            {!isTerminal ? (
              <span
                className={`ekyc-pulse-dot ${session.mobileConnected ? 'ekyc-pulse-dot--connected' : ''}`}
              />
            ) : (
              <i
                className={`fas ${
                  isCompleted
                    ? 'fa-check-circle text-success'
                    : isExpired
                      ? 'fa-hourglass-end text-danger'
                      : 'fa-exclamation-circle text-danger'
                }`}
              />
            )}
            <div>
              <div className="fw-bold text-dark" style={{ fontSize: '0.93rem' }}>
                {session.uiPhaseLabel || 'Đang chờ quét mã QR'}
              </div>
              <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                {session.mobileConnected
                  ? 'Thiết bị di động đã kết nối với phiên xác minh'
                  : 'Chưa có thiết bị di động kết nối'}
                {!isTerminal && socketConnected && ' · Đồng bộ thời gian thực'}
              </div>
            </div>
          </div>

          {!isTerminal && (
            <span
              className={`ekyc-timer-badge ${remainingSeconds <= 120 ? 'ekyc-timer-badge--urgent' : ''}`}
              title="Thời gian còn lại của phiên xác minh"
            >
              <i className="far fa-clock" />
              Còn lại {formatCountdown(remainingSeconds)}
            </span>
          )}
        </div>

        {/* Desktop Step Progress Indicator */}
        <div className="ekyc-desktop-steps">
          {[
            { label: '1. Kết nối điện thoại', idx: 1 },
            { label: '2. Xác minh CCCD', idx: 2 },
            {
              label:
                session.livenessTotalPoses > 0
                  ? `3. Xác thực khuôn mặt (${session.livenessCompletedPoses || 0}/${session.livenessTotalPoses})`
                  : '3. Xác thực khuôn mặt',
              idx: 3,
            },
            { label: '4. Hoàn tất xác minh', idx: 4 },
          ].map((step) => {
            const isDone = isCompleted || stepIdx > step.idx;
            const isActive = !isTerminal && stepIdx === step.idx;
            return (
              <div
                key={step.idx}
                className={`ekyc-desktop-step ${isDone ? 'is-done' : ''} ${isActive ? 'is-active' : ''}`}
              >
                <i
                  className={`fas ${
                    isDone ? 'fa-check-circle' : isActive ? 'fa-spinner fa-spin' : 'fa-circle'
                  }`}
                  style={{ fontSize: isDone || isActive ? '0.82rem' : '0.45rem' }}
                />
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>

        {/* Completed State */}
        {isCompleted ? (
          <div className="acc-ekyc-verified-banner mt-3">
            <div className="acc-ekyc-verified-icon">
              <i className="fas fa-check" />
            </div>
            <div className="flex-grow-1">
              <div className="acc-ekyc-verified-title">Xác minh danh tính thành công!</div>
              <div className="acc-ekyc-verified-sub">
                Hồ sơ của bạn đã được cập nhật tự động mà không cần tải lại trang.
              </div>
              {session.resultSummary && (
                <div className="d-flex flex-wrap gap-3 mt-2 small text-dark">
                  {session.resultSummary.verifiedFullName && (
                    <span>
                      Họ tên: <strong>{session.resultSummary.verifiedFullName}</strong>
                    </span>
                  )}
                  {session.resultSummary.idNumberMasked && (
                    <span>
                      Số CCCD: <strong>{session.resultSummary.idNumberMasked}</strong>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="ekyc-qr-layout mt-3">
            {/* Left Column: QR Code */}
            <div className="ekyc-qr-box">
              {qrUrl ? (
                <>
                  <QrCodeGraphic
                    value={qrUrl}
                    dimmed={Boolean(session.mobileConnected || isTerminal)}
                  />
                  <div className="small text-muted fw-semibold">
                    {session.mobileConnected
                      ? 'Mã QR đã được nhận trên điện thoại'
                      : isExpired
                        ? 'Mã QR đã hết hiệu lực'
                        : isCancelled
                          ? 'Mã QR đã bị hủy'
                          : 'Quét bằng Camera điện thoại'}
                  </div>
                </>
              ) : (
                <div className="py-4 px-2 text-muted small">
                  <i className="fas fa-mobile-alt fs-2 text-primary mb-2 d-block" />
                  {session.mobileConnected
                    ? 'Đang tiếp tục phiên xác minh trên điện thoại của bạn.'
                    : 'Phiên chờ trước đó không còn hiển thị mã QR vì lý do bảo mật. Hãy nhấn "Tạo lại mã QR" nếu chưa quét.'}
                </div>
              )}
            </div>

            {/* Right Column: Instructions, Warnings & Actions */}
            <div className="ekyc-qr-content">
              <p className="mb-2 text-dark fw-medium" style={{ fontSize: '0.9rem', lineHeight: 1.55 }}>
                Quét mã QR bằng camera điện thoại để tiếp tục xác minh danh tính. Vui lòng giữ trang này mở, kết quả xác minh sẽ được tự động cập nhật.
              </p>

              <ul className="small text-muted ps-3 mb-3" style={{ lineHeight: 1.65 }}>
                <li>Chuẩn bị sẵn <strong>thẻ Căn cước công dân (CCCD) bản gốc</strong>.</li>
                <li>Đảm bảo môi trường đủ ánh sáng, không chụp qua màn hình hoặc bản photo.</li>
                <li>Không cần đăng nhập lại tài khoản trên trình duyệt điện thoại.</li>
              </ul>

              {session.failureReason && (
                <div className="acc-alert-danger mb-3">
                  <i className="fas fa-exclamation-triangle flex-shrink-0" />
                  <span>{session.failureReason}</span>
                </div>
              )}

              {actionError && (
                <div className="acc-alert-danger mb-3">
                  <i className="fas fa-times-circle flex-shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}

              {/* Copy verification link (only while unclaimed & valid) */}
              {qrUrl && !session.mobileConnected && !isTerminal && (
                <div className="ekyc-copy-link-bar mb-3">
                  <i className="fas fa-link text-muted small flex-shrink-0" />
                  <span className="ekyc-copy-link-text" title="Đường dẫn xác minh một lần">
                    {maskVerificationUrlForDisplay(qrUrl)}
                  </span>
                  <button
                    type="button"
                    className={`ekyc-copy-link-btn ${copiedLink ? 'ekyc-copy-link-btn--copied' : ''}`}
                    onClick={handleCopyLink}
                  >
                    <i className={`fas ${copiedLink ? 'fa-check' : 'fa-copy'}`} />
                    <span>{copiedLink ? 'Đã sao chép' : 'Sao chép liên kết'}</span>
                  </button>
                </div>
              )}

              {/* Action Buttons */}
              <div className="d-flex flex-wrap gap-2 mt-2">
                {(isTerminal || (!qrUrl && !session.mobileConnected)) && (
                  <button
                    type="button"
                    className="ekyc-primary-btn"
                    onClick={() => handleStartVerification('QR')}
                    disabled={actionLoading}
                  >
                    {actionLoading ? (
                      <>
                        <span className="spinner-border spinner-border-sm" />
                        Đang tạo mã QR...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-redo-alt" />
                        Tạo lại mã QR
                      </>
                    )}
                  </button>
                )}

                {!isTerminal && (
                  <button
                    type="button"
                    className="ekyc-secondary-btn ekyc-cancel-btn"
                    onClick={handleCancelVerification}
                    disabled={actionLoading}
                  >
                    <i className="fas fa-times" />
                    Hủy xác minh
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 3. Default Unverified / Re-verification Needed View ──
  return (
    <div className="ekyc-desk-card">
      <div className="ekyc-desk-unverified-head">
        <div>
          <div className="fw-bold text-dark mb-1" style={{ fontSize: '1.02rem' }}>
            {reverificationRequired
              ? 'Cần xác minh lại danh tính (Giấy tờ đã hết hạn)'
              : 'Tài khoản chưa xác minh danh tính'}
          </div>
          <p className="text-muted small mb-0">
            {reverificationRequired
              ? accountStatus?.reverificationReason
              : 'Xác minh giấy tờ CCCD và xác thực khuôn mặt giúp bảo vệ tài khoản và tăng độ tin cậy khi giao dịch trên nền tảng.'}
          </p>
        </div>

        <span
          className={`ekyc-status-pill ${
            reverificationRequired ? 'ekyc-status-pill--warning' : 'ekyc-status-pill--unverified'
          }`}
        >
          <i className={`fas ${reverificationRequired ? 'fa-exclamation-circle' : 'fa-user-shield'}`} />
          {reverificationRequired ? 'Cần xác minh lại' : 'Chưa xác minh danh tính'}
        </span>
      </div>

      <div className="ekyc-benefits-grid">
        <div className="ekyc-benefit-item">
          <div className="ekyc-benefit-icon">
            <i className="fas fa-unlock-alt" />
          </div>
          <div className="ekyc-benefit-title">Mở khóa thuê &amp; đăng đồ</div>
          <p className="ekyc-benefit-desc">
            Cho phép gửi yêu cầu thuê vật phẩm, đăng sản phẩm cho thuê và ký hợp đồng điện tử hợp lệ.
          </p>
        </div>

        <div className="ekyc-benefit-item">
          <div className="ekyc-benefit-icon">
            <i className="fas fa-award" />
          </div>
          <div className="ekyc-benefit-title">Cộng +20 điểm Tin cậy</div>
          <p className="ekyc-benefit-desc">
            Tăng ngay điểm TrustScore và gắn huy hiệu Đã xác thực giúp giao dịch được duyệt nhanh hơn.
          </p>
        </div>

        <div className="ekyc-benefit-item">
          <div className="ekyc-benefit-icon">
            <i className="fas fa-shield-alt" />
          </div>
          <div className="ekyc-benefit-title">Bảo mật &amp; Nhanh chóng</div>
          <p className="ekyc-benefit-desc">
            Thực hiện nhanh chóng trên điện thoại; dữ liệu định danh được mã hóa và bảo mật an toàn.
          </p>
        </div>
      </div>

      {actionError && (
        <div className="acc-alert-danger mb-3">
          <i className="fas fa-times-circle" />
          <span>{actionError}</span>
        </div>
      )}

      <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
        <div className="d-flex flex-wrap align-items-center gap-2">
          <button
            type="button"
            className="ekyc-primary-btn"
            onClick={() => handleStartVerification(isMobileDevice ? 'DIRECT' : 'QR')}
            disabled={actionLoading}
          >
            {actionLoading ? (
              <>
                <span className="spinner-border spinner-border-sm" />
                Đang khởi tạo phiên...
              </>
            ) : (
              <>
                <i className={`fas ${isMobileDevice ? 'fa-camera' : 'fa-qrcode'}`} />
                Xác minh danh tính
              </>
            )}
          </button>

          {isMobileDevice && (
            <button
              type="button"
              className="ekyc-secondary-btn"
              onClick={() => handleStartVerification('QR')}
              disabled={actionLoading}
            >
              <i className="fas fa-qrcode" />
              Hiển thị mã QR cho máy khác
            </button>
          )}
        </div>

        <div className="ekyc-scope-note">
          <i className="fas fa-lock me-1 text-secondary" />
          Chuẩn bị thẻ CCCD bản gốc và điện thoại có camera hoạt động tốt.
        </div>
      </div>
    </div>
  );
}
