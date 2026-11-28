const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog.model');
const Dispute = require('../models/Dispute.model');
const Item = require('../models/Item.model');
const Rental = require('../models/Rental.model');
const Review = require('../models/Review.model');
const User = require('../models/User.model');
const disputes = require('../controllers/disputes.controller');
const reviews = require('../controllers/reviews.controller');
const views = require('../controllers/views.controller');
const trustScore = require('../services/trustScore.service');
const {
  canCreateDisputeForRental,
  getRentalActions,
  isWithinCompletionWindow
} = require('../services/rentalActions.service');

const DAY_MS = 24 * 60 * 60 * 1000;
const itemId = new mongoose.Types.ObjectId();
const rentalId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const renterId = new mongoose.Types.ObjectId();
const testSecret = process.env.JWT_SECRET ||= 'rental-actions-test-key';

const createResponse = () => {
  const res = { statusCode: 200 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

test('item details include owner phone only for authenticated callers with an active account', async (t) => {
  t.mock.method(Item, 'findById', () => ({
    populate: async (_field, projection) => ({
      _id: itemId,
      status: 'available',
      ownerId: {
        _id: ownerId,
        fullName: 'Owner',
        ...(projection.includes('phoneNumber') ? { phoneNumber: '0900000000' } : {})
      }
    })
  }));
  t.mock.method(Rental, 'find', () => ({ select: async () => [] }));
  let account = { _id: renterId, favorites: [itemId] };
  t.mock.method(User, 'findById', () => ({ select: async () => account }));

  const token = jwt.sign({ id: renterId.toString() }, testSecret, { expiresIn: 60 });
  const scopedToken = jwt.sign({ id: renterId.toString(), purpose: 'ekyc' }, testSecret);
  const expiredToken = jwt.sign({ id: renterId.toString() }, testSecret, { expiresIn: -1 });
  const request = async (authorization) => {
    const res = createResponse();
    res.set = (...args) => express.response.set.apply(res, args);
    const headers = new Map();
    res.getHeader = (name) => headers.get(name.toLowerCase());
    res.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
    res.get = express.response.get;
    res.vary = express.response.vary;
    await views.getItemDetailView({ params: { id: itemId }, headers: { authorization } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.get('Cache-Control'), 'private, no-store');
    assert.equal(res.get('Vary'), 'Authorization');
    assert.equal(res.body.owner.fullName, 'Owner');
    return res.body;
  };

  for (const header of [undefined, 'Bearer invalid-token', `Bearer ${scopedToken}`, `Bearer ${expiredToken}`]) {
    assert.equal(Object.hasOwn((await request(header)).owner, 'phoneNumber'), false);
  }

  const active = await request(`Bearer ${token}`);
  assert.equal(active.owner.phoneNumber, '0900000000');
  assert.equal(active.isFavorited, true);

  for (account of [
    { _id: renterId, isBanned: true },
    { _id: renterId, suspendedUntil: new Date(Date.now() + DAY_MS) },
    null
  ]) {
    assert.equal(Object.hasOwn((await request(`Bearer ${token}`)).owner, 'phoneNumber'), false);
  }
});

test('completion deadline has an inclusive seven-day cutoff and uses stable legacy dates', () => {
  const completedAt = new Date('2026-11-20T08:30:00.000Z');
  const cutoff = completedAt.getTime() + 7 * DAY_MS;
  const rental = { status: 'completed', completedAt, updatedAt: new Date(cutoff + DAY_MS) };
  assert.equal(canCreateDisputeForRental(rental, completedAt.getTime() - 1), false);
  assert.equal(canCreateDisputeForRental(rental, cutoff), true);
  assert.equal(canCreateDisputeForRental(rental, cutoff + 1), false);
  assert.equal(isWithinCompletionWindow(rental, cutoff + 1), false);

  delete rental.completedAt;
  rental.returnReport = { approvedAt: completedAt };
  rental.endDate = new Date(cutoff - DAY_MS);
  assert.equal(isWithinCompletionWindow(rental, cutoff + 1), false);
  delete rental.returnReport;
  rental.endDate = completedAt;
  assert.equal(isWithinCompletionWindow(rental, cutoff), true);
  assert.equal(isWithinCompletionWindow(rental, cutoff + 1), false);
});

test('rental action flags separate review submission from dispute eligibility and restrict withdrawal to the reporter', () => {
  const rental = { status: 'completed', completedAt: new Date(Date.now() - DAY_MS) };
  const dispute = { status: 'resolved', reporterId: { _id: renterId } };
  const getActions = (userId, hasMyReview) => getRentalActions(rental, { dispute, userId, hasMyReview });
  const afterReview = getActions(renterId, true);
  assert.equal(afterReview.canCreateDispute, true);
  assert.equal(afterReview.canReview, false);
  assert.equal(afterReview.canWithdrawDispute, false);

  for (const status of ['pending', 'escalated']) {
    dispute.status = status;
    assert.equal(getActions(renterId, false).canCreateDispute, false);
    assert.equal(getActions(renterId, false).canWithdrawDispute, true);
    assert.equal(getActions(ownerId, false).canWithdrawDispute, false);
  }

  assert.equal(canCreateDisputeForRental({ status: 'confirmed' }), true);
  assert.equal(canCreateDisputeForRental({ status: 'in_progress' }), true);
  assert.equal(canCreateDisputeForRental({ status: 'disputed' }), false);
});

test('review and dispute API submission both honor the original completion deadline', async (t) => {
  const rental = {
    _id: rentalId,
    status: 'completed',
    renterId,
    ownerId,
    itemId,
    completedAt: new Date(Date.now() - 8 * DAY_MS),
    updatedAt: new Date()
  };
  t.mock.method(Rental, 'findById', async () => ({ ...rental }));
  const request = { user: { _id: renterId }, body: { rentalId, rating: 5, reason: 'Damage after return' } };

  for (const submit of [reviews.createReview, disputes.createDispute]) {
    const res = createResponse();
    await submit(request, res);
    assert.equal(res.statusCode, 400);
  }

  rental.completedAt = new Date(Date.now() - DAY_MS);
  t.mock.method(Review, 'findOne', async () => null);
  t.mock.method(Review, 'create', async (payload) => payload);
  t.mock.method(Dispute, 'findOne', async () => null);
  t.mock.method(Dispute, 'create', async (payload) => payload);
  t.mock.method(Item, 'findById', async () => ({ status: 'available' }));
  t.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async () => { throw new Error('Transaction numbers are only allowed on a replica set member'); },
    endSession: async () => {}
  }));
  t.mock.method(Rental, 'updateOne', async (filter, update) => {
    if (rental.status !== filter.status) return { modifiedCount: 0 };
    rental.status = update.$set.status;
    return { modifiedCount: 1 };
  });

  const reviewResponse = createResponse();
  await reviews.createReview(request, reviewResponse);
  assert.equal(reviewResponse.statusCode, 201);

  const disputeResponses = [createResponse(), createResponse()];
  await Promise.all(disputeResponses.map((res) => disputes.createDispute(request, res)));
  assert.deepEqual(disputeResponses.map((res) => res.statusCode).sort(), [201, 409]);
  const disputeResponse = disputeResponses.find((res) => res.statusCode === 201);
  assert.equal(disputeResponse.body.dispute.previousRentalStatus, 'completed');
  assert.equal(rental.status, 'disputed');
});

