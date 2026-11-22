// backend/routes/upload.routes.js
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const cloudinary = require('../config/cloudinary');
const upload = require('../middleware/upload');
const { protect } = require('../middleware/auth.middleware');
const { uploadLimiter } = require('../middleware/rateLimit.middleware');

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_PUBLIC_ID_LENGTH = 255;

const normalizePublicId = (rawPublicId) => {
  if (typeof rawPublicId !== 'string') return '';
  const trimmed = rawPublicId.trim();
  if (!trimmed || trimmed.length > MAX_PUBLIC_ID_LENGTH) return '';
  if (!PUBLIC_ID_PATTERN.test(trimmed)) return '';

  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return '';
  }

  return trimmed;
};

const canDeletePublicId = (publicId, user) => {
  if (!user || !user._id) return false;
  if (user.role === 'admin') return true;

  const segments = publicId.split('/');
  const userId = String(user._id);
  return segments.length >= 3 && segments[0] === 'users' && segments[1] === userId;
};

// Hàm helper để upload từ buffer lên Cloudinary trong phạm vi riêng của user
const uploadToCloudinary = (fileBuffer, userId) => {
  const safeUserId = String(userId);
  const publicId = `users/${safeUserId}/${crypto.randomUUID()}`;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        public_id: publicId,
        overwrite: false,
        context: { owner_id: safeUserId }
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
    uploadStream.end(fileBuffer);
  });
};

// POST /api/upload (yêu cầu đăng nhập)
router.post('/', uploadLimiter, protect, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }

  try {
    const result = await uploadToCloudinary(req.file.buffer, req.user._id);
    // Trả về URL an toàn của ảnh đã upload
    res.status(201).json({ imageUrl: result.secure_url, publicId: result.public_id });
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    res.status(500).json({ message: 'Error uploading image.', error: error.message });
  }
});

// POST /api/upload/delete (yêu cầu đăng nhập & kiểm tra quyền sở hữu)
router.post('/delete', uploadLimiter, protect, async (req, res) => {
  const rawPublicId = req.body?.publicId;
  if (!rawPublicId) {
    return res.status(400).json({ message: 'Missing publicId.' });
  }

  const publicId = normalizePublicId(rawPublicId);
  if (!publicId) {
    return res.status(400).json({ message: 'Invalid publicId.' });
  }

  if (!canDeletePublicId(publicId, req.user)) {
    return res.status(403).json({ message: 'Bạn không có quyền xóa ảnh này.' });
  }

  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    res.status(200).json({ result });
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    res.status(500).json({ message: 'Error deleting image.', error: error.message });
  }
});

router.normalizePublicId = normalizePublicId;
router.canDeletePublicId = canDeletePublicId;

module.exports = router;