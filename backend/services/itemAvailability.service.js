// backend/services/itemAvailability.service.js
const Item = require('../models/Item.model');
const Rental = require('../models/Rental.model');
const { Error: { DocumentNotFoundError } } = require('mongoose');
const { ItemStatus } = require('../enums/item.enum');
const { RentalStatus } = require('../enums/rental.enum');

const ACTIVE_BOOKING_STATUSES = Object.freeze([
  RentalStatus.PENDING_CONFIRMATION,
  RentalStatus.CONFIRMED,
  RentalStatus.IN_PROGRESS,
  RentalStatus.DISPUTED
]);

const RUNTIME_RENTED_STATUSES = Object.freeze([
  RentalStatus.CONFIRMED,
  RentalStatus.IN_PROGRESS,
  RentalStatus.DISPUTED
]);

/**
 * Normalize a date input to the start of its local calendar day (00:00:00.000).
 * Returns null when the input cannot produce a valid Date.
 */
const toStartOfDay = (date) => {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * Normalize a date input to the end of its local calendar day (23:59:59.999).
 * Returns null when the input cannot produce a valid Date.
 */
const toEndOfDay = (date) => {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Check whether startDate falls on an earlier calendar day than referenceDate.
 */
const isStartDateInPast = (startDate, referenceDate = new Date()) => {
  const start = toStartOfDay(startDate);
  const ref = toStartOfDay(referenceDate);
  if (!start || !ref) return false;
  return start < ref;
};

/**
 * Find an active booking on the same item overlapping [startDate, endDate].
 */
const findOverlappingBooking = ({
  itemId,
  startDate,
  endDate,
  excludeRentalId = null,
  session = null
}) => {
  const query = {
    itemId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate }
  };

  if (excludeRentalId) {
    query._id = { $ne: excludeRentalId };
  }

  let cursor = Rental.findOne(query).select('_id code status startDate endDate');
  if (session && cursor && typeof cursor.session === 'function') {
    cursor = cursor.session(session);
  }
  return cursor;
};

/**
 * Find the first owner-blocked date range on item overlapping [startDate, endDate].
 */
const findOverlappingBlockedDate = (item, startDate, endDate) => {
  const reqStart = toStartOfDay(startDate);
  const reqEnd = toEndOfDay(endDate);
  if (!reqStart || !reqEnd) return null;

  const blockedDates = item?.blockedDates || [];
  for (const block of blockedDates) {
    if (!block) continue;
    const blockStart = toStartOfDay(block.startDate);
    const blockEnd = toEndOfDay(block.endDate);
    if (!blockStart || !blockEnd) continue;
    if (reqStart <= blockEnd && reqEnd >= blockStart) {
      return block;
    }
  }
  return null;
};

/**
 * Verify item eligibility, owner-blocked dates, and overlapping active bookings.
 */
const checkItemDateAvailability = async ({
  item = null,
  itemId = null,
  startDate,
  endDate,
  excludeRentalId = null,
  session = null
}) => {
  let resolvedItem = item;
  if (!resolvedItem && itemId) {
    let itemQuery = Item.findById(itemId).select('_id status delistedByAdmin blockedDates');
    if (session && itemQuery && typeof itemQuery.session === 'function') {
      itemQuery = itemQuery.session(session);
    }
    resolvedItem = await itemQuery;
  }

  if (!resolvedItem || resolvedItem.status === ItemStatus.DELISTED || resolvedItem.delistedByAdmin) {
    return { available: false, reason: 'item_delisted' };
  }

  const blockedDate = findOverlappingBlockedDate(resolvedItem, startDate, endDate);
  if (blockedDate) {
    return { available: false, reason: 'owner_blocked', blockedDate };
  }

  const overlappingRental = await findOverlappingBooking({
    itemId: resolvedItem._id,
    startDate,
    endDate,
    excludeRentalId,
    session
  });
  if (overlappingRental) {
    return { available: false, reason: 'overlapping_rental', overlappingRental };
  }

  return { available: true };
};

/**
 * Synchronize Item.status ('available' | 'rented') for today while preserving delisted items.
 */
const syncItemRuntimeStatus = async (itemId, { session = null } = {}) => {
  let itemQuery = Item.findById(itemId).select('_id status delistedByAdmin');
  if (session && itemQuery && typeof itemQuery.session === 'function') {
    itemQuery = itemQuery.session(session);
  }
  const item = await itemQuery;

  if (!item || item.status === ItemStatus.DELISTED || item.delistedByAdmin) {
    return item;
  }

  const today = toStartOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let rentalQuery = Rental.findOne({
    itemId,
    status: { $in: RUNTIME_RENTED_STATUSES },
    startDate: { $lt: tomorrow },
    endDate: { $gte: today }
  }).select('_id');
  if (session && rentalQuery && typeof rentalQuery.session === 'function') {
    rentalQuery = rentalQuery.session(session);
  }
  const currentRental = await rentalQuery;

  const nextStatus = currentRental ? ItemStatus.RENTED : ItemStatus.AVAILABLE;
  if (item.status !== nextStatus) {
    // An owner or admin may have hidden the item while the rental was being queried.
    item.$where = { status: { $ne: ItemStatus.DELISTED }, delistedByAdmin: { $ne: true } };
    item.status = nextStatus;
    try {
      await item.save(session ? { session } : undefined);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return itemQuery.clone();
      throw error;
    }
  }

  return item;
};

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  RUNTIME_RENTED_STATUSES,
  toStartOfDay,
  toEndOfDay,
  isStartDateInPast,
  findOverlappingBooking,
  findOverlappingBlockedDate,
  checkItemDateAvailability,
  syncItemRuntimeStatus
};