const mockDisputeSettlement = (t, dispute, rental) => {
  t.mock.method(Rental, 'findById', async () => rental);
  t.mock.method(Item, 'findById', () => ({
    select: async () => ({ _id: itemId, status: 'delisted' })
  }));
  t.mock.method(Dispute, 'findById', async () => dispute);
  t.mock.method(Dispute, 'findOneAndUpdate', async (filter, update) => {
    assert.ok(filter.status.$in.includes('escalated'));
    return Object.assign(dispute, update.$set);
  });
  t.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (work) => work(),
    endSession: async () => {}
  }));
  t.mock.method(Rental, 'findByIdAndUpdate', async (_id, update) => Object.assign(rental, update));
  t.mock.method(trustScore, 'recalculateUserTrustScore', async () => {});
};

test('withdrawing an escalated dispute preserves the original completion timestamp', async (t) => {
  const completedAt = new Date(Date.now() - 8 * DAY_MS);
  const rental = { _id: rentalId, itemId, renterId, ownerId, status: 'disputed', completedAt };
  const dispute = {
    _id: new mongoose.Types.ObjectId(),
    rentalId,
    reporterId: renterId,
    previousRentalStatus: 'completed',
    status: 'escalated'
  };
  mockDisputeSettlement(t, dispute, rental);

  const res = createResponse();
  await disputes.withdrawDispute({ user: { _id: renterId }, params: { id: dispute._id } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(rental.status, 'completed');
  assert.equal(rental.completedAt, completedAt);
  assert.equal(isWithinCompletionWindow(rental), false);
});

test('admin uses the resolution time only when the dispute first completes the rental', async (t) => {
  const rental = { _id: rentalId, itemId, renterId, ownerId, status: 'disputed', completedAt: null };
  const dispute = {
    _id: new mongoose.Types.ObjectId(),
    rentalId,
    previousRentalStatus: 'in_progress',
    status: 'escalated'
  };
  mockDisputeSettlement(t, dispute, rental);
  t.mock.method(AuditLog, 'create', async () => {});
  const request = {
    user: { _id: new mongoose.Types.ObjectId() },
    params: { id: dispute._id },
    body: { winner: 'owner', adminDecision: 'Owner wins' }
  };

  const firstResolution = createResponse();
  await disputes.resolveDispute(request, firstResolution);
  assert.equal(firstResolution.statusCode, 200);
  assert.equal(rental.status, 'completed');
  assert.equal(rental.completedAt, dispute.resolvedAt);

  const originalCompletion = new Date(Date.now() - 8 * DAY_MS);
  Object.assign(rental, { status: 'disputed', completedAt: originalCompletion });
  Object.assign(dispute, { status: 'escalated', previousRentalStatus: 'completed' });
  const laterResolution = createResponse();
  await disputes.resolveDispute(request, laterResolution);
  assert.equal(laterResolution.statusCode, 200);
  assert.equal(rental.completedAt, originalCompletion);
  assert.equal(isWithinCompletionWindow(rental), false);
});
