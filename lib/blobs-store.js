// Storage on Netlify Blobs (used by the Netlify Function). Each response is its own blob,
// so guests answering at the same moment never overwrite each other.
const crypto = require('node:crypto');
const { byNewest } = require('./api');

const PREFIX = 'responses/';
const SETTINGS_KEY = 'settings';

function newId() {
  return Date.now().toString(36).padStart(9, '0') + '-' + crypto.randomBytes(4).toString('hex');
}

function createBlobsStore(store) {
  return {
    kind: 'netlify-blobs',
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
    async updateResponse(id, { firstName, lastName, status, people }) {
      const existing = await store.get(PREFIX + id, { type: 'json' });
      if (!existing) return null;
      const updated = { ...existing, firstName, lastName, status, people, updatedAt: new Date().toISOString() };
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
