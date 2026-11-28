// backend/tests/disputeSyncAudit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Dispute = require('../models/Dispute.model');
const Rental = require('../models/Rental.model');
const Item = require('../models/Item.model');
const User = require('../models/User.model');
const AuditLog = require('../models/AuditLog.model');
const trustScoreService = require('../services/trustScore.service');
const disputesController = require('../controllers/disputes.controller');

const { DisputeStatus, DisputeWinner, PenaltyType } = require('../enums/dispute.enum');
const { RentalStatus, PaymentStatus } = require('../enums/rental.enum');
const { ItemStatus } = require('../enums/item.enum');

const createMockRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
};

const makeQuery = (resultOrFn, { onSelect, onSession } = {}) => {
  const query = {
    select(fields) {
      if (onSelect) onSelect(fields);
      return query;
    },
    session(session) {
      if (onSession) onSession(session);
      return query;
    },
    then(resolve, reject) {
      const value = typeof resultOrFn === 'function' ? resultOrFn() : resultOrFn;
      return Promise.resolve(value).then(resolve, reject);
    }
  };
  return query;
};

const createSessionStub = ({ withTransactionImpl } = {}) => {
  let ended = false;
  const session = {
    id: 'mock-session',
    get ended() {
      return ended;
    },
    async withTransaction(fn) {
      if (withTransactionImpl) {
        return withTransactionImpl(fn, session);
      }
      return fn();
    },
    async endSession() {
      ended = true;
    }
  };
  return session;
};

const stubMethod = (t, obj, key, impl) => {
  const original = obj[key];
  obj[key] = impl;
  t.after(() => {
    obj[key] = original;
  });
};

