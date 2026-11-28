// backend/utils/imageValidator.js
const crypto = require('crypto');
const { getEkycConfig } = require('../config/ekyc.config');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf
]);

const parsePngDimensions = (buffer) => {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { mimeType: 'image/png', extension: 'png', width, height };
};

const parseJpegDimensions = (buffer) => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return null;
  }

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    // Skip padding 0xFF bytes
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;

    // Standalone markers without length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    // SOS or EOI reached before SOF
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      return { mimeType: 'image/jpeg', extension: 'jpg', width, height };
    }

    offset += segmentLength;
  }

  return null;
};

const parseWebpDimensions = (buffer) => {
  if (
    buffer.length < 30
    || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null;
  }

  const chunkHeader = buffer.subarray(12, 16).toString('ascii');
  if (chunkHeader === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    if (!width || !height) return null;
    return { mimeType: 'image/webp', extension: 'webp', width, height };
  }

  if (chunkHeader === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null;
    }
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (!width || !height) return null;
    return { mimeType: 'image/webp', extension: 'webp', width, height };
  }

  if (chunkHeader === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (!width || !height) return null;
    return { mimeType: 'image/webp', extension: 'webp', width, height };
  }

  return null;
};

const inspectImageBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;
  return parseJpegDimensions(buffer) || parsePngDimensions(buffer) || parseWebpDimensions(buffer);
};

/**
 * Strictly validates real binary content, byte size, and image dimensions
 * without trusting client filename or MIME header.
 */
const validateEkycImageBuffer = (buffer, fieldLabel = 'Ảnh tải lên') => {
  const config = getEkycConfig();

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      valid: false,
      code: 'MISSING_IMAGE',
      message: `${fieldLabel} không tồn tại hoặc bị trống.`
    };
  }

  if (buffer.length < config.minImageBytes) {
    return {
      valid: false,
      code: 'IMAGE_TOO_SMALL',
      message: `${fieldLabel} có dung lượng quá nhỏ hoặc bị hỏng. Vui lòng chụp lại rõ nét.`
    };
  }

  if (buffer.length > config.maxImageBytes) {
    const maxMb = Math.round((config.maxImageBytes / (1024 * 1024)) * 10) / 10;
    return {
      valid: false,
      code: 'IMAGE_TOO_LARGE',
      message: `${fieldLabel} vượt quá giới hạn ${maxMb}MB. Vui lòng chụp lại ảnh nhẹ hơn.`
    };
  }

  const parsed = inspectImageBuffer(buffer);
  if (!parsed) {
    return {
      valid: false,
      code: 'UNSUPPORTED_IMAGE_FORMAT',
      message: `${fieldLabel} không đúng định dạng ảnh hợp lệ (chỉ hỗ trợ JPEG, PNG, WebP).`
    };
  }

  if (parsed.width < config.minImageWidth || parsed.height < config.minImageHeight) {
    return {
      valid: false,
      code: 'IMAGE_RESOLUTION_TOO_LOW',
      message: `${fieldLabel} có độ phân giải quá thấp (${parsed.width}x${parsed.height}). Vui lòng chụp gần và rõ nét hơn.`
    };
  }

  if (
    parsed.width > config.maxImageWidth
    || parsed.height > config.maxImageHeight
    || parsed.width * parsed.height > config.maxImagePixels
  ) {
    return {
      valid: false,
      code: 'IMAGE_RESOLUTION_TOO_HIGH',
      message: `${fieldLabel} vượt quá kích thước điểm ảnh cho phép.`
    };
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    valid: true,
    mimeType: parsed.mimeType,
    extension: parsed.extension,
    width: parsed.width,
    height: parsed.height,
    byteLength: buffer.length,
    sha256
  };
};

module.exports = {
  inspectImageBuffer,
  validateEkycImageBuffer
};
