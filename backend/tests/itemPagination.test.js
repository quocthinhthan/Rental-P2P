const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const Item = require('../models/Item.model');
const Rental = require('../models/Rental.model');
const { searchItems } = require('../controllers/items.controller');

const sampleItem = { _id: new Types.ObjectId(), name: 'Camera', status: 'available' };

const requestItems = async (query) => {
  const response = {
    status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; }
  };
  await searchItems({ query }, response);
  assert.equal(response.code, 200);
  return response.data;
};

test('paginated item search counts the same filters and returns only the requested page', async (t) => {
  const cursor = {
    select: () => cursor,
    populate: () => cursor,
    sort: t.mock.fn(() => cursor),
    skip: t.mock.fn(() => cursor),
    limit: t.mock.fn(async () => [sampleItem])
  };
  const find = t.mock.method(Item, 'find', () => cursor);
  const count = t.mock.method(Item, 'countDocuments', async () => 21);
  t.mock.method(Rental, 'find', () => ({ select: async () => [] }));
  const result = await requestItems({ search: 'Camera', category: 'Tech', page: '2', limit: '20', includePagination: 'true' });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]._id, sampleItem._id);
  assert.deepEqual(result.pagination, { currentPage: 2, limit: 20, total: 21, totalPages: 2 });
  assert.deepEqual(cursor.sort.mock.calls[0].arguments, [{ createdAt: -1, _id: -1 }]);
  assert.deepEqual(cursor.skip.mock.calls[0].arguments, [20]);
  assert.deepEqual(cursor.limit.mock.calls[0].arguments, [20]);
  const [filters] = find.mock.calls[0].arguments;
  assert.ok(filters.name.$regex);
  assert.ok(filters.category.$regex);
  assert.deepEqual(count.mock.calls[0].arguments, [filters]);

  const legacy = await requestItems({ page: '1', limit: '10' });
  assert.ok(Array.isArray(legacy));
  assert.equal(count.mock.callCount(), 1);
});

test('nearby pagination uses the full date and location filters for both items and totals', async (t) => {
  const ownerId = new Types.ObjectId();
  const rentedId = new Types.ObjectId();
  const blockedId = new Types.ObjectId();
  t.mock.method(Rental, 'find', (query) => ({
    select: async () => query.itemId ? [] : [{ itemId: rentedId }]
  }));
  t.mock.method(Item, 'find', () => ({ select: async () => [{ _id: blockedId }] }));
  const aggregate = t.mock.method(Item, 'aggregate', async (pipeline) => (
    pipeline[1].$facet
      ? [{ items: [], totals: [{ total: 32 }] }]
      : [{ ...sampleItem, location: { coordinates: [106.7, 10.7] } }]
  ));

  const result = await requestItems({
    lat: '10.7', lng: '106.7', radius: '8', ownerId: ownerId.toString(),
    startDate: '2026-12-01', endDate: '2026-12-02', page: '4', limit: '10', includePagination: '1'
  });
  assert.deepEqual(result, { items: [], pagination: { currentPage: 4, limit: 10, total: 32, totalPages: 4 } });
  const [nearby, facet] = aggregate.mock.calls[0].arguments[0];
  assert.equal(nearby.$geoNear.maxDistance, 8000);
  assert.deepEqual(nearby.$geoNear.query.ownerId, ownerId);
  assert.deepEqual(nearby.$geoNear.query._id.$nin, [rentedId, blockedId]);
  assert.deepEqual(facet.$facet.items.slice(0, 3), [
    { $sort: { distance: 1, _id: 1 } }, { $skip: 30 }, { $limit: 10 }
  ]);
  assert.deepEqual(facet.$facet.totals, [{ $count: 'total' }]);

  const markers = await requestItems({ lat: '10.7', lng: '106.7', includeMapLocation: 'true', limit: '50' });
  assert.ok(Array.isArray(markers));
  assert.deepEqual(markers[0].mapLocation, { lng: 106.7, lat: 10.7 });
  assert.deepEqual(aggregate.mock.calls[1].arguments[0][1], { $skip: 0 });
});
