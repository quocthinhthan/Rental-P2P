const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const Rental = require('../models/Rental.model');
const Contract = require('../models/Contract.model');
const Item = require('../models/Item.model');
const User = require('../models/User.model');
const rentals = require('../controllers/rentals.controller');
const router = require('../routes/rentals.routes');
const { checkVerified } = require('../middleware/auth.middleware');

const rentalId = new Types.ObjectId();
const renterId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const outsiderId = new Types.ObjectId();
const itemId = new Types.ObjectId();
const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim() || 'test-cloud';
const photo = `https://res.cloudinary.com/${cloudName}/image/upload/v1/handover.png`;

const invoke = async (handler, userId, body) => {
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  await handler({ params: { id: rentalId }, user: { _id: userId }, body }, res);
  return res;
};

const scenarios = [
  {
    report: 'pickupReport', photos: 'pickupImages', state: 'confirmed', approvedState: 'in_progress',
    record: rentals.pickupItem, approve: rentals.approvePickup
  },
  {
    report: 'returnReport', photos: 'returnImages', state: 'in_progress', approvedState: 'completed',
    record: rentals.completeRental, approve: rentals.approveReturn
  }
];

for (const { report, photos, state, approvedState, record, approve } of scenarios) {
  test(`${report}: only a rental participant can record, and concurrent submissions cannot overwrite it`, async (t) => {
    const rental = { _id: rentalId, renterId, ownerId, itemId, status: state };
    t.mock.method(Rental, 'findById', async () => ({ ...rental }));
    t.mock.method(Contract, 'findById', async () => ({ isFullySigned: true }));
    const writes = t.mock.method(Rental, 'findOneAndUpdate', async (filter, update) => {
      assert.equal(filter.status, state);
      assert.equal(filter[`${report}.recordedBy`], null);
      if (rental[report]?.recordedBy) return null;
      return Object.assign(rental, update.$set);
    });

    const valid = { [photos]: [photo] };
    assert.equal((await invoke(record, outsiderId, valid)).statusCode, 403);
    assert.equal((await invoke(record, renterId, { [photos]: photo })).statusCode, 400);
    assert.equal((await invoke(record, renterId, { [photos]: ['https://example.com/photo.png'] })).statusCode, 400);
    assert.equal(writes.mock.callCount(), 0);

    const results = await Promise.all([
      invoke(record, renterId, { ...valid, accessories: 'Recorder A' }),
      invoke(record, ownerId, { ...valid, accessories: 'Recorder B' })
    ]);
    assert.deepEqual(results.map((res) => res.statusCode).sort(), [200, 409]);
    const saved = rental[report];
    assert.equal(rental.status, state);
    assert.equal((await invoke(record, renterId, valid)).statusCode, 409);
    assert.equal((await invoke(record, ownerId, valid)).statusCode, 409);
    assert.equal(rental[report], saved);
  });

  test(`${report}: counterpart can clear fields, invalid image edits are rejected, and approval is conditional`, async (t) => {
    const rental = {
      _id: rentalId,
      renterId,
      ownerId,
      itemId,
      status: state,
      [report]: { recordedBy: renterId, accessories: 'Case', notes: 'Notes' },
      [photos]: [photo],
      async save() {
        assert.deepEqual(this.$where, {
          status: state,
          [`${report}.recordedBy`]: renterId,
          [`${report}.approvedBy`]: null
        });
        saved = true;
      }
    };
    let saved = false;
    t.mock.method(Rental, 'findById', async () => rental);
    t.mock.method(Item, 'findById', () => ({ select: async () => ({ status: 'delisted' }) }));
    t.mock.method(User, 'findById', () => ({ select: async () => null }));

    assert.equal((await invoke(approve, outsiderId)).statusCode, 403);
    assert.equal((await invoke(approve, renterId)).statusCode, 403);
    for (const override of [[], 'not-an-array', [photo, 'https://example.com/photo.png']]) {
      assert.equal((await invoke(approve, ownerId, { [photos]: override })).statusCode, 400);
    }
    assert.equal(saved, false);
    assert.equal(rental[report].accessories, 'Case');

    const res = await invoke(approve, ownerId, { accessories: '', notes: '' });
    assert.equal(res.statusCode, 200);
    assert.equal(saved, true);
    assert.equal(rental.status, approvedState);
    assert.equal(rental[report].recordedBy, renterId);
    assert.equal(rental[report].approvedBy, ownerId);
    assert.equal(rental[report].accessories, '');
    assert.equal(rental[report].notes, '');
    assert.deepEqual(rental[photos], [photo]);
  });
}

test('eKYC is required to initiate pickup and is not a gate for approval or return', () => {
  for (const path of ['pickup', 'approve-pickup', 'complete', 'approve-return']) {
    const route = router.stack.find((layer) => layer.route?.path === `/:id/${path}`).route;
    assert.equal(route.stack.some((layer) => layer.handle === checkVerified), path === 'pickup');
  }
});
