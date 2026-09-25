// Storage on Netlify Blobs (used by the Netlify Function). Each response is its own blob,
// so guests answering at the same moment never overwrite each other.
const crypto = require('node:crypto');
const { byNewest } = require('./api');

const PREFIX = 'responses/';
const SETTINGS_KEY = 'settings';

function newId() {
  return Date.now().toString(36).padStart(9, '0') + '-' + crypto.randomBytes(4).toString('hex');
}

const COUNTER_PREFIX = 'limits/';

// Wraps a strongly-consistent store; if a strong read/write fails in this environment, the same
// call is retried once on the regular (eventually-consistent) store so guests are never blocked.
function withFallback(strong, eventual) {
  if (!eventual) return strong;
  const call = (method) => async (...args) => {
    try {
      return await strong[method](...args);
    } catch (err) {
      console.error(`blobs ${method} failed with strong consistency, retrying:`, err && err.name, err && err.message);
      return eventual[method](...args);
    }
  };
  return { get: call('get'), setJSON: call('setJSON'), list: call('list'), delete: call('delete') };
}

const counterKey = (key) => COUNTER_PREFIX + crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);

function createBlobsStore(strongStore, eventualStore) {
  const store = withFallback(strongStore, eventualStore);
  return {
    kind: 'netlify-blobs',
    async getCounter(key) {
      return (await store.get(counterKey(key), { type: 'json' })) || null;
    },
    async setCounter(key, rec) {
      await store.setJSON(counterKey(key), rec);
    },
    async addResponse({ firstName, lastName, status, people, editTokenHash }) {
      const response = {
        id: newId(),
        firstName,
        lastName,
        status,
        people,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        editTokenHash,
      };
      await store.setJSON(PREFIX + response.id, response);
      return response;
    },
    async listResponses() {
      const { blobs } = await store.list({ prefix: PREFIX });
      const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
      return items.filter(Boolean).sort(byNewest);
    },
    async getResponse(id) {
      return (await store.get(PREFIX + id, { type: 'json' })) || null;
    },
    async updateResponse(id, { firstName, lastName, status, people }, { editTokenHash, history } = {}) {
      const existing = await store.get(PREFIX + id, { type: 'json' });
      if (!existing) return null;
      const updated = { ...existing, firstName, lastName, status, people, updatedAt: new Date().toISOString() };
      if (editTokenHash) updated.editTokenHash = editTokenHash;
      if (history) updated.history = history;
      await store.setJSON(PREFIX + id, updated);
      return updated;
    },
    async deleteResponse(id) {
      const existing = await store.get(PREFIX + id, { type: 'json' });
      if (!existing) return false;
      await store.delete(PREFIX + id);
      return true;
    },
    async getSettings() {
      return (await store.get(SETTINGS_KEY, { type: 'json' })) || {};
    },
    async setSettings(updates) {
      const current = (await store.get(SETTINGS_KEY, { type: 'json' })) || {};
      await store.setJSON(SETTINGS_KEY, { ...current, ...updates });
    },
  };
}

module.exports = { createBlobsStore };