const buildFixtures = (overrides = {}) => {
  const adminId = new mongoose.Types.ObjectId();
  const renterId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const rentalId = new mongoose.Types.ObjectId();
  const disputeId = new mongoose.Types.ObjectId();

  const dispute = {
    _id: disputeId,
    rentalId,
    reporterId: renterId,
    status: DisputeStatus.ESCALATED,
    previousRentalStatus: RentalStatus.IN_PROGRESS,
    previousItemStatus: ItemStatus.RENTED,
    mediationEndsAt: new Date(Date.now() - 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
    ...overrides.dispute
  };

  const rental = {
    _id: rentalId,
    renterId,
    ownerId,
    itemId,
    status: RentalStatus.DISPUTED,
    paymentStatus: PaymentStatus.ESCROWED,
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    ...overrides.rental
  };

  const itemSaveCalls = [];
  const item = {
    _id: itemId,
    status: ItemStatus.RENTED,
    delistedByAdmin: false,
    async save(opts) {
      itemSaveCalls.push({ status: this.status, opts });
      return this;
    },
    ...overrides.item
  };

  return {
    adminId,
    renterId,
    ownerId,
    itemId,
    rentalId,
    disputeId,
    dispute,
    rental,
    item,
    itemSaveCalls
  };
};

test('1. resolveDispute writes AuditLog with action, targetType, before, after, and reason', async (t) => {
  const { adminId, renterId, ownerId, dispute, rental, item } = buildFixtures();
  const auditCalls = [];
  const session = createSessionStub();

  stubMethod(t, mongoose, 'startSession', async () => session);
  stubMethod(t, Dispute, 'findById', async () => dispute);
  stubMethod(t, Rental, 'findById', async () => rental);
  stubMethod(t, Item, 'findById', () => makeQuery(item));
  stubMethod(t, Rental, 'findOne', () => makeQuery(null));
  stubMethod(t, Rental, 'findByIdAndUpdate', async () => ({ ...rental, status: RentalStatus.CANCELLED }));
  stubMethod(t, Dispute, 'findOneAndUpdate', async (_filter, update) => ({
    ...dispute,
    ...update.$set
  }));
  stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => null);
  stubMethod(t, AuditLog, 'create', async (payload) => {
    auditCalls.push(payload);
    return payload;
  });

  const req = {
    params: { id: dispute._id.toString() },
    user: { _id: adminId },
    body: {
      adminDecision: 'Hoàn tiền cho người thuê do thiết bị lỗi',
      winner: DisputeWinner.RENTER,
      penaltyType: PenaltyType.NONE
    }
  };
  const res = createMockRes();

  await disputesController.resolveDispute(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(session.ended, true);
  assert.equal(auditCalls.length, 1);

  const [log] = auditCalls;
  assert.equal(String(log.actorId), String(adminId));
  assert.equal(log.action, 'admin.dispute.resolve');
  assert.equal(log.targetType, 'Dispute');
  assert.equal(String(log.targetId), String(dispute._id));
  assert.equal(log.reason, 'Hoàn tiền cho người thuê do thiết bị lỗi');
  assert.deepEqual(log.before, {
    disputeStatus: DisputeStatus.ESCALATED,
    rentalStatus: RentalStatus.DISPUTED,
    paymentStatus: PaymentStatus.ESCROWED,
    itemStatus: ItemStatus.RENTED,
    itemDelistedByAdmin: false
  });
  assert.deepEqual(log.after, {
    disputeStatus: DisputeStatus.RESOLVED,
    rentalStatus: RentalStatus.CANCELLED,
    paymentStatus: PaymentStatus.REFUNDED,
    itemStatus: ItemStatus.AVAILABLE,
    itemDelistedByAdmin: false
  });
  assert.equal(String(log.metadata.rentalId), String(rental._id));
  assert.equal(String(log.metadata.itemId), String(item._id));
  assert.equal(log.metadata.winner, DisputeWinner.RENTER);
  assert.equal(log.metadata.penaltyType, PenaltyType.NONE);
  assert.ok(renterId && ownerId);
});

test('2. resolveDispute preserves DELISTED / delistedByAdmin items untouched', async (t) => {
  const { adminId, dispute, rental, item, itemSaveCalls } = buildFixtures({
    item: {
      status: ItemStatus.DELISTED,
      delistedByAdmin: true
    }
  });
  const session = createSessionStub();
  let rentalFindOneCalled = false;
  const auditCalls = [];

  stubMethod(t, mongoose, 'startSession', async () => session);
  stubMethod(t, Dispute, 'findById', async () => dispute);
  stubMethod(t, Rental, 'findById', async () => rental);
  stubMethod(t, Item, 'findById', () => makeQuery(item));
  stubMethod(t, Rental, 'findOne', () => {
    rentalFindOneCalled = true;
    return makeQuery(null);
  });
  stubMethod(t, Rental, 'findByIdAndUpdate', async () => rental);
  stubMethod(t, Dispute, 'findOneAndUpdate', async (_filter, update) => ({
    ...dispute,
    ...update.$set
  }));
  stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => null);
  stubMethod(t, AuditLog, 'create', async (payload) => {
    auditCalls.push(payload);
    return payload;
  });

  const req = {
    params: { id: dispute._id.toString() },
    user: { _id: adminId },
    body: {
      adminDecision: 'Chủ đồ thắng nhưng sản phẩm vẫn bị admin gỡ',
      winner: DisputeWinner.OWNER,
      penaltyType: PenaltyType.NONE
    }
  };
  const res = createMockRes();

  await disputesController.resolveDispute(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(item.status, ItemStatus.DELISTED);
  assert.equal(itemSaveCalls.length, 0);
  assert.equal(rentalFindOneCalled, false);
  assert.equal(auditCalls[0].after.itemStatus, ItemStatus.DELISTED);
  assert.equal(auditCalls[0].after.itemDelistedByAdmin, true);
});

test('3. resolveDispute preserves RENTED when another concurrent active rental covers today', async (t) => {
  const { adminId, dispute, rental, item, itemSaveCalls } = buildFixtures({
    item: { status: ItemStatus.RENTED, delistedByAdmin: false }
  });
  const session = createSessionStub();
  const concurrentRentalId = new mongoose.Types.ObjectId();
  let capturedQuery = null;
  const auditCalls = [];

  stubMethod(t, mongoose, 'startSession', async () => session);
  stubMethod(t, Dispute, 'findById', async () => dispute);
  stubMethod(t, Rental, 'findById', async () => rental);
  stubMethod(t, Item, 'findById', () => makeQuery(item));
  stubMethod(t, Rental, 'findOne', (query) => {
    capturedQuery = query;
    return makeQuery({ _id: concurrentRentalId });
  });
  stubMethod(t, Rental, 'findByIdAndUpdate', async () => rental);
  stubMethod(t, Dispute, 'findOneAndUpdate', async (_filter, update) => ({
    ...dispute,
    ...update.$set
  }));
  stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => null);
  stubMethod(t, AuditLog, 'create', async (payload) => {
    auditCalls.push(payload);
    return payload;
  });

  const req = {
    params: { id: dispute._id.toString() },
    user: { _id: adminId },
    body: {
      adminDecision: 'Hoàn tất đơn tranh chấp nhưng vẫn còn đơn khác đang thuê hôm nay',
      winner: DisputeWinner.OWNER,
      penaltyType: PenaltyType.NONE
    }
  };
  const res = createMockRes();

  await disputesController.resolveDispute(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(item.status, ItemStatus.RENTED);
  assert.equal(itemSaveCalls.length, 0);
  assert.deepEqual(capturedQuery.status, {
    $in: [RentalStatus.CONFIRMED, RentalStatus.IN_PROGRESS, RentalStatus.DISPUTED]
  });
  assert.equal(auditCalls[0].after.itemStatus, ItemStatus.RENTED);
});

test('4. resolveDispute sets paymentStatus = REFUNDED only when ESCROWED and leaves PENDING untouched', async (t) => {
  const runCase = async (initialPaymentStatus) => {
    const { adminId, dispute, rental, item } = buildFixtures({
      rental: { paymentStatus: initialPaymentStatus }
    });
    const session = createSessionStub();
    const rentalUpdates = [];
    const auditCalls = [];

    stubMethod(t, mongoose, 'startSession', async () => session);
    stubMethod(t, Dispute, 'findById', async () => dispute);
    stubMethod(t, Rental, 'findById', async () => rental);
    stubMethod(t, Item, 'findById', () => makeQuery(item));
    stubMethod(t, Rental, 'findOne', () => makeQuery(null));
    stubMethod(t, Rental, 'findByIdAndUpdate', async (_id, update) => {
      rentalUpdates.push(update);
      return { ...rental, ...update };
    });
    stubMethod(t, Dispute, 'findOneAndUpdate', async (_filter, update) => ({
      ...dispute,
      ...update.$set
    }));
    stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => null);
    stubMethod(t, AuditLog, 'create', async (payload) => {
      auditCalls.push(payload);
      return payload;
    });

    const req = {
      params: { id: dispute._id.toString() },
      user: { _id: adminId },
      body: {
        adminDecision: 'Người thuê thắng tranh chấp',
        winner: DisputeWinner.RENTER,
        penaltyType: PenaltyType.NONE
      }
    };
    const res = createMockRes();
    await disputesController.resolveDispute(req, res);

    return { res, rentalUpdates, auditCalls };
  };

  const escrowedResult = await runCase(PaymentStatus.ESCROWED);
  assert.equal(escrowedResult.res.statusCode, 200);
  assert.equal(escrowedResult.rentalUpdates[0].paymentStatus, PaymentStatus.REFUNDED);
  assert.equal(escrowedResult.auditCalls[0].after.paymentStatus, PaymentStatus.REFUNDED);

  const pendingResult = await runCase(PaymentStatus.PENDING);
  assert.equal(pendingResult.res.statusCode, 200);
  assert.equal('paymentStatus' in pendingResult.rentalUpdates[0], false);
  assert.equal(pendingResult.auditCalls[0].after.paymentStatus, PaymentStatus.PENDING);
});

