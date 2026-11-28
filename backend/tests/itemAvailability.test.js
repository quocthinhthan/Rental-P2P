// backend/tests/itemAvailability.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const qs = require('qs');
const mongoose = require('mongoose');

const Item = require('../models/Item.model');
const Rental = require('../models/Rental.model');
const Contract = require('../models/Contract.model');
const { ItemStatus } = require('../enums/item.enum');
const { RentalStatus, PaymentStatus } = require('../enums/rental.enum');

const itemAvailabilityService = require('../services/itemAvailability.service');
const rentalsController = require('../controllers/rentals.controller');
const itemsController = require('../controllers/items.controller');
const viewsController = require('../controllers/views.controller');

const {
  ACTIVE_BOOKING_STATUSES,
  RUNTIME_RENTED_STATUSES,
  toStartOfDay,
  toEndOfDay,
  isStartDateInPast,
  syncItemRuntimeStatus
} = itemAvailabilityService;

const makeQuery = (result) => {
  const query = {
    select() { return query; },
    populate() { return query; },
    sort() { return query; },
    skip() { return query; },
    limit() { return query; },
    session() { return query; },
    lean() { return query; },
    then(onFulfilled, onRejected) {
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve(result).catch(onRejected);
    }
  };
  return query;
};

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    redirectUrl: null,
    sentBody: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    redirect(url) {
      res.redirectUrl = url;
      return res;
    },
    send(payload) {
      res.sentBody = payload;
      return res;
    }
  };
  return res;
};

const stubMethod = (t, obj, key, impl) => {
  const original = obj[key];
  obj[key] = impl;
  t.after(() => {
    obj[key] = original;
  });
};

const setEnvForTest = (t, key, value) => {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, key);
  const original = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (hadKey) {
      process.env[key] = original;
    } else {
      delete process.env[key];
    }
  });
};

const addDays = (date, days) => {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
};

const buildSignedVNPayQuery = (params, secret) => {
  const sorted = {};
  Object.keys(params)
    .sort()
    .forEach((key) => {
      sorted[key] = encodeURIComponent(params[key]).replace(/%20/g, '+');
    });
  const signData = qs.stringify(sorted, { encode: false });
  const secureHash = crypto
    .createHmac('sha512', secret)
    .update(Buffer.from(signData, 'utf-8'))
    .digest('hex');
  return { ...params, vnp_SecureHash: secureHash };
};

test('isStartDateInPast distinguishes yesterday, today, and tomorrow', () => {
  const ref = new Date(2026, 10, 28, 15, 30, 0, 0); // 2026-11-28 15:30 local
  const yesterday = new Date(2026, 10, 27, 23, 59, 59, 999);
  const todayEarly = new Date(2026, 10, 28, 0, 1, 0, 0);
  const tomorrow = new Date(2026, 10, 29, 8, 0, 0, 0);

  assert.equal(isStartDateInPast(yesterday, ref), true);
  assert.equal(isStartDateInPast(todayEarly, ref), false);
  assert.equal(isStartDateInPast(tomorrow, ref), false);
  assert.equal(toStartOfDay('not-a-date'), null);
  assert.equal(toEndOfDay(null), null);
});

