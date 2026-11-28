// backend/services/viettelAi.provider.js
const axios = require('axios');
const FormData = require('form-data');
const { getEkycConfig } = require('../config/ekyc.config');
const { ALL_LIVENESS_POSES } = require('../enums/ekyc.enum');

/**
 * Documented ID Pack Spoof Check codes from Viettel AI Integration Guide (§2.5).
 */
const SPOOF_CHECK_ERROR_MAP = Object.freeze({
  241: {
    code: 'SPOOF_CORNER_CUT',
    category: 'INVALID_DOCUMENT',
    message: 'Ảnh CCCD có dấu hiệu bị cắt góc. Vui lòng sử dụng CCCD bản gốc nguyên vẹn và chụp lại.'
  },
  242: {
    code: 'SPOOF_PUNCHED',
    category: 'INVALID_DOCUMENT',
    message: 'Ảnh CCCD có dấu hiệu bị đục lỗ. Vui lòng sử dụng CCCD bản gốc còn hiệu lực.'
  },
  243: {
    code: 'SPOOF_PORTRAIT_OVERLAY',
    category: 'SUSPECTED_SPOOF',
    message: 'Phát hiện dấu hiệu bất thường tại vùng ảnh chân dung trên CCCD. Vui lòng chụp trực tiếp CCCD bản gốc.'
  },
  244: {
    code: 'SPOOF_COLOR_PRINT',
    category: 'SUSPECTED_SPOOF',
    message: 'Hệ thống nghi ngờ giấy tờ là bản in màu. Vui lòng sử dụng thẻ CCCD bản gốc.'
  },
  245: {
    code: 'SPOOF_EDITED_IMAGE',
    category: 'SUSPECTED_SPOOF',
    message: 'Ảnh giấy tờ có dấu hiệu qua chỉnh sửa kỹ thuật số. Vui lòng chụp trực tiếp bằng camera.'
  },
  246: {
    code: 'SPOOF_TAMPERED_FIELDS',
    category: 'SUSPECTED_SPOOF',
    message: 'Thông tin số giấy tờ hoặc họ tên có dấu hiệu bị che phủ/chỉnh sửa. Vui lòng kiểm tra và chụp lại CCCD bản gốc.'
  },
  247: {
    code: 'INVALID_INPUT_IMAGE',
    category: 'INVALID_IMAGE',
    message: 'Ảnh đầu vào không hợp lệ hoặc quá mờ/lóa. Vui lòng đặt CCCD trên nền phẳng, đủ sáng và chụp lại.'
  },
  260: {
    code: 'DOCUMENT_EXPIRED',
    category: 'EXPIRED_DOCUMENT',
    message: 'Căn cước công dân đã hết hạn sử dụng. Vui lòng sử dụng giấy tờ còn thời hạn hiệu lực.'
  },
  261: {
    code: 'NO_DOCUMENT_IN_FRAME',
    category: 'INVALID_IMAGE',
    message: 'Không tìm thấy thẻ CCCD trong khung hình. Vui lòng căn chỉnh thẻ nằm gọn trong khung hướng dẫn.'
  },
  262: {
    code: 'MULTIPLE_DOCUMENTS_IN_FRAME',
    category: 'INVALID_IMAGE',
    message: 'Phát hiện nhiều hơn 1 giấy tờ tùy thân trong ảnh. Vui lòng chỉ đặt duy nhất 1 thẻ CCCD vào khung chụp.'
  },
  264: {
    code: 'SPOOF_ID_NUMBER_EDITED',
    category: 'SUSPECTED_SPOOF',
    message: 'Số CCCD trên giấy tờ có dấu hiệu bị chỉnh sửa. Vui lòng sử dụng thẻ CCCD bản gốc.'
  },
  265: {
    code: 'SPOOF_SCREEN_RECAPTURE',
    category: 'SUSPECTED_SPOOF',
    message: 'Phát hiện ảnh chụp lại từ màn hình thiết bị khác. Vui lòng chụp trực tiếp thẻ CCCD vật lý bản gốc.'
  },
  266: {
    code: 'INVALID_EXPIRY_DATE',
    category: 'INVALID_DOCUMENT',
    message: 'Thông tin ngày hết hạn trên giấy tờ không hợp lệ. Vui lòng chụp lại rõ nét cả hai mặt CCCD.'
  },
  267: {
    code: 'SPOOF_PHOTOCOPY',
    category: 'SUSPECTED_SPOOF',
    message: 'Phát hiện giấy tờ là bản photocopy. Vui lòng sử dụng thẻ CCCD bản gốc để xác minh.'
  }
});