test('5. concurrent race returns 409 for resolveDispute, withdrawDispute, and escalateDispute with zero downstream mutations', async (t) => {
  // 5a: resolveDispute race
  {
    const { adminId, renterId, dispute, rental, item, itemSaveCalls } = buildFixtures();
    const session = createSessionStub();
    let rentalUpdateCalled = false;
    let trustScoreCalled = false;
    let auditCalled = false;
    let userSaveCalled = false;

    const penalizedUser = {
      _id: renterId,
      async save() {
        userSaveCalled = true;
      }
    };

    stubMethod(t, mongoose, 'startSession', async () => session);
    stubMethod(t, Dispute, 'findById', async () => dispute);
    stubMethod(t, Rental, 'findById', async () => rental);
    stubMethod(t, Item, 'findById', () => makeQuery(item));
    stubMethod(t, User, 'findById', async () => penalizedUser);
    stubMethod(t, Dispute, 'findOneAndUpdate', async () => null);
    stubMethod(t, Rental, 'findByIdAndUpdate', async () => {
      rentalUpdateCalled = true;
    });
    stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => {
      trustScoreCalled = true;
    });
    stubMethod(t, AuditLog, 'create', async () => {
      auditCalled = true;
    });

    const req = {
      params: { id: dispute._id.toString() },
      user: { _id: adminId },
      body: {
        adminDecision: 'Phán quyết',
        winner: DisputeWinner.OWNER,
        penaltyType: PenaltyType.WARNING,
        penalizeUserId: renterId.toString()
      }
    };
    const res = createMockRes();
    await disputesController.resolveDispute(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(session.ended, true);
    assert.equal(rentalUpdateCalled, false);
    assert.equal(itemSaveCalls.length, 0);
    assert.equal(userSaveCalled, false);
    assert.equal(trustScoreCalled, false);
    assert.equal(auditCalled, false);
  }

  // 5b: withdrawDispute race
  {
    const { renterId, dispute, rental, item, itemSaveCalls } = buildFixtures({
      dispute: { status: DisputeStatus.PENDING }
    });
    const session = createSessionStub();
    let rentalUpdateCalled = false;
    let trustScoreCalled = false;

    stubMethod(t, mongoose, 'startSession', async () => session);
    stubMethod(t, Dispute, 'findById', async () => dispute);
    stubMethod(t, Rental, 'findById', async () => rental);
    stubMethod(t, Item, 'findById', () => makeQuery(item));
    stubMethod(t, Dispute, 'findOneAndUpdate', async () => null);
    stubMethod(t, Rental, 'findByIdAndUpdate', async () => {
      rentalUpdateCalled = true;
    });
    stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => {
      trustScoreCalled = true;
    });

    const req = {
      params: { id: dispute._id.toString() },
      user: { _id: renterId }
    };
    const res = createMockRes();
    await disputesController.withdrawDispute(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(session.ended, true);
    assert.equal(rentalUpdateCalled, false);
    assert.equal(itemSaveCalls.length, 0);
    assert.equal(trustScoreCalled, false);
  }

  // 5c: escalateDispute race
  {
    const { renterId, dispute, rental } = buildFixtures({
      dispute: {
        status: DisputeStatus.PENDING,
        mediationEndsAt: new Date(Date.now() - 60 * 1000)
      }
    });

    stubMethod(t, Dispute, 'findById', async () => dispute);
    stubMethod(t, Rental, 'findById', async () => rental);
    stubMethod(t, Dispute, 'findOneAndUpdate', async () => null);

    const req = {
      params: { id: dispute._id.toString() },
      user: { _id: renterId }
    };
    const res = createMockRes();
    await disputesController.escalateDispute(req, res);

    assert.equal(res.statusCode, 409);
  }
});