test('createRentalRequest rejects past startDate with 400', async (t) => {
  const itemId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const renterId = new mongoose.Types.ObjectId();

  stubMethod(t, Item, 'findById', () => makeQuery({
    _id: itemId,
    ownerId,
    status: ItemStatus.AVAILABLE,
    pricePerDay: 100000,
    baseValue: 1000000,
    depositPercentage: 50,
    blockedDates: []
  }));

  const yesterday = addDays(new Date(), -1);
  const tomorrow = addDays(new Date(), 1);
  const req = {
    user: { _id: renterId },
    body: {
      itemId: itemId.toString(),
      startDate: yesterday.toISOString(),
      endDate: tomorrow.toISOString()
    }
  };
  const res = makeRes();

  await rentalsController.createRentalRequest(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Ngày bắt đầu thuê không được ở trong quá khứ.');
});

test('createRentalRequest rejects overlapping owner blockedDates with 400', async (t) => {
  const itemId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const renterId = new mongoose.Types.ObjectId();

  const blockStart = toStartOfDay(addDays(new Date(), 2));
  const blockEnd = toStartOfDay(addDays(new Date(), 4));
  const blockedEntry = {
    _id: new mongoose.Types.ObjectId(),
    startDate: blockStart,
    endDate: blockEnd,
    reason: 'Bảo trì'
  };

  stubMethod(t, Item, 'findById', () => makeQuery({
    _id: itemId,
    ownerId,
    status: ItemStatus.AVAILABLE,
    pricePerDay: 100000,
    baseValue: 1000000,
    depositPercentage: 50,
    blockedDates: [blockedEntry]
  }));

  let rentalFindOneCalled = false;
  stubMethod(t, Rental, 'findOne', () => {
    rentalFindOneCalled = true;
    return makeQuery(null);
  });

  const req = {
    user: { _id: renterId },
    body: {
      itemId: itemId.toString(),
      startDate: addDays(new Date(), 3).toISOString(),
      endDate: addDays(new Date(), 5).toISOString()
    }
  };
  const res = makeRes();

  await rentalsController.createRentalRequest(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Khoảng thời gian này trùng với lịch chủ sở hữu tạm khóa sản phẩm.');
  assert.deepEqual(res.body.blockedDate, blockedEntry);
  assert.equal(rentalFindOneCalled, false);
});

test('createRentalRequest rejects overlapping disputed rental with 400', async (t) => {
  const itemId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const renterId = new mongoose.Types.ObjectId();
  const disputedRental = {
    _id: new mongoose.Types.ObjectId(),
    code: 'RT999',
    status: RentalStatus.DISPUTED,
    startDate: addDays(new Date(), 2),
    endDate: addDays(new Date(), 4)
  };

  stubMethod(t, Item, 'findById', () => makeQuery({
    _id: itemId,
    ownerId,
    status: ItemStatus.AVAILABLE,
    pricePerDay: 100000,
    baseValue: 1000000,
    depositPercentage: 50,
    blockedDates: []
  }));

  let capturedQuery = null;
  stubMethod(t, Rental, 'findOne', (query) => {
    capturedQuery = query;
    return makeQuery(disputedRental);
  });

  const req = {
    user: { _id: renterId },
    body: {
      itemId: itemId.toString(),
      startDate: addDays(new Date(), 2).toISOString(),
      endDate: addDays(new Date(), 3).toISOString()
    }
  };
  const res = makeRes();

  await rentalsController.createRentalRequest(req, res);

  assert.equal(res.statusCode, 400);
  assert.ok(capturedQuery.status.$in.includes(RentalStatus.DISPUTED));
  assert.deepEqual(res.body.overlappingRental, disputedRental);
});

test('createVNPayUrl rejects on blockedDates overlap', async (t) => {
  const rentalId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const renterId = new mongoose.Types.ObjectId();
  const startDate = addDays(new Date(), 2);
  const endDate = addDays(new Date(), 4);
  const blockedEntry = {
    _id: new mongoose.Types.ObjectId(),
    startDate,
    endDate,
    reason: 'Locked by owner'
  };

  stubMethod(t, Rental, 'findById', () => makeQuery({
    _id: rentalId,
    itemId,
    renterId,
    status: RentalStatus.PENDING_PAYMENT,
    paymentStatus: PaymentStatus.PENDING,
    startDate,
    endDate,
    totalAmount: 200000
  }));

  let selectedFields = null;
  stubMethod(t, Item, 'findById', () => ({
    select(fields) {
      selectedFields = fields;
      return Promise.resolve({
        _id: itemId,
        status: ItemStatus.AVAILABLE,
        delistedByAdmin: false,
        blockedDates: [blockedEntry]
      });
    }
  }));

  const req = {
    params: { id: rentalId.toString() },
    user: { _id: renterId },
    body: {}
  };
  const res = makeRes();

  await rentalsController.createVNPayUrl(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(selectedFields, '_id status delistedByAdmin blockedDates');
  assert.equal(res.body.message, 'Khoảng thời gian này trùng với lịch chủ sở hữu tạm khóa sản phẩm.');
  assert.deepEqual(res.body.blockedDate, blockedEntry);
});

test('handleVNPayReturn refunds and cancels when blockedDates overlap exists', async (t) => {
  const secret = 'test-vnpay-hash-secret-123456';
  setEnvForTest(t, 'VNP_HASH_SECRET', secret);
  setEnvForTest(t, 'FRONTEND_URL', 'https://frontend.example.com');

  const rentalId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const startDate = addDays(new Date(), 2);
  const endDate = addDays(new Date(), 4);

  let savedCalled = false;
  const rentalDoc = {
    _id: rentalId,
    code: 'RT123',
    itemId,
    startDate,
    endDate,
    paymentStatus: PaymentStatus.PENDING,
    status: RentalStatus.PENDING_PAYMENT,
    async save() {
      savedCalled = true;
      return rentalDoc;
    }
  };

  stubMethod(t, Rental, 'findById', () => makeQuery(rentalDoc));

  let selectedFields = null;
  stubMethod(t, Item, 'findById', () => ({
    select(fields) {
      selectedFields = fields;
      return Promise.resolve({
        _id: itemId,
        status: ItemStatus.AVAILABLE,
        delistedByAdmin: false,
        blockedDates: [{ startDate, endDate, reason: 'Owner block' }]
      });
    }
  }));

  const query = buildSignedVNPayQuery({
    vnp_ResponseCode: '00',
    vnp_TxnRef: rentalId.toString()
  }, secret);

  const req = { query };
  const res = makeRes();

  await rentalsController.handleVNPayReturn(req, res);

  assert.equal(selectedFields, '_id status delistedByAdmin blockedDates');
  assert.equal(savedCalled, true);
  assert.equal(rentalDoc.paymentStatus, PaymentStatus.REFUNDED);
  assert.equal(rentalDoc.status, RentalStatus.CANCELLED);
  assert.ok(rentalDoc.cancelledAt instanceof Date);
  assert.ok(res.redirectUrl.includes('status=refunded'));
});

test('confirmRental rejects on blockedDates overlap', async (t) => {
  const rentalId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const startDate = addDays(new Date(), 2);
  const endDate = addDays(new Date(), 3);
  const blockedEntry = { startDate, endDate, reason: 'Owner block' };

  stubMethod(t, Item, 'findById', () => makeQuery({
    _id: itemId,
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: false,
    blockedDates: [blockedEntry]
  }));
  stubMethod(t, Contract, 'findOne', () => makeQuery(null));

  const req = {
    rental: {
      _id: rentalId,
      itemId,
      startDate,
      endDate,
      status: RentalStatus.PENDING_CONFIRMATION
    }
  };
  const res = makeRes();

  await rentalsController.confirmRental(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Khoảng thời gian này trùng với lịch chủ sở hữu tạm khóa sản phẩm.');
  assert.deepEqual(res.body.blockedDate, blockedEntry);
});

test('items.searchItems and items.addBlockedDates query with disputed status', async (t) => {
  const rentalQueries = [];
  stubMethod(t, Rental, 'find', (query) => {
    rentalQueries.push(query);
    return makeQuery([]);
  });
  stubMethod(t, Item, 'find', () => makeQuery([]));

  const searchReq = {
    query: {
      startDate: addDays(new Date(), 1).toISOString(),
      endDate: addDays(new Date(), 2).toISOString()
    }
  };
  const searchRes = makeRes();
  await itemsController.searchItems(searchReq, searchRes);

  assert.equal(searchRes.statusCode, 200);
  assert.equal(rentalQueries.length, 2);
  for (const query of rentalQueries) {
    assert.deepEqual(query.status.$in, ACTIVE_BOOKING_STATUSES);
    assert.ok(query.status.$in.includes(RentalStatus.DISPUTED));
  }

  let blockConflictQuery = null;
  stubMethod(t, Rental, 'findOne', (query) => {
    blockConflictQuery = query;
    return makeQuery({ _id: new mongoose.Types.ObjectId(), code: 'RT777' });
  });

  const blockReq = {
    item: {
      _id: new mongoose.Types.ObjectId(),
      blockedDates: [],
      async save() {}
    },
    body: {
      startDate: addDays(new Date(), 5).toISOString(),
      endDate: addDays(new Date(), 6).toISOString(),
      reason: 'Personal use'
    }
  };
  const blockRes = makeRes();
  await itemsController.addBlockedDates(blockReq, blockRes);

  assert.equal(blockRes.statusCode, 409);
  assert.deepEqual(blockConflictQuery.status.$in, ACTIVE_BOOKING_STATUSES);
  assert.ok(blockConflictQuery.status.$in.includes(RentalStatus.DISPUTED));
});

test('views.getItemDetailView queries with disputed status and toStartOfDay(today)', async (t) => {
  const itemId = new mongoose.Types.ObjectId();
  const today = toStartOfDay(new Date());

  stubMethod(t, Item, 'findById', () => makeQuery({
    _id: itemId,
    code: 'SP001',
    name: 'Camera',
    description: 'Desc',
    category: 'Camera',
    status: ItemStatus.AVAILABLE,
    isFeatured: false,
    images: [],
    pricePerDay: 100000,
    baseValue: 1000000,
    depositPercentage: 50,
    address: 'HCM',
    blockedDates: [
      { startDate: addDays(today, -3), endDate: addDays(today, -1), reason: 'past' },
      { startDate: today, endDate: addDays(today, 1), reason: 'today' }
    ]
  }));

  let rentalQuery = null;
  stubMethod(t, Rental, 'find', (query) => {
    rentalQuery = query;
    return makeQuery([]);
  });

  const req = {
    params: { id: itemId.toString() },
    headers: {}
  };
  const res = makeRes();

  await viewsController.getItemDetailView(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(rentalQuery.status.$in, ACTIVE_BOOKING_STATUSES);
  assert.ok(rentalQuery.status.$in.includes(RentalStatus.DISPUTED));
  assert.equal(rentalQuery.endDate.$gte.getHours(), 0);
  assert.equal(rentalQuery.endDate.$gte.getMinutes(), 0);
  assert.equal(rentalQuery.endDate.$gte.getSeconds(), 0);
  assert.equal(rentalQuery.endDate.$gte.getMilliseconds(), 0);
  assert.equal(res.body.blockedDates.length, 1);
  assert.equal(res.body.blockedDates[0].reason, 'today');
});

test('approvePickup syncs item runtime status after rental becomes in_progress', async (t) => {
  const rentalId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const recordedBy = new mongoose.Types.ObjectId();
  const approverId = new mongoose.Types.ObjectId();

  const rentalDoc = {
    _id: rentalId,
    itemId,
    renterId: approverId,
    ownerId: recordedBy,
    status: RentalStatus.CONFIRMED,
    pickupReport: { recordedBy },
    async save() {
      return rentalDoc;
    }
  };

  let itemSaved = false;
  const itemDoc = {
    _id: itemId,
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: false,
    async save() {
      itemSaved = true;
      return itemDoc;
    }
  };

  stubMethod(t, Rental, 'findById', () => makeQuery(rentalDoc));
  stubMethod(t, Item, 'findById', () => makeQuery(itemDoc));
  stubMethod(t, Rental, 'findOne', (query) => {
    assert.deepEqual(query.status.$in, RUNTIME_RENTED_STATUSES);
    return makeQuery({ _id: rentalId });
  });

  const req = {
    params: { id: rentalId.toString() },
    user: { _id: approverId },
    body: {}
  };
  const res = makeRes();

  await rentalsController.approvePickup(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(rentalDoc.status, RentalStatus.IN_PROGRESS);
  assert.equal(itemSaved, true);
  assert.equal(itemDoc.status, ItemStatus.RENTED);
});

test('syncItemRuntimeStatus preserves DELISTED and delistedByAdmin items', async (t) => {
  const delistedItemId = new mongoose.Types.ObjectId();
  const adminDelistedItemId = new mongoose.Types.ObjectId();

  let delistedSaveCalled = false;
  const delistedDoc = {
    _id: delistedItemId,
    status: ItemStatus.DELISTED,
    delistedByAdmin: false,
    async save() {
      delistedSaveCalled = true;
    }
  };

  let adminSaveCalled = false;
  const adminDelistedDoc = {
    _id: adminDelistedItemId,
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: true,
    async save() {
      adminSaveCalled = true;
    }
  };

  let rentalFindOneCalled = false;
  stubMethod(t, Rental, 'findOne', () => {
    rentalFindOneCalled = true;
    return makeQuery(null);
  });

  stubMethod(t, Item, 'findById', (id) => {
    if (id === delistedItemId) return makeQuery(delistedDoc);
    return makeQuery(adminDelistedDoc);
  });

  const res1 = await syncItemRuntimeStatus(delistedItemId);
  const res2 = await syncItemRuntimeStatus(adminDelistedItemId);

  assert.equal(res1.status, ItemStatus.DELISTED);
  assert.equal(res2.status, ItemStatus.AVAILABLE);
  assert.equal(delistedSaveCalled, false);
  assert.equal(adminSaveCalled, false);
  assert.equal(rentalFindOneCalled, false);
});