const KNOWN_NEGATIVE_LIVENESS_STRINGS = new Set([
  'false',
  '0',
  'fake',
  'spoof',
  'fail',
  'failed',
  'no',
  'invalid',
  'reject',
  'rejected',
  'wrong_pose',
  'not_match'
]);

const extractRequestId = (response) => {
  const bodyRequestId = response?.data?.request_id;
  if (typeof bodyRequestId === 'string' && bodyRequestId.trim()) {
    return bodyRequestId.trim();
  }
  const headerRequestId = response?.headers?.request_id || response?.headers?.['x-request-id'];
  if (typeof headerRequestId === 'string' && headerRequestId.trim()) {
    return headerRequestId.trim();
  }
  return '';
};

const safeLogProviderCall = ({ sessionId, api, pose = '', requestId, code, httpStatus, durationMs, outcome, extra = undefined }) => {
  const entry = {
    sessionId: String(sessionId || ''),
    api,
    ...(pose ? { pose } : {}),
    requestId: requestId || null,
    code: code ?? null,
    httpStatus: httpStatus ?? null,
    durationMs,
    outcome,
    ...(extra ? { extra } : {})
  };
  console.info('[eKYC][ViettelAI]', JSON.stringify(entry));
};

const classifyHttpOrCommonProviderFailure = ({ httpStatus, providerCode }) => {
  if (httpStatus === 401 || providerCode === 401) {
    return {
      errorCode: 'PROVIDER_AUTH_ERROR',
      category: 'CONFIG_ERROR',
      isTechnicalError: true,
      clientHttpStatus: 503,
      message: 'Dịch vụ xác minh danh tính tạm thời gián đoạn do lỗi xác thực kết nối. Vui lòng thử lại sau.'
    };
  }

  if (httpStatus === 429 || providerCode === 429 || httpStatus === 403 || providerCode === 403) {
    return {
      errorCode: 'PROVIDER_QUOTA_OR_FORBIDDEN',
      category: 'QUOTA_EXCEEDED',
      isTechnicalError: true,
      clientHttpStatus: 503,
      message: 'Hệ thống xác minh danh tính hiện đang quá tải hoặc hết hạn mức xử lý tạm thời. Vui lòng thử lại sau.'
    };
  }

  if (httpStatus >= 500 || providerCode === 500) {
    return {
      errorCode: 'PROVIDER_SERVER_ERROR',
      category: 'PROVIDER_SERVER_ERROR',
      isTechnicalError: true,
      clientHttpStatus: 502,
      message: 'Dịch vụ xác minh danh tính Viettel AI đang bận hoặc gặp sự cố tạm thời. Vui lòng thử lại sau ít phút.'
    };
  }

  if (httpStatus === 400 || providerCode === 400) {
    return {
      errorCode: 'INVALID_INPUT_IMAGE',
      category: 'INVALID_IMAGE',
      isTechnicalError: false,
      clientHttpStatus: 422,
      message: 'Dữ liệu hình ảnh hoặc tư thế gửi lên không hợp lệ. Vui lòng giữ khuôn mặt rõ nét trong khung và thực hiện đúng hướng dẫn.'
    };
  }

  return null;
};

/**
 * Evaluates Viettel AI `/ekyc/face_liveness` `verify_result` & `score` in strict fail-closed mode.
 *
 * Per specification (§6):
 * - Viettel AI docs declare `verify_result` as String without documenting exact pass/fail literals.
 * - Never blindly assume `"true"`, `"real"`, `"live"`, or an arbitrary score threshold.
 * - Reject (fail-closed) whenever the result cannot be deterministically verified against
 *   explicitly configured accepted values (`VIETTEL_AI_LIVENESS_ACCEPTED_VALUES`) or native boolean.
 */