test('6. standalone MongoDB transaction-unsupported error falls back cleanly without session', async (t) => {
  const { adminId, dispute, rental, item, itemSaveCalls } = buildFixtures();
  const observedSessions = [];
  const auditCalls = [];

  const session = createSessionStub({
    withTransactionImpl: async () => {
      throw new Error('Transaction numbers are only allowed on a replica set member or mongos');
    }
  });

  stubMethod(t, mongoose, 'startSession', async () => session);
  stubMethod(t, Dispute, 'findById', async () => dispute);
  stubMethod(t, Rental, 'findById', async () => rental);
  stubMethod(t, Item, 'findById', () => makeQuery(item, {
    onSession: (s) => observedSessions.push({ op: 'Item.findById', session: s })
  }));
  stubMethod(t, Rental, 'findOne', () => makeQuery(null, {
    onSession: (s) => observedSessions.push({ op: 'Rental.findOne', session: s })
  }));
  stubMethod(t, Dispute, 'findOneAndUpdate', async (_filter, update, options) => {
    observedSessions.push({ op: 'Dispute.findOneAndUpdate', session: options?.session || null });
    return { ...dispute, ...update.$set };
  });
  stubMethod(t, Rental, 'findByIdAndUpdate', async (_id, update, options) => {
    observedSessions.push({ op: 'Rental.findByIdAndUpdate', session: options?.session || null });
    return { ...rental, ...update };
  });
  stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => null);
  stubMethod(t, AuditLog, 'create', async (payload) => {
    auditCalls.push(payload);
    return payload;
  });

  const req = {
    params: { id: dispute._id.toString() },
    user: { _id: adminId },
    body: {
      adminDecision: 'Fallback standalone transaction',
      winner: DisputeWinner.OWNER,
      penaltyType: PenaltyType.NONE
    }
  };
  const res = createMockRes();

  await disputesController.resolveDispute(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(session.ended, true);
  assert.equal(item.status, ItemStatus.AVAILABLE);
  assert.equal(itemSaveCalls.length, 1);
  assert.equal(itemSaveCalls[0].opts, undefined);
  assert.ok(observedSessions.every((entry) => entry.session === null));
  assert.equal(auditCalls.length, 1);
});

