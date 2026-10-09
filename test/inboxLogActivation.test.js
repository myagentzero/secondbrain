const test = require('node:test');
const assert = require('node:assert');

// Stub the Notion client so no network is used; databases.js is loaded against the stub.
const clientPath = require.resolve('../src/notion/client');
const calls = { queries: [], updates: [] };
let rows = [];
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    getDatabaseIds: () => ({ inboxLog: 'inbox-db' }),
    queryDatabase: async (params) => {
      calls.queries.push(params);
      return { results: rows, has_more: false };
    },
    createPage: async () => ({}),
    updatePage: async (params) => {
      calls.updates.push(params);
      return {};
    }
  }
};
const { activateInboxLogEntries } = require('../src/notion/databases');

test('every Backlog Inbox Log row for a record is promoted to Active', async () => {
  rows = [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }];
  const count = await activateInboxLogEntries('rec-1');

  assert.strictEqual(count, 3);
  assert.deepStrictEqual(calls.updates.map(u => u.page_id), ['row-1', 'row-2', 'row-3']);
  assert.ok(calls.updates.every(u => u.properties.Status.select.name === 'Active'));
});

test('only Backlog rows for that record are queried, so Done rows stay Done', async () => {
  const filter = calls.queries[0].filter;
  assert.deepStrictEqual(filter.and, [
    { property: 'Notion Record ID', rich_text: { equals: 'rec-1' } },
    { property: 'Status', select: { equals: 'Backlog' } }
  ]);
});

test('a record with no Backlog rows updates nothing', async () => {
  rows = [];
  calls.updates.length = 0;
  assert.strictEqual(await activateInboxLogEntries('rec-2'), 0);
  assert.strictEqual(calls.updates.length, 0);
});