const evaluateFaceLivenessOutcome = ({ rawVerifyResult, rawScore, config }) => {
  const numericScore = typeof rawScore === 'number' ? rawScore : Number.parseFloat(rawScore);
  const hasValidScore = Number.isFinite(numericScore) && numericScore >= 0 && numericScore <= 1;

  if (!hasValidScore) {
    return {
      determined: false,
      passed: false,
      isTechnicalError: true,
      errorCode: 'INVALID_LIVENESS_SCORE_PAYLOAD',
      score: null,
      message: 'Phản hồi điểm xác thực thực thể sống từ nhà cung cấp không hợp lệ.'
    };
  }

  const roundedScore = Math.round(numericScore * 10000) / 10000;
  const acceptedValues = Array.isArray(config.livenessAcceptedResults) ? config.livenessAcceptedResults : [];

  let isPositiveVerifyResult = false;
  let isDetermined = false;

  if (acceptedValues.length > 0) {
    // Compare strictly against explicitly configured accepted values
    const normalizedActual = rawVerifyResult === null || rawVerifyResult === undefined
      ? ''
      : String(rawVerifyResult).trim();
    if (!normalizedActual) {
      return {
        determined: false,
        passed: false,
        isTechnicalError: true,
        errorCode: 'UNDETERMINED_LIVENESS_RESULT',
        score: roundedScore,
        message: 'Không xác định được kết quả xác thực khuôn mặt. Vui lòng thử lại.'
      };
    }

    isDetermined = true;
    isPositiveVerifyResult = acceptedValues.includes(normalizedActual);
  } else if (typeof rawVerifyResult === 'boolean') {
    isDetermined = true;
    isPositiveVerifyResult = rawVerifyResult === true;
  } else if (typeof rawVerifyResult === 'string') {
    const trimmed = rawVerifyResult.trim();
    if (!trimmed) {
      isDetermined = false;
    } else if (KNOWN_NEGATIVE_LIVENESS_STRINGS.has(trimmed.toLowerCase())) {
      isDetermined = true;
      isPositiveVerifyResult = false;
    } else {
      // Fail-closed when `verify_result` is an unconfirmed string literal and
      // VIETTEL_AI_LIVENESS_ACCEPTED_VALUES has not yet been confirmed/configured.
      return {
        determined: false,
        passed: false,
        isTechnicalError: true,
        errorCode: 'UNCONFIRMED_LIVENESS_VERIFY_RESULT_LITERAL',
        observedLiteral: trimmed.slice(0, 40),
        score: roundedScore,
        message: 'Hệ thống xác thực khuôn mặt chưa hoàn tất cấu hình tham số kỹ thuật. Vui lòng liên hệ quản trị viên.'
      };
    }
  }

  if (!isDetermined) {
    return {
      determined: false,
      passed: false,
      isTechnicalError: true,
      errorCode: 'UNDETERMINED_LIVENESS_RESULT',
      score: roundedScore,
      message: 'Không xác định được kết quả xác thực khuôn mặt. Vui lòng thử lại.'
    };
  }

  if (!isPositiveVerifyResult) {
    return {
      determined: true,
      passed: false,
      isTechnicalError: false,
      errorCode: 'LIVENESS_POSE_FAILED',
      score: roundedScore,
      message: 'Hình ảnh xác thực khuôn mặt chưa đạt yêu cầu. Vui lòng thực hiện đúng hướng dẫn và chụp lại.'
    };
  }

  if (config.livenessMinScore !== null && numericScore < config.livenessMinScore) {
    return {
      determined: true,
      passed: false,
      isTechnicalError: false,
      errorCode: 'LIVENESS_SCORE_BELOW_POLICY',
      score: roundedScore,
      message: 'Hình ảnh khuôn mặt chưa đủ rõ nét. Vui lòng đảm bảo đủ ánh sáng và thực hiện lại.'
    };
  }

  return {
    determined: true,
    passed: true,
    isTechnicalError: false,
    errorCode: '',
    score: roundedScore
  };
};

