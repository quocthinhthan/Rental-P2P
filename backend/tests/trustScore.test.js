const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const User = require('../models/User.model');
const Review = require('../models/Review.model');
const Rental = require('../models/Rental.model');
const Item = require('../models/Item.model');
const Dispute = require('../models/Dispute.model');
const AuditLog = require('../models/AuditLog.model');
const { updateUserStatus } = require('../controllers/admin.controller');
const { recalculateUserTrustScore } = require('../services/trustScore.service');

test('account ban controls the zero override and unban restores the calculated score', async (t) => {
  const user = { _id: new Types.ObjectId(), ekycStatus: 'verified', isBanned: true, async save() {} };
  const history = ['ban', 'warning'].map((penaltyType) => ({ penaltyType }));
  t.mock.method(User, 'findById', () => Object.assign(Promise.resolve(user), { select: async () => user }));
  t.mock.method(User, 'findByIdAndUpdate', (_id, update) => ({
    select: async () => Object.assign(user, update)
  }));
  t.mock.method(Review, 'aggregate', async () => [{ averageRating: 5, totalReviews: 1 }]);
  t.mock.method(Rental, 'countDocuments', async () => 3);
  t.mock.method(Item, 'distinct', async () => []);
  t.mock.method(Dispute, 'find', ({ penaltyType }) => ({
    select: async () => history.filter((entry) => penaltyType.$in.includes(entry.penaltyType))
  }));
  const audit = t.mock.method(AuditLog, 'create', async (entry) => entry);

  assert.equal((await recalculateUserTrustScore(user._id)).trustScore, 0);
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  await updateUserStatus({
    params: { id: user._id },
    body: { isBanned: false },
    user: { _id: new Types.ObjectId() }
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.trustScore, 71);
  assert.equal(audit.mock.calls[0].arguments[0].after.trustScore, 71);
  assert.deepEqual(history.map((entry) => entry.penaltyType), ['ban', 'warning']);
  user.suspendedUntil = new Date(Date.now() + 60_000);
  assert.equal((await recalculateUserTrustScore(user._id)).trustScore, 40);
});
