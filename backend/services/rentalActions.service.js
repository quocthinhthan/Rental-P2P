const { RentalStatus } = require('../enums/rental.enum');
const { DisputeStatus } = require('../enums/dispute.enum');

const COMPLETION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_DISPUTE_STATUSES = [DisputeStatus.PENDING, DisputeStatus.ESCALATED];

const getRecordedCompletionAt = (rental) => rental.completedAt || rental.returnReport?.approvedAt;

// Legacy rentals may have a return approval or just the scheduled end date.
const getCompletionAt = (rental) => getRecordedCompletionAt(rental) || rental.endDate;

const getCompletionDeadline = (rental) => {
  if (rental.status !== RentalStatus.COMPLETED) return null;

  const completedAt = getCompletionAt(rental);
  if (!completedAt) return null;

  const deadline = new Date(completedAt).getTime() + COMPLETION_WINDOW_MS;
  return Number.isFinite(deadline) ? new Date(deadline) : null;
};

const isWithinCompletionWindow = (rental, now = Date.now()) => {
  const deadline = getCompletionDeadline(rental)?.getTime();
  return deadline !== undefined && now >= deadline - COMPLETION_WINDOW_MS && now <= deadline;
};

const canCreateDisputeForRental = (rental, now) => (
  rental.status === RentalStatus.CONFIRMED ||
  rental.status === RentalStatus.IN_PROGRESS ||
  isWithinCompletionWindow(rental, now)
);

const isActiveDispute = (dispute) => ACTIVE_DISPUTE_STATUSES.includes(dispute?.status);

const isDisputeReporter = (dispute, userId) => {
  const reporterId = dispute?.reporterId?._id || dispute?.reporterId;
  return Boolean(reporterId && userId && reporterId.toString() === userId.toString());
};

const getRentalActions = (rental, { dispute, userId, hasMyReview }) => {
  const now = Date.now();

  return {
    canCreateDispute: canCreateDisputeForRental(rental, now) && !isActiveDispute(dispute),
    canWithdrawDispute: isActiveDispute(dispute) && isDisputeReporter(dispute, userId),
    canReview: isWithinCompletionWindow(rental, now) && !hasMyReview,
    completionDeadline: getCompletionDeadline(rental)
  };
};

module.exports = {
  ACTIVE_DISPUTE_STATUSES,
  canCreateDisputeForRental,
  getCompletionAt,
  getRecordedCompletionAt,
  getRentalActions,
  isActiveDispute,
  isDisputeReporter,
  isWithinCompletionWindow
};
