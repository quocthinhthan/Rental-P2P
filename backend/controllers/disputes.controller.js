// backend/controllers/disputes.controller.js
const mongoose = require('mongoose');
const Dispute = require('../models/Dispute.model');
const Rental = require('../models/Rental.model');
const Item = require('../models/Item.model');
const User = require('../models/User.model');
const AuditLog = require('../models/AuditLog.model');
const { RentalStatus, PaymentStatus } = require('../enums/rental.enum');
const { DisputeStatus, PenaltyType, DisputeWinner } = require('../enums/dispute.enum');
const { ItemStatus } = require('../enums/item.enum');
const trustScoreService = require('../services/trustScore.service');
const { syncItemRuntimeStatus } = require('../services/itemAvailability.service');
const {
  ACTIVE_DISPUTE_STATUSES,
  canCreateDisputeForRental,
  getCompletionAt,
  getRecordedCompletionAt,
  isActiveDispute,
  isDisputeReporter
} = require('../services/rentalActions.service');

const MEDIATION_WINDOW_HOURS = 48;
const SUSPENSION_DAYS = 7;
const TRANSACTION_UNSUPPORTED_REGEX = /Transaction numbers are only allowed|replica set member|Transaction.*not supported/i;
const CONFLICT_MESSAGE = 'Tranh chấp đã thay đổi trạng thái trước đó, vui lòng tải lại.';

class DisputeConflictError extends Error {
  constructor(message = CONFLICT_MESSAGE) {
    super(message);
    this.name = 'DisputeConflictError';
  }
}

const runWithOptionalTransaction = async (work) => {
  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (error instanceof DisputeConflictError || !TRANSACTION_UNSUPPORTED_REGEX.test(error?.message || '')) {
      throw error;
    }

    return work(null);
  } finally {
    await session.endSession();
  }
};

const writeDisputeAuditLog = async ({ req, dispute, before, after, reason, metadata = {} }) => {
  try {
    await AuditLog.create({
      actorId: req.user._id,
      action: 'admin.dispute.resolve',
      targetType: 'Dispute',
      targetId: dispute._id,
      before,
      after,
      reason,
      metadata
    });
  } catch (error) {
    console.error('[DisputeAuditLog] Failed to create audit log:', error);
  }
};

const isRentalParty = (rental, userId) => (
  rental.renterId.equals(userId) || rental.ownerId.equals(userId)
);

const getFallbackRestoreStatuses = (rental) => {
  const now = new Date();

  if (rental.endDate && now > new Date(rental.endDate)) {
    return {
      rentalStatus: RentalStatus.COMPLETED,
      itemStatus: ItemStatus.AVAILABLE
    };
  }

  if (rental.startDate && now < new Date(rental.startDate)) {
    return {
      rentalStatus: RentalStatus.CONFIRMED,
      itemStatus: ItemStatus.RENTED
    };
  }

  return {
    rentalStatus: RentalStatus.IN_PROGRESS,
    itemStatus: ItemStatus.RENTED
  };
};

const getRestoreStatuses = (dispute, rental) => {
  const fallback = getFallbackRestoreStatuses(rental);

  return {
    rentalStatus: dispute.previousRentalStatus && dispute.previousRentalStatus !== RentalStatus.DISPUTED
      ? dispute.previousRentalStatus
      : fallback.rentalStatus,
    itemStatus: dispute.previousItemStatus || fallback.itemStatus
  };
};

const applyPenalty = async (userToPenalize, penaltyType, { session = null } = {}) => {
  if (penaltyType === PenaltyType.NONE) {
    return null;
  }

  if (!userToPenalize) {
    return null;
  }

  switch (penaltyType) {
    case PenaltyType.WARNING:
      break;
    case PenaltyType.SUSPENSION: {
      const suspendedUntil = new Date();
      suspendedUntil.setDate(suspendedUntil.getDate() + SUSPENSION_DAYS);
      userToPenalize.suspendedUntil = suspendedUntil;
      break;
    }
    case PenaltyType.BAN:
      userToPenalize.isBanned = true;
      break;
    default:
      break;
  }

  await userToPenalize.save(session ? { session } : undefined);
  return userToPenalize;
};

