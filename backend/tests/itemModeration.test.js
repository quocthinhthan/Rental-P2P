const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Item = require('../models/Item.model');
const Rental = require('../models/Rental.model');
const ItemReport = require('../models/ItemReport.model');
const AuditLog = require('../models/AuditLog.model');
const User = require('../models/User.model');
const Review = require('../models/Review.model');
const Dispute = require('../models/Dispute.model');
const { ItemStatus } = require('../enums/item.enum');
const { ItemReportStatus, ItemReportAction } = require('../models/ItemReport.model');

const itemsController = require('../controllers/items.controller');
const adminController = require('../controllers/admin.controller');

const makeQuery = (value) => ({
  select() {
    return this;
  },
  then(onFulfilled, onRejected) {
    return Promise.resolve(value).then(onFulfilled, onRejected);
  }
});

const stubMethod = (t, target, key, impl) => {
  const original = target[key];
  target[key] = impl;
  t.after(() => {
    target[key] = original;
  });
};

const createMockRes = () => {
  const res = {
    statusCode: null,
    body: undefined,
    sent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.sent = true;
      this.body = payload;
      return this;
    }
  };
  return res;
};

const createMockItem = (overrides = {}) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    ownerId: new mongoose.Types.ObjectId(),
    name: 'Sony A7 III',
    description: 'Camera',
    category: 'Máy ảnh',
    pricePerDay: 500000,
    baseValue: 30000000,
    depositPercentage: 50,
    address: 'Q7',
    images: ['https://example.com/1.jpg'],
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: false,
    adminDelistReason: '',
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides
  };
  return doc;
};

test('1. updateItem blocks entire PUT with 403 when delistedByAdmin is true without mutating or saving', async (t) => {
  let rentalFindOneCalled = false;
  stubMethod(t, Rental, 'findOne', () => {
    rentalFindOneCalled = true;
    return makeQuery(null);
  });

  const item = createMockItem({
    status: ItemStatus.DELISTED,
    delistedByAdmin: true,
    adminDelistReason: 'Vi phạm chính sách'
  });

  const req = {
    item,
    body: {
      name: 'Attempted Rename',
      pricePerDay: 999999,
      status: ItemStatus.AVAILABLE,
      delistedByAdmin: false
    }
  };
  const res = createMockRes();

  await itemsController.updateItem(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /quản trị viên/i);
  assert.equal(item.name, 'Sony A7 III');
  assert.equal(item.pricePerDay, 500000);
  assert.equal(item.status, ItemStatus.DELISTED);
  assert.equal(item.delistedByAdmin, true);
  assert.equal(item.saveCalls, 0);
  assert.equal(rentalFindOneCalled, false);
});

test('2. updateItem allows owner re-enabling self-delisted item and ignores admin-only fields from body', async (t) => {
  stubMethod(t, Rental, 'findOne', () => makeQuery(null));

  const item = createMockItem({
    status: ItemStatus.DELISTED,
    delistedByAdmin: false,
    adminDelistReason: ''
  });

  const req = {
    item,
    body: {
      name: 'Sony A7 III Updated',
      status: ItemStatus.AVAILABLE,
      delistedByAdmin: true,
      adminDelistReason: 'Spoofed reason'
    }
  };
  const res = createMockRes();

  await itemsController.updateItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(item.status, ItemStatus.AVAILABLE);
  assert.equal(item.name, 'Sony A7 III Updated');
  assert.equal(item.delistedByAdmin, false);
  assert.equal(item.adminDelistReason, '');
  assert.equal(item.saveCalls, 1);
});

