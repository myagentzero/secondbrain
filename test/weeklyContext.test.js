const test = require('node:test');
const assert = require('node:assert');
const { buildWeeklyContext } = require('../src/digests/weekly');

const inbox = (id, filedTo, name) => ({
  id,
  properties: {
    'Original Text': { title: [{ plain_text: `text ${id}` }] },
    'Filed-To': { select: { name: filedTo } },
    'Destination Name': { rich_text: name ? [{ plain_text: name }] : [] }
  }
});
const page = (props) => ({ results: props });
const empty = { results: [] };

test('needs-review items are listed once, under NEEDS REVIEW', () => {
  const a = inbox('a', 'admin', 'Book flights');
  const b = inbox('b', 'Needs Review', '');
  const out = buildWeeklyContext(page([a, b]), empty, empty, page([b]), []);
  assert.strictEqual(out.split('text b').length - 1, 1);
  assert.ok(out.indexOf('Book flights') < out.indexOf('## NEEDS REVIEW'));
  assert.ok(!out.includes('CAPTURE SUMMARY'));
});

test('empty sections are omitted and empty fields are skipped', () => {
  assert.strictEqual(buildWeeklyContext(empty, empty, empty, empty, []), '');
  const admin = page([{ properties: { Name: { title: [{ plain_text: 'File taxes' }] }, 'Due Date': { date: { start: '2026-10-15' } } } }]);
  const out = buildWeeklyContext(empty, empty, admin, empty, [], '\n## WEEKLY TREND\nx\n');
  assert.ok(out.includes('1. File taxes') && out.includes('Due: 2026-10-15'));
  assert.ok(!out.includes('Notes:') && !out.includes('None'));
  assert.ok(out.includes('## WEEKLY TREND'));
});