const createDisputeAndFreezeRental = (disputePayload, rental) => (
  runWithOptionalTransaction(async (session) => {
    if (!canCreateDisputeForRental(rental)) {
      throw new DisputeConflictError('Đơn thuê đã hết hạn khiếu nại.');
    }

    const { modifiedCount } = await Rental.updateOne(
      { _id: rental._id, status: rental.status },
      { $set: { status: RentalStatus.DISPUTED } },
      session ? { session } : undefined
    );
    if (!modifiedCount) {
      throw new DisputeConflictError('Đơn thuê đã thay đổi trạng thái, vui lòng tải lại.');
    }

    try {
      if (!session) return await Dispute.create(disputePayload);
      const [dispute] = await Dispute.create([disputePayload], { session });
      return dispute;
    } catch (error) {
      // MongoDB standalone does not roll back the rental update.
      if (!session) {
        await Rental.updateOne(
          { _id: rental._id, status: RentalStatus.DISPUTED },
          { $set: { status: rental.status } }
        );
      }
      throw error;
    }
  })
);

// [USER] POST /api/disputes - Báo cáo sự cố và đóng băng đơn thuê
exports.createDispute = async (req, res) => {
  const { rentalId, reason, evidenceImages } = req.body;
  const reporterId = req.user._id;

  try {
    if (!mongoose.Types.ObjectId.isValid(rentalId)) {
      return res.status(400).json({ message: 'Mã đơn thuê không hợp lệ' });
    }

    if (!reason) {
      return res.status(400).json({ message: 'Vui lòng nhập lý do khiếu nại' });
    }

    const rental = await Rental.findById(rentalId);
    if (!rental) {
      return res.status(404).json({ message: 'Không tìm thấy đơn thuê' });
    }

    if (!isRentalParty(rental, reporterId)) {
      return res.status(403).json({ message: 'Bạn không thuộc giao dịch này' });
    }

    if (rental.status === RentalStatus.DISPUTED) {
      return res.status(400).json({ message: 'Đơn thuê đang trong trạng thái tranh chấp' });
    }

    if (!canCreateDisputeForRental(rental)) {
      return res.status(400).json({
        message: 'Chỉ có thể tạo tranh chấp cho đơn đã xác nhận, đang diễn ra, hoặc vừa hoàn tất trong 7 ngày'
      });
    }

    const activeDispute = await Dispute.findOne({
      rentalId,
      status: { $in: ACTIVE_DISPUTE_STATUSES }
    });

    if (activeDispute) {
      return res.status(400).json({ message: 'Đơn thuê đang có khiếu nại chưa xử lý' });
    }

    const item = await Item.findById(rental.itemId);
    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tài sản của đơn thuê' });
    }

    const now = new Date();
    const mediationEndsAt = new Date(now.getTime() + MEDIATION_WINDOW_HOURS * 60 * 60 * 1000);

    // Lưu snapshot trước khi freeze để withdraw/resolve none có thể restore chính xác.
    const dispute = await createDisputeAndFreezeRental({
      rentalId,
      reporterId,
      reason,
      evidenceImages: evidenceImages || [],
      previousRentalStatus: rental.status,
      previousItemStatus: item.status,
      mediationEndsAt,
      status: DisputeStatus.PENDING
    }, rental);

    res.status(201).json({
      message: 'Đã báo cáo sự cố. Đơn thuê đã bị đóng băng trong thời gian hòa giải.',
      dispute
    });
  } catch (error) {
    if (error instanceof DisputeConflictError) {
      return res.status(409).json({ message: error.message });
    }
    res.status(500).json({ message: 'Lỗi máy chủ', error: error.message });
  }
};

