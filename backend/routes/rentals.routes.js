// backend/routes/rentals.routes.js
const express = require('express');
const router = express.Router();
const {
  createRentalRequest,
  createVNPayUrl,
  handleVNPayReturn,
  confirmRental,
  rejectRental,
  cancelRental,
  completeRental,
  checkRentalOwner,
  signContract,
  pickupItem,
  getContractByRentalId,
  sendMessage,
  getMessages,
  getRentalDetail,
  approvePickup,
  approveReturn
} = require('../controllers/rentals.controller');
const { protect, checkVerified } = require('../middleware/auth.middleware');

// POST /api/rentals - (Renter) Tạo yêu cầu
router.post('/', protect, checkVerified, createRentalRequest);

// GET /api/rentals/vnpay-return - VNPay redirect callback
router.get('/vnpay-return', handleVNPayReturn);

// GET /api/rentals/:id - (Renter/Owner/Admin) Lấy chi tiết đơn thuê
router.get('/:id', protect, getRentalDetail);

// POST /api/rentals/:id/create-vnpay-url - (Renter) Create VNPay payment URL
router.post('/:id/create-vnpay-url', protect, createVNPayUrl);

// PATCH /api/rentals/:id/confirm - (Owner) Xác nhận
router.patch('/:id/confirm', protect, checkRentalOwner, confirmRental);

// PATCH /api/rentals/:id/reject - (Owner) Từ chối
router.patch('/:id/reject', protect, checkRentalOwner, rejectRental);

// PATCH /api/rentals/:id/cancel - (Renter/Owner/Admin) Cancel before handover
router.patch('/:id/cancel', protect, cancelRental);

// Participants can record return and approve handovers even if eKYC expires mid-rental.
router.patch('/:id/complete', protect, completeRental);

// [CẢ 2 BÊN] Ký hợp đồng điện tử
router.post('/:id/sign-contract', protect, checkVerified, signContract);

// Ghi nhận biên bản nhận đồ. Trạng thái chỉ đổi khi bên còn lại duyệt.
router.patch('/:id/pickup', protect, checkVerified, pickupItem);

// [CẢ 2 BÊN] Xác nhận bàn giao đồ
router.patch('/:id/approve-pickup', protect, approvePickup);

// [CẢ 2 BÊN] Xác nhận hoàn trả đồ
router.patch('/:id/approve-return', protect, approveReturn);

// [CẢ 2 BÊN] Lấy thông tin Hợp đồng để hiển thị lên màn hình
router.get('/:id/contract', protect, getContractByRentalId);

router.post('/:id/messages', protect, sendMessage);

router.get('/:id/messages', protect, getMessages);

module.exports = router;
