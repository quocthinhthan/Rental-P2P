// backend/middleware/ekycUpload.middleware.js
const multer = require('multer');
const { getEkycConfig } = require('../config/ekyc.config');

const buildMulterInstance = () => {
  const config = getEkycConfig();
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxImageBytes,
      files: 2,
      fields: 6,
      parts: 8
    }
  });
};

const wrapMulterHandler = (handlerFactory) => (req, res, next) => {
  const uploader = handlerFactory(buildMulterInstance());
  uploader(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.round((getEkycConfig().maxImageBytes / (1024 * 1024)) * 10) / 10;
        return res.status(400).json({
          code: 'IMAGE_TOO_LARGE',
          message: `Ảnh tải lên vượt quá dung lượng tối đa ${maxMb}MB. Vui lòng chụp lại ảnh nhẹ hơn.`
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
          code: 'INVALID_UPLOAD_FIELDS',
          message: 'Số lượng hoặc tên trường file tải lên không hợp lệ.'
        });
      }
      return res.status(400).json({
        code: 'UPLOAD_ERROR',
        message: 'Dữ liệu ảnh gửi lên không hợp lệ.'
      });
    }

    return res.status(400).json({
      code: 'UPLOAD_ERROR',
      message: 'Không thể xử lý dữ liệu ảnh tải lên.'
    });
  });
};

const uploadEkycDocuments = wrapMulterHandler((m) => m.fields([
  { name: 'frontImage', maxCount: 1 },
  { name: 'backImage', maxCount: 1 }
]));

const uploadEkycLiveness = wrapMulterHandler((m) => m.single('file'));

module.exports = {
  uploadEkycDocuments,
  uploadEkycLiveness
};