test('7. AuditLog.create failure does not fail resolveDispute response', async (t) => {
  const { adminId, dispute, rental, item } = buildFixtures();
  const session = createSessionStub();
  const loggedErrors = [];

  stubMethod(t, console, 'error', (...args) => {
    loggedErrors.push(args);
  });
  stubMethod(t, mongoose, 'startSession', async () => session);
  stubMethod(t, Dispute, 'findById', async () => dispute);
  stubMethod(t, Rental, 'findById', async () => rental);
  stubMethod(t, Item, 'findById', () => makeQuery(item));
  stubMethod(t, Rental, 'findOne', () => makeQuery(null));
  stubMethod(t, Rental, 'findByIdAndUpdate', async () => rental);
  stubMethod(t, Dispute, 'findOneAndUpdate', async (_filter, update) => ({
    ...dispute,
    ...update.$set
  }));
  stubMethod(t, trustScoreService, 'recalculateUserTrustScore', async () => null);
  stubMethod(t, AuditLog, 'create', async () => {
    throw new Error('AuditLog write failed');
  });

  const req = {
    params: { id: dispute._id.toString() },
    user: { _id: adminId },
    body: {
      adminDecision: 'Giải quyết thành công dù audit log lỗi',
      winner: DisputeWinner.OWNER,
      penaltyType: PenaltyType.NONE
    }
  };
  const res = createMockRes();

  await disputesController.resolveDispute(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dispute.status, DisputeStatus.RESOLVED);
  assert.equal(loggedErrors.length, 1);
});