const createViettelAiProvider = ({ httpClient = axios, configGetter = getEkycConfig } = {}) => {
  const executeMultipartPost = async ({ endpointPath, apiLabel, pose = '', extraHeaders = {}, sessionId, buildForm }) => {
    const config = configGetter();
    const startedAt = Date.now();

    if (!config.viettelToken) {
      const durationMs = Date.now() - startedAt;
      safeLogProviderCall({
        sessionId,
        api: apiLabel,
        pose,
        requestId: '',
        code: null,
        httpStatus: null,
        durationMs,
        outcome: 'CONFIG_TOKEN_MISSING'
      });
      return {
        transportOk: false,
        errorCode: 'PROVIDER_TOKEN_MISSING',
        category: 'CONFIG_ERROR',
        isTechnicalError: true,
        clientHttpStatus: 503,
        requestId: '',
        providerCode: null,
        httpStatus: null,
        durationMs,
        message: 'Tính năng xác minh danh tính hiện chưa sẵn sàng. Vui lòng liên hệ quản trị viên.'
      };
    }

    const form = new FormData();
    buildForm(form, config);

    try {
      const response = await httpClient.post(
        `${config.viettelBaseUrl}${endpointPath}`,
        form,
        {
          headers: {
            Accept: '*/*',
            ...extraHeaders,
            ...form.getHeaders()
          },
          timeout: config.timeoutMs,
          maxBodyLength: config.maxImageBytes * 3,
          maxContentLength: 5 * 1024 * 1024,
          validateStatus: () => true
        }
      );

      const durationMs = Date.now() - startedAt;
      const requestId = extractRequestId(response);
      const rawData = response?.data && typeof response.data === 'object' ? response.data : null;
      const providerCode = rawData && rawData.code !== undefined && rawData.code !== null
        ? Number(rawData.code)
        : null;

      return {
        transportOk: true,
        httpStatus: response.status,
        providerCode: Number.isFinite(providerCode) ? providerCode : null,
        requestId,
        durationMs,
        data: rawData,
        config
      };
    } catch (err) {
      // Never log or rethrow raw AxiosError (its config holds multipart FormData with token & buffers)
      const durationMs = Date.now() - startedAt;
      const isTimeout = err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(String(err?.message || ''));

      safeLogProviderCall({
        sessionId,
        api: apiLabel,
        pose,
        requestId: '',
        code: null,
        httpStatus: null,
        durationMs,
        outcome: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR'
      });

      if (isTimeout) {
        return {
          transportOk: false,
          errorCode: 'PROVIDER_TIMEOUT',
          category: 'PROVIDER_TIMEOUT',
          isTechnicalError: true,
          clientHttpStatus: 504,
          requestId: '',
          providerCode: null,
          httpStatus: null,
          durationMs,
          message: 'Quá thời gian chờ phản hồi từ dịch vụ xác minh danh tính. Vui lòng kiểm tra kết nối mạng và thử lại.'
        };
      }

      return {
        transportOk: false,
        errorCode: 'PROVIDER_NETWORK_ERROR',
        category: 'NETWORK_ERROR',
        isTechnicalError: true,
        clientHttpStatus: 502,
        requestId: '',
        providerCode: null,
        httpStatus: null,
        durationMs,
        message: 'Không thể kết nối tới dịch vụ xác minh danh tính. Vui lòng thử lại sau ít phút.'
      };
    }
  };

  /**
   * 1. ID Pack Spoof Check: POST /ekyc/id_pack_spoof_check
   * Form fields: token, image (front), image_other (back)
   */
  const checkIdPackSpoof = async ({ frontImage, backImage, sessionId }) => {
    const res = await executeMultipartPost({
      endpointPath: '/ekyc/id_pack_spoof_check',
      apiLabel: 'id_pack_spoof_check',
      sessionId,
      buildForm: (form, config) => {
        form.append('token', config.viettelToken);
        form.append('image', frontImage.buffer, {
          filename: `front.${frontImage.extension || 'jpg'}`,
          contentType: frontImage.mimeType || 'image/jpeg'
        });
        form.append('image_other', backImage.buffer, {
          filename: `back.${backImage.extension || 'jpg'}`,
          contentType: backImage.mimeType || 'image/jpeg'
        });
      }
    });

    if (!res.transportOk) {
      return { passed: false, ...res };
    }

    const isHttpOk = res.httpStatus >= 200 && res.httpStatus < 300;
    if (isHttpOk && res.providerCode === 1) {
      safeLogProviderCall({
        sessionId,
        api: 'id_pack_spoof_check',
        requestId: res.requestId,
        code: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        outcome: 'PASSED'
      });

      return {
        passed: true,
        requestId: res.requestId,
        providerCode: 1,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs
      };
    }

    const commonFailure = classifyHttpOrCommonProviderFailure({
      httpStatus: res.httpStatus,
      providerCode: res.providerCode
    });

    if (commonFailure) {
      safeLogProviderCall({
        sessionId,
        api: 'id_pack_spoof_check',
        requestId: res.requestId,
        code: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        outcome: commonFailure.errorCode
      });
      return {
        passed: false,
        requestId: res.requestId,
        providerCode: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        ...commonFailure
      };
    }

    const mappedSpoof = SPOOF_CHECK_ERROR_MAP[res.providerCode];
    const errorCode = mappedSpoof ? mappedSpoof.code : 'SPOOF_CHECK_REJECTED';
    const category = mappedSpoof ? mappedSpoof.category : 'INVALID_DOCUMENT';
    const message = mappedSpoof
      ? mappedSpoof.message
      : 'Giấy tờ tùy thân không vượt qua bước kiểm tra tính hợp lệ. Vui lòng dùng CCCD bản gốc, đặt nơi đủ sáng và chụp lại.';

    safeLogProviderCall({
      sessionId,
      api: 'id_pack_spoof_check',
      requestId: res.requestId,
      code: res.providerCode,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      outcome: errorCode
    });

    return {
      passed: false,
      errorCode,
      category,
      isTechnicalError: false,
      clientHttpStatus: 422,
      requestId: res.requestId,
      providerCode: res.providerCode,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      message
    };
  };

  /**
   * 2. Document OCR: POST /ekyc/id_card
   * Form fields: image_front, image_back, token
   */
  const extractIdCardOcr = async ({ frontImage, backImage, sessionId }) => {
    const res = await executeMultipartPost({
      endpointPath: '/ekyc/id_card',
      apiLabel: 'id_card',
      sessionId,
      buildForm: (form, config) => {
        form.append('image_front', frontImage.buffer, {
          filename: `front.${frontImage.extension || 'jpg'}`,
          contentType: frontImage.mimeType || 'image/jpeg'
        });
        form.append('image_back', backImage.buffer, {
          filename: `back.${backImage.extension || 'jpg'}`,
          contentType: backImage.mimeType || 'image/jpeg'
        });
        form.append('token', config.viettelToken);
      }
    });

    if (!res.transportOk) {
      return { passed: false, ...res };
    }

    const isHttpOk = res.httpStatus >= 200 && res.httpStatus < 300;
    if (!isHttpOk || res.providerCode !== 1) {
      const commonFailure = classifyHttpOrCommonProviderFailure({
        httpStatus: res.httpStatus,
        providerCode: res.providerCode
      });

      const failure = commonFailure || {
        errorCode: 'OCR_RECOGNITION_FAILED',
        category: 'OCR_FAILED',
        isTechnicalError: false,
        clientHttpStatus: 422,
        message: 'Không thể đọc rõ thông tin trên CCCD. Vui lòng đặt thẻ phẳng, tránh bóng lóa và chụp lại cả hai mặt.'
      };

      safeLogProviderCall({
        sessionId,
        api: 'id_card',
        requestId: res.requestId,
        code: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        outcome: failure.errorCode
      });

      return {
        passed: false,
        requestId: res.requestId,
        providerCode: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        ...failure
      };
    }

    let information = res.data?.information;
    if (typeof information === 'string') {
      try {
        information = JSON.parse(information);
      } catch {
        information = null;
      }
    }

    if (!information || typeof information !== 'object' || Array.isArray(information)) {
      safeLogProviderCall({
        sessionId,
        api: 'id_card',
        requestId: res.requestId,
        code: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        outcome: 'OCR_INVALID_PAYLOAD'
      });

      return {
        passed: false,
        errorCode: 'OCR_INVALID_PAYLOAD',
        category: 'OCR_FAILED',
        isTechnicalError: false,
        clientHttpStatus: 422,
        requestId: res.requestId,
        providerCode: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        message: 'Không nhận dạng được đầy đủ thông tin từ ảnh CCCD. Vui lòng chụp lại rõ nét hơn.'
      };
    }

    safeLogProviderCall({
      sessionId,
      api: 'id_card',
      requestId: res.requestId,
      code: res.providerCode,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      outcome: 'PASSED'
    });

    return {
      passed: true,
      requestId: res.requestId,
      providerCode: 1,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      information
    };
  };

  /**
   * 3. Face Liveness Detection: POST /ekyc/face_liveness
   * Form fields: file (face image), token, label_pose ('Portrait' | 'Left' | 'Right' | 'Top' | 'Bottom')
   */
  const checkFaceLiveness = async ({ image, labelPose, sessionId }) => {
    if (!ALL_LIVENESS_POSES.includes(labelPose)) {
      return {
        passed: false,
        errorCode: 'INVALID_LIVENESS_POSE',
        category: 'VALIDATION_ERROR',
        isTechnicalError: false,
        clientHttpStatus: 400,
        requestId: '',
        providerCode: null,
        httpStatus: null,
        durationMs: 0,
        message: 'Giá trị tư thế khuôn mặt (label_pose) không hợp lệ.'
      };
    }

    const cfgSnapshot = configGetter();
    const extraHeaders = cfgSnapshot.livenessCookie
      ? { Cookie: cfgSnapshot.livenessCookie }
      : {};

    const res = await executeMultipartPost({
      endpointPath: '/ekyc/face_liveness',
      apiLabel: 'face_liveness',
      pose: labelPose,
      extraHeaders,
      sessionId,
      buildForm: (form, cfg) => {
        form.append('file', image.buffer, {
          filename: `liveness-${labelPose.toLowerCase()}.${image.extension || 'jpg'}`,
          contentType: image.mimeType || 'image/jpeg'
        });
        form.append('token', cfg.viettelToken);
        form.append('label_pose', labelPose);
      }
    });

    if (!res.transportOk) {
      return { passed: false, ...res };
    }

    const isHttpOk = res.httpStatus >= 200 && res.httpStatus < 300;
    if (!isHttpOk || res.providerCode !== 1) {
      const commonFailure = classifyHttpOrCommonProviderFailure({
        httpStatus: res.httpStatus,
        providerCode: res.providerCode
      });

      const providerViMsg = typeof res.data?.vi_message === 'string' && res.data.vi_message.trim()
        ? res.data.vi_message.trim().slice(0, 200)
        : '';

      const failure = commonFailure || {
        errorCode: 'LIVENESS_POSE_FAILED',
        category: 'LIVENESS_FAILED',
        isTechnicalError: false,
        clientHttpStatus: 422,
        message: providerViMsg
          || 'Tư thế khuôn mặt chưa đúng hoặc ảnh chụp không rõ. Vui lòng giữ khuôn mặt trong khung oval và thực hiện lại đúng hướng dẫn.'
      };

      safeLogProviderCall({
        sessionId,
        api: 'face_liveness',
        pose: labelPose,
        requestId: res.requestId,
        code: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        outcome: failure.errorCode
      });

      return {
        passed: false,
        requestId: res.requestId,
        providerCode: res.providerCode,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        score: null,
        ...failure
      };
    }

    const evaluated = evaluateFaceLivenessOutcome({
      rawVerifyResult: res.data?.verify_result,
      rawScore: res.data?.score,
      config: res.config
    });

    safeLogProviderCall({
      sessionId,
      api: 'face_liveness',
      pose: labelPose,
      requestId: res.requestId,
      code: res.providerCode,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      outcome: evaluated.passed ? 'PASSED' : evaluated.errorCode,
      extra: evaluated.observedLiteral ? { observedVerifyResult: evaluated.observedLiteral } : undefined
    });

    if (!evaluated.passed) {
      return {
        passed: false,
        errorCode: evaluated.errorCode,
        category: evaluated.isTechnicalError ? 'PROVIDER_CONTRACT_UNCONFIRMED' : 'LIVENESS_FAILED',
        isTechnicalError: evaluated.isTechnicalError,
        clientHttpStatus: evaluated.isTechnicalError ? 502 : 422,
        requestId: res.requestId,
        providerCode: 1,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        score: evaluated.score,
        message: evaluated.message
      };
    }

    return {
      passed: true,
      requestId: res.requestId,
      providerCode: 1,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      score: evaluated.score
    };
  };

  return {
    checkIdPackSpoof,
    extractIdCardOcr,
    checkFaceLiveness
  };
};

const defaultViettelAiProvider = createViettelAiProvider();

module.exports = {
  SPOOF_CHECK_ERROR_MAP,
  evaluateFaceLivenessOutcome,
  createViettelAiProvider,
  defaultViettelAiProvider
};