test('3. updateItem blocks delisting when item has an active or disputed rental (400)', async (t) => {
  const activeRental = {
    _id: new mongoose.Types.ObjectId(),
    code: 'DH000123',
    status: 'disputed'
  };
  stubMethod(t, Rental, 'findOne', () => makeQuery(activeRental));

  const item = createMockItem({ status: ItemStatus.AVAILABLE });
  const req = {
    item,
    body: {
      name: 'Mutated Name Should Not Persist',
      status: ItemStatus.DELISTED
    }
  };
  const res = createMockRes();

  await itemsController.updateItem(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.activeRental, activeRental);
  assert.equal(item.name, 'Sony A7 III');
  assert.equal(item.status, ItemStatus.AVAILABLE);
  assert.equal(item.saveCalls, 0);
});

test('4. updateItem blocks setting available from rented when active rental exists (400), allows when none', async (t) => {
  const activeRental = {
    _id: new mongoose.Types.ObjectId(),
    code: 'DH000456',
    status: 'in_progress'
  };
  stubMethod(t, Rental, 'findOne', () => makeQuery(activeRental));

  const item = createMockItem({ status: ItemStatus.RENTED });
  const blockedRes = createMockRes();

  await itemsController.updateItem(
    { item, body: { name: 'Should Not Change', status: ItemStatus.AVAILABLE } },
    blockedRes
  );

  assert.equal(blockedRes.statusCode, 400);
  assert.deepEqual(blockedRes.body.activeRental, activeRental);
  assert.equal(item.name, 'Sony A7 III');
  assert.equal(item.status, ItemStatus.RENTED);
  assert.equal(item.saveCalls, 0);

  stubMethod(t, Rental, 'findOne', () => makeQuery(null));
  const okRes = createMockRes();
  await itemsController.updateItem(
    { item, body: { status: ItemStatus.AVAILABLE } },
    okRes
  );

  assert.equal(okRes.statusCode, 200);
  assert.equal(item.status, ItemStatus.AVAILABLE);
  assert.equal(item.saveCalls, 1);
});