// [ADMIN] GET /api/disputes - Xem tất cả sự cố
exports.getAllDisputes = async (req, res) => {
  try {
    const filter = {};

    if (req.query.status) {
      if (!Object.values(DisputeStatus).includes(req.query.status)) {
        return res.status(400).json({ message: 'Trạng thái tranh chấp không hợp lệ' });
      }
      filter.status = req.query.status;
    }

    const disputes = await Dispute.find(filter)
      .sort({ createdAt: -1 })
      .populate('reporterId', 'fullName email phoneNumber phone')
      .populate('escalatedBy', 'fullName email')
      .populate('resolvedBy', 'fullName email')
      .populate('penalizeUserId', 'fullName email trustScore isBanned suspendedUntil')
      .populate({
        path: 'rentalId',
        populate: [
          { path: 'renterId', select: 'fullName email phoneNumber phone trustScore' },
          { path: 'ownerId', select: 'fullName email phoneNumber phone trustScore' },
          { path: 'itemId', select: 'code name images status ownerId pricePerDay baseValue' }
        ]
      });

    res.status(200).json(disputes);
  } catch (error) {
    res.status(500).json({ message: 'Lỗi máy chủ', error: error.message });
  }
};

// [USER] PATCH /api/disputes/:id/escalate - Yêu cầu admin can thiệp sau 48 giờ
exports.escalateDispute = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Mã tranh chấp không hợp lệ' });
    }

    const dispute = await Dispute.findById(req.params.id);
    if (!dispute) {
      return res.status(404).json({ message: 'Không tìm thấy sự cố' });
    }

    const rental = await Rental.findById(dispute.rentalId);
    if (!rental) {
      return res.status(404).json({ message: 'Không tìm thấy đơn thuê' });
    }

    if (!isRentalParty(rental, req.user._id)) {
      return res.status(403).json({ message: 'Chỉ người thuê hoặc chủ đồ trong giao dịch mới được yêu cầu can thiệp' });
    }

    if (dispute.status !== DisputeStatus.PENDING) {
      return res.status(400).json({ message: 'Chỉ có thể yêu cầu can thiệp khiếu nại đang trong giai đoạn hòa giải' });
    }

    const now = new Date();
    const mediationEndsAt = dispute.mediationEndsAt || new Date(dispute.createdAt.getTime() + MEDIATION_WINDOW_HOURS * 60 * 60 * 1000);

    if (now < mediationEndsAt) {
      return res.status(400).json({
        message: 'Chỉ có thể yêu cầu admin can thiệp sau khi hết 48 giờ hòa giải',
        mediationEndsAt
      });
    }

    const updatedDispute = await Dispute.findOneAndUpdate(
      { _id: dispute._id, status: DisputeStatus.PENDING },
      {
        $set: {
          status: DisputeStatus.ESCALATED,
          escalatedAt: now,
          escalatedBy: req.user._id
        }
      },
      { new: true }
    );

    if (!updatedDispute) {
      return res.status(409).json({
        message: CONFLICT_MESSAGE
      });
    }

    res.status(200).json({
      message: 'Đã chuyển tranh chấp lên admin. Admin sẽ xem xét và đưa ra phán quyết.',
      dispute: updatedDispute
    });
  } catch (error) {
    res.status(500).json({ message: 'Lỗi máy chủ', error: error.message });
  }
};

