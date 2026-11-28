const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Item = require('../models/Item.model');

const controllerPath = require.resolve('../controllers/items.controller');

const loadSuggestPrice = (t, apiKey) => {
  const originalApiKey = process.env.GEMINI_API_KEY;
  if (apiKey) process.env.GEMINI_API_KEY = apiKey;
  else delete process.env.GEMINI_API_KEY;
  delete require.cache[controllerPath];

  t.after(() => {
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
    delete require.cache[controllerPath];
  });
  return require(controllerPath).suggestPrice;
};

const requestSuggestion = async (suggestPrice, name) => {
  const res = {
    status(code) { this.code = code; return this; },
    json(data) { this.body = data; return this; }
  };
  await suggestPrice({ body: { name, category: 'Laptop', baseValue: 10_000_000 } }, res);
  assert.equal(res.code, 200);
  return res.body;
};

test('missing Gemini configuration returns the full rule-based price', async (t) => {
  const suggestPrice = loadSuggestPrice(t);
  const result = await requestSuggestion(suggestPrice, 'Laptop without Gemini');
  assert.equal(result.ruleBasedPrice, 150_000);
  assert.equal(result.aiSuggestedPrice, null);
  assert.equal(result.finalSuggestion, result.ruleBasedPrice);
});

test('unusable Gemini prices fall back, and a valid price is averaged', async (t) => {
  const suggestPrice = loadSuggestPrice(t, 'local-mock-api-key');
  t.mock.method(Item, 'countDocuments', async () => 0);
  let aiResponse;
  t.mock.method(GoogleGenerativeAI.prototype, 'getGenerativeModel', () => ({
    generateContent: async () => {
      if (aiResponse instanceof Error) throw aiResponse;
      return { response: { text: () => aiResponse } };
    }
  }));

  const invalidResponses = [
    '{}',
    '{"suggestedPrice":"invalid"}',
    '{"suggestedPrice":1500000}',
    'not JSON',
    new Error('mock quota error')
  ];
  for (const [index, response] of invalidResponses.entries()) {
    aiResponse = response;
    const result = await requestSuggestion(suggestPrice, `Invalid Gemini response ${index}`);
    assert.equal(result.aiSuggestedPrice, null);
    assert.equal(result.finalSuggestion, result.ruleBasedPrice);
  }

  aiResponse = '{"suggestedPrice":200000}';
  const valid = await requestSuggestion(suggestPrice, 'Valid Gemini response');
  assert.equal(valid.aiSuggestedPrice, 200_000);
  assert.equal(valid.finalSuggestion, 175_000);
});