test('5. deleteItem blocks on rented status, active rental, or historical rental; allows when zero rentals', async (t) => {
  let deleteCalled = false;
  stubMethod(t, Item, 'findByIdAndDelete', async () => {
    deleteCalled = true;
    return {};
  });

  // 5a: item status is rented
  {
    const item = createMockItem({ status: ItemStatus.RENTED });
    const res = createMockRes();
    await itemsController.deleteItem({ item, params: { id: item._id.toString() } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(deleteCalled, false);
  }

  // 5b: active rental exists
  {
    const activeRental = { _id: new mongoose.Types.ObjectId(), code: 'DH000789', status: 'confirmed' };
    stubMethod(t, Rental, 'findOne', () => makeQuery(activeRental));
    stubMethod(t, Rental, 'exists', async () => null);

    const item = createMockItem({ status: ItemStatus.AVAILABLE });
    const res = createMockRes();
    await itemsController.deleteItem({ item, params: { id: item._id.toString() } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body.activeRental, activeRental);
    assert.equal(deleteCalled, false);
  }

  // 5c: historical rental exists
  {
    stubMethod(t, Rental, 'findOne', () => makeQuery(null));
    stubMethod(t, Rental, 'exists', async () => ({ _id: new mongoose.Types.ObjectId() }));

    const item = createMockItem({ status: ItemStatus.AVAILABLE });
    const res = createMockRes();
    await itemsController.deleteItem({ item, params: { id: item._id.toString() } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /lịch sử thuê/i);
    assert.equal(deleteCalled, false);
  }

  // 5d: zero rentals
  {
    stubMethod(t, Rental, 'findOne', () => makeQuery(null));
    stubMethod(t, Rental, 'exists', async () => null);

    const item = createMockItem({ status: ItemStatus.AVAILABLE });
    const res = createMockRes();
    await itemsController.deleteItem({ item, params: { id: item._id.toString() } }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.sent, true);
    assert.equal(deleteCalled, true);
  }
});

test('6. admin.updateItemStatus sets and clears delistedByAdmin + adminDelistReason and logs AuditLog', async (t) => {
  const adminId = new mongoose.Types.ObjectId();
  const auditLogs = [];
  const item = createMockItem({
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: false,
    adminDelistReason: ''
  });

  stubMethod(t, Item, 'findById', async () => item);
  stubMethod(t, Rental, 'findOne', () => makeQuery(null));
  stubMethod(t, AuditLog, 'create', async (entry) => {
    auditLogs.push(entry);
    return entry;
  });

  // 6a: Admin delists item with reason (trimmed)
  const delistRes = createMockRes();
  await adminController.updateItemStatus(
    {
      params: { id: item._id.toString() },
      body: { status: ItemStatus.DELISTED, reason: '  Hàng giả mạo  ' },
      user: { _id: adminId }
    },
    delistRes
  );

  assert.equal(delistRes.statusCode, 200);
  assert.equal(item.status, ItemStatus.DELISTED);
  assert.equal(item.delistedByAdmin, true);
  assert.equal(item.adminDelistReason, 'Hàng giả mạo');
  assert.equal(item.saveCalls, 1);
  assert.equal(auditLogs.length, 1);
  assert.deepEqual(auditLogs[0].before, {
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: false,
    adminDelistReason: ''
  });
  assert.deepEqual(auditLogs[0].after, {
    status: ItemStatus.DELISTED,
    delistedByAdmin: true,
    adminDelistReason: 'Hàng giả mạo'
  });

  // 6b: Admin restores item to AVAILABLE -> clears delistedByAdmin + adminDelistReason
  const restoreRes = createMockRes();
  await adminController.updateItemStatus(
    {
      params: { id: item._id.toString() },
      body: { status: ItemStatus.AVAILABLE, reason: 'Đã xác minh lại' },
      user: { _id: adminId }
    },
    restoreRes
  );

  assert.equal(restoreRes.statusCode, 200);
  assert.equal(item.status, ItemStatus.AVAILABLE);
  assert.equal(item.delistedByAdmin, false);
  assert.equal(item.adminDelistReason, '');
  assert.equal(item.saveCalls, 2);
  assert.equal(auditLogs.length, 2);
  assert.deepEqual(auditLogs[1].before, {
    status: ItemStatus.DELISTED,
    delistedByAdmin: true,
    adminDelistReason: 'Hàng giả mạo'
  });
  assert.deepEqual(auditLogs[1].after, {
    status: ItemStatus.AVAILABLE,
    delistedByAdmin: false,
    adminDelistReason: ''
  });
});

test('7. admin.resolveItemReport sets delistedByAdmin even when already delisted and does NOT auto-relist on no_action/warn_owner', async (t) => {
  const adminId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const auditLogs = [];

  const stubTrustScoreDeps = (ownerDoc) => {
    stubMethod(t, User, 'findById', () => makeQuery(ownerDoc));
    stubMethod(t, Review, 'aggregate', async () => []);
    stubMethod(t, Rental, 'countDocuments', async () => 0);
    stubMethod(t, Dispute, 'find', () => makeQuery([]));
    stubMethod(t, Item, 'distinct', async () => []);
    stubMethod(t, ItemReport, 'find', () => makeQuery([]));
    stubMethod(t, User, 'findByIdAndUpdate', (_id, update) => makeQuery({
      _id: ownerDoc._id,
      trustScore: update.trustScore,
      isBanned: ownerDoc.isBanned
    }));
  };

  // 7a: Item already self-delisted by owner -> HIDE_ITEM still sets delistedByAdmin=true & saves item
  {
    auditLogs.length = 0;
    const ownerDoc = { _id: ownerId, ekycStatus: 'verified', trustScore: 70, isBanned: false };
    const item = createMockItem({
      ownerId,
      status: ItemStatus.DELISTED,
      delistedByAdmin: false,
      adminDelistReason: ''
    });
    const report = {
      _id: new mongoose.Types.ObjectId(),
      itemId: item._id,
      status: ItemReportStatus.PENDING,
      saveCalls: 0,
      async save() {
        this.saveCalls += 1;
        return this;
      }
    };

    stubTrustScoreDeps(ownerDoc);
    stubMethod(t, ItemReport, 'findById', async () => report);
    stubMethod(t, Item, 'findById', async () => item);
    stubMethod(t, AuditLog, 'create', async (entry) => {
      auditLogs.push(entry);
      return entry;
    });

    const res = createMockRes();
    await adminController.resolveItemReport(
      {
        params: { reportId: report._id.toString() },
        body: { action: ItemReportAction.HIDE_ITEM, resolutionNote: '' },
        user: { _id: adminId }
      },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(item.status, ItemStatus.DELISTED);
    assert.equal(item.delistedByAdmin, true);
    assert.equal(item.adminDelistReason, 'Admin resolved item report (hide_item)');
    assert.equal(item.saveCalls, 1);
    assert.equal(report.status, ItemReportStatus.RESOLVED);
    assert.equal(report.saveCalls, 1);
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].before.itemDelistedByAdmin, false);
    assert.equal(auditLogs[0].after.itemDelistedByAdmin, true);
  }

  // 7b: NO_ACTION on a delisted item must NOT auto-relist to AVAILABLE
  {
    auditLogs.length = 0;
    const ownerDoc = { _id: ownerId, ekycStatus: 'verified', trustScore: 70, isBanned: false };
    const item = createMockItem({
      ownerId,
      status: ItemStatus.DELISTED,
      delistedByAdmin: false,
      adminDelistReason: ''
    });
    const report = {
      _id: new mongoose.Types.ObjectId(),
      itemId: item._id,
      status: ItemReportStatus.PENDING,
      saveCalls: 0,
      async save() {
        this.saveCalls += 1;
        return this;
      }
    };

    stubTrustScoreDeps(ownerDoc);
    stubMethod(t, ItemReport, 'findById', async () => report);
    stubMethod(t, Item, 'findById', async () => item);
    stubMethod(t, AuditLog, 'create', async (entry) => {
      auditLogs.push(entry);
      return entry;
    });

    const res = createMockRes();
    await adminController.resolveItemReport(
      {
        params: { reportId: report._id.toString() },
        body: { action: ItemReportAction.NO_ACTION, resolutionNote: 'Không đủ bằng chứng' },
        user: { _id: adminId }
      },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(item.status, ItemStatus.DELISTED);
    assert.equal(item.delistedByAdmin, false);
    assert.equal(item.saveCalls, 0);
  }

  // 7c: WARN_OWNER on a delisted item must NOT auto-relist to AVAILABLE
  {
    auditLogs.length = 0;
    const ownerDoc = { _id: ownerId, ekycStatus: 'verified', trustScore: 70, isBanned: false };
    const item = createMockItem({
      ownerId,
      status: ItemStatus.DELISTED,
      delistedByAdmin: true,
      adminDelistReason: 'Admin hid earlier'
    });
    const report = {
      _id: new mongoose.Types.ObjectId(),
      itemId: item._id,
      status: ItemReportStatus.PENDING,
      saveCalls: 0,
      async save() {
        this.saveCalls += 1;
        return this;
      }
    };

    stubTrustScoreDeps(ownerDoc);
    stubMethod(t, ItemReport, 'findById', async () => report);
    stubMethod(t, Item, 'findById', async () => item);
    stubMethod(t, AuditLog, 'create', async (entry) => {
      auditLogs.push(entry);
      return entry;
    });

    const res = createMockRes();
    await adminController.resolveItemReport(
      {
        params: { reportId: report._id.toString() },
        body: { action: ItemReportAction.WARN_OWNER, resolutionNote: 'Cảnh cáo chủ đồ' },
        user: { _id: adminId }
      },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(item.status, ItemStatus.DELISTED);
    assert.equal(item.delistedByAdmin, true);
    assert.equal(item.saveCalls, 0);
  }
});
