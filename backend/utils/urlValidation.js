// backend/utils/urlValidation.js
const ALLOWED_CLOUDINARY_HOST = 'res.cloudinary.com';
const MAX_URL_LENGTH = 2048;
const CLOUD_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const isValidCloudinaryImageUrl = (
  rawUrl,
  expectedCloudName = process.env.CLOUDINARY_CLOUD_NAME
) => {
  if (typeof rawUrl !== 'string') return false;

  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname.toLowerCase() !== ALLOWED_CLOUDINARY_HOST) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port) return false;

  const pathname = parsed.pathname || '';
  if (!pathname.startsWith('/') || pathname.includes('\\')) return false;

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  if (decodedPathname.includes('..') || decodedPathname.includes('\\')) {
    return false;
  }

  const segments = pathname.split('/').filter(Boolean);
  // Expected Cloudinary delivery path: /<cloud_name>/image/upload/<...asset_path>
  if (segments.length < 4) return false;

  const [cloudName, resourceType, deliveryType, ...rest] = segments;
  if (!CLOUD_NAME_PATTERN.test(cloudName)) return false;

  const normalizedExpectedCloud = typeof expectedCloudName === 'string'
    ? expectedCloudName.trim()
    : '';
  if (normalizedExpectedCloud && cloudName !== normalizedExpectedCloud) {
    return false;
  }

  if (resourceType !== 'image' || deliveryType !== 'upload') {
    return false;
  }

  if (rest.length === 0 || rest.some((seg) => seg === '.' || seg === '..')) {
    return false;
  }

  return true;
};

module.exports = {
  ALLOWED_CLOUDINARY_HOST,
  isValidCloudinaryImageUrl
};