// [ADMIN] PATCH /api/disputes/:id/resolve - Phán quyết cuối cùng
exports.resolveDispute = async (req, res) => {
  const { id } = req.params;
  const { adminDecision, winner, penalizeUserId } = req.body;
  const penaltyType = req.body.penaltyType || PenaltyType.NONE;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Mã tranh chấp không hợp lệ' });
    }

    if (!adminDecision) {
      return res.status(400).json({ message: 'Vui lòng nhập phán quyết của admin' });
    }

    if (!Object.values(DisputeWinner).includes(winner)) {
      return res.status(400).json({ message: 'Người thắng phải là người thuê, chủ sở hữu hoặc không có ai' });
    }

    if (!Object.values(PenaltyType).includes(penaltyType)) {
      return res.status(400).json({ message: 'Loại chế tài không hợp lệ' });
    }

    if (winner === DisputeWinner.NONE && penaltyType !== PenaltyType.NONE) {
      return res.status(400).json({ message: 'winner = none chỉ được đi kèm penaltyType = none' });
    }

    const dispute = await Dispute.findById(id);
    if (!dispute) {
      return res.status(404).json({ message: 'Không tìm thấy hồ sơ sự cố' });
    }

    if (dispute.status === DisputeStatus.RESOLVED) {
      return res.status(400).json({ message: 'Tranh chấp này đã được giải quyết' });
    }

    if (dispute.status === DisputeStatus.WITHDRAWN) {
      return res.status(400).json({ message: 'Khiếu nại đã được rút, không thể giải quyết' });
    }

    const rental = await Rental.findById(dispute.rentalId);
    if (!rental) {
      return res.status(404).json({ message: 'Không tìm thấy đơn thuê' });
    }

    const item = await Item.findById(rental.itemId);
    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tài sản của đơn thuê' });
    }

    let userToPenalize = null;
    if (penaltyType !== PenaltyType.NONE) {
      if (!penalizeUserId || !mongoose.Types.ObjectId.isValid(penalizeUserId)) {
        return res.status(400).json({ message: 'penalizeUserId là bắt buộc khi có chế tài' });
      }

      // MVP chỉ cho phạt người liên quan trực tiếp đến rental tranh chấp.
      if (!rental.renterId.equals(penalizeUserId) && !rental.ownerId.equals(penalizeUserId)) {
        return res.status(400).json({ message: 'Chỉ có thể phạt người thuê hoặc chủ sở hữu của đơn thuê này' });
      }

      userToPenalize = await User.findById(penalizeUserId);
      if (!userToPenalize) {
        return res.status(404).json({ message: 'Không tìm thấy người bị áp dụng chế tài' });
      }
    }

    const before = {
      disputeStatus: dispute.status,
      rentalStatus: rental.status,
      paymentStatus: rental.paymentStatus,
      itemStatus: item.status,
      itemDelistedByAdmin: Boolean(item.delistedByAdmin)
    };

    const rentalUpdate = {};

    if (winner === DisputeWinner.RENTER) {
      if (rental.paymentStatus === PaymentStatus.ESCROWED) {
        rentalUpdate.paymentStatus = PaymentStatus.REFUNDED;
      }

      // paymentStatus thể hiện đã hoàn tiền; rental.status thể hiện đơn bị hủy/kết thúc theo dispute.
      rentalUpdate.status = Object.prototype.hasOwnProperty.call(RentalStatus, 'REFUNDED')
        ? RentalStatus.REFUNDED
        : RentalStatus.CANCELLED;
    } else if (winner === DisputeWinner.OWNER) {
      rentalUpdate.status = RentalStatus.COMPLETED;
    } else {
      rentalUpdate.status = getRestoreStatuses(dispute, rental).rentalStatus;
    }

    const { resolvedDispute, syncedItem } = await runWithOptionalTransaction(async (session) => {
      const claimedDispute = await Dispute.findOneAndUpdate(
        { _id: dispute._id, status: { $in: ACTIVE_DISPUTE_STATUSES } },
        {
          $set: {
            status: DisputeStatus.RESOLVED,
            adminDecision,
            winner,
            penalizeUserId: penaltyType === PenaltyType.NONE ? null : penalizeUserId,
            penaltyType,
            resolvedBy: req.user._id,
            resolvedAt: new Date()
          }
        },
        { new: true, ...(session ? { session } : {}) }
      );

      if (!claimedDispute) {
        throw new DisputeConflictError(CONFLICT_MESSAGE);
      }

      if (rentalUpdate.status === RentalStatus.COMPLETED && !rental.completedAt) {
        const firstCompletionByAdmin = winner === DisputeWinner.OWNER &&
          [RentalStatus.CONFIRMED, RentalStatus.IN_PROGRESS].includes(dispute.previousRentalStatus);
        rentalUpdate.completedAt = getRecordedCompletionAt(rental) ||
          (firstCompletionByAdmin ? claimedDispute.resolvedAt : getCompletionAt(rental));
      }

      await Rental.findByIdAndUpdate(
        rental._id,
        rentalUpdate,
        session ? { session } : undefined
      );

      const updatedItem = await syncItemRuntimeStatus(item._id, { session });

      if (penaltyType !== PenaltyType.NONE) {
        await applyPenalty(userToPenalize, penaltyType, { session });
      }

      return { resolvedDispute: claimedDispute, syncedItem: updatedItem };
    });

    const usersToRecalculate = new Set([
      rental.renterId.toString(),
      rental.ownerId.toString()
    ]);

    if (penaltyType !== PenaltyType.NONE && penalizeUserId) {
      usersToRecalculate.add(penalizeUserId.toString());
    }

    await Promise.all(
      Array.from(usersToRecalculate).map((userId) => trustScoreService.recalculateUserTrustScore(userId))
    );

    const after = {
      disputeStatus: resolvedDispute.status,
      rentalStatus: rentalUpdate.status,
      paymentStatus: rentalUpdate.paymentStatus || rental.paymentStatus,
      itemStatus: syncedItem?.status || item.status,
      itemDelistedByAdmin: Boolean(syncedItem?.delistedByAdmin ?? item.delistedByAdmin)
    };

    await writeDisputeAuditLog({
      req,
      dispute: resolvedDispute,
      before,
      after,
      reason: adminDecision,
      metadata: {
        rentalId: rental._id,
        itemId: item._id,
        winner,
        penaltyType,
        penalizeUserId: penaltyType === PenaltyType.NONE ? null : penalizeUserId
      }
    });

    res.status(200).json({ message: 'Đã giải quyết xong tranh chấp', dispute: resolvedDispute });
  } catch (error) {
    if (error instanceof DisputeConflictError) {
      return res.status(409).json({ message: error.message });
    }
    res.status(500).json({ message: 'Lỗi máy chủ', error: error.message });
  }
};

// [USER] PATCH /api/disputes/:id/withdraw - Người dùng tự rút khiếu nại
exports.withdrawDispute = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Mã tranh chấp không hợp lệ' });
    }

    const dispute = await Dispute.findById(req.params.id);
    if (!dispute) {
      return res.status(404).json({ message: 'Không tìm thấy sự cố' });
    }

    if (!isDisputeReporter(dispute, req.user._id)) {
      return res.status(403).json({ message: 'Chỉ người tạo báo cáo mới có quyền rút khiếu nại.' });
    }

    if (!isActiveDispute(dispute)) {
      return res.status(400).json({ message: 'Sự cố này đã được xử lý hoặc đã được rút, không thể rút.' });
    }

    const rental = await Rental.findById(dispute.rentalId);
    if (!rental) {
      return res.status(404).json({ message: 'Không tìm thấy đơn thuê' });
    }

    const item = await Item.findById(rental.itemId);
    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tài sản của đơn thuê' });
    }

    const restored = getRestoreStatuses(dispute, rental);
    const rentalUpdate = { status: restored.rentalStatus };
    if (restored.rentalStatus === RentalStatus.COMPLETED && !rental.completedAt) {
      rentalUpdate.completedAt = getCompletionAt(rental);
    }

    // Rút khiếu nại phải đưa rental/item thoát DISPUTED theo snapshot đã lưu.
    const { updatedDispute, syncedItem } = await runWithOptionalTransaction(async (session) => {
      const claimedDispute = await Dispute.findOneAndUpdate(
        { _id: dispute._id, status: { $in: ACTIVE_DISPUTE_STATUSES } },
        {
          $set: {
            status: DisputeStatus.WITHDRAWN,
            adminDecision: 'Người khiếu nại đã rút đơn, giao dịch được khôi phục trạng thái trước khi có tranh chấp.'
          }
        },
        { new: true, ...(session ? { session } : {}) }
      );

      if (!claimedDispute) {
        throw new DisputeConflictError(CONFLICT_MESSAGE);
      }

      await Rental.findByIdAndUpdate(
        rental._id,
        rentalUpdate,
        session ? { session } : undefined
      );

      const updatedItem = await syncItemRuntimeStatus(item._id, { session });

      return { updatedDispute: claimedDispute, syncedItem: updatedItem };
    });

    await Promise.all([
      trustScoreService.recalculateUserTrustScore(rental.renterId),
      trustScoreService.recalculateUserTrustScore(rental.ownerId)
    ]);

    const finalItemStatus = syncedItem?.status || item.status;

    res.status(200).json({
      message: `Đã rút khiếu nại. Trạng thái đơn thuê: ${restored.rentalStatus}, trạng thái item: ${finalItemStatus}`,
      dispute: updatedDispute
    });
  } catch (error) {
    if (error instanceof DisputeConflictError) {
      return res.status(409).json({ message: error.message });
    }
    res.status(500).json({ message: 'Lỗi máy chủ', error: error.message });
  }
};
