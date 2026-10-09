const test = require('node:test');
const assert = require('node:assert');
const { buildDailyContext } = require('../src/digests/daily');
const { isSameEvent } = require('../src/calendar/sync');

const empty = { results: [] };
const admin = (name, due, notes) => ({
  properties: {
    Name: { title: [{ plain_text: name }] },
    'Due Date': due ? { date: { start: due } } : { date: null },
    Notes: { rich_text: notes ? [{ plain_text: notes }] : [] }
  }
});
const person = (name, followUp) => ({
  properties: {
    Name: { title: [{ plain_text: name }] },
    Status: { select: { name: 'Active' } },
    'Follow-ups': { rich_text: followUp ? [{ plain_text: followUp }] : [] }
  }
});

test('daily context omits empty sections and people without follow-ups', () => {
  assert.strictEqual(buildDailyContext(empty, empty, empty, empty), '');
  const out = buildDailyContext(empty, { results: [person('Ann', 'Send deck'), person('Bob', '')] }, empty, empty);
  assert.ok(out.includes('1. Ann') && out.includes('Follow-up: Send deck'));
  assert.ok(!out.includes('Bob'));
});

test('key alert is numbered first and tasks continue the numbering', () => {
  const alert = { name: 'Renew key', dueDate: '2026-10-06', notes: 'Key expires in 2 day(s)' };
  const out = buildDailyContext(empty, empty, { results: [admin('File taxes', '2026-10-04')] }, empty, alert);
  assert.ok(out.indexOf('1. Renew key [URGENT]') < out.indexOf('2. File taxes'));
  assert.ok(out.includes('Due: 2026-10-04') && !out.includes('Notes: undefined'));
});

test('daily context exposes record IDs and statuses so tasks can cite their source', () => {
  const task = { id: 'abc-123', ...admin('File taxes', '2026-10-04') };
  task.properties.Status = { select: { name: 'Backlog' } };
  const out = buildDailyContext(empty, empty, { results: [task] }, empty);
  assert.ok(out.includes('ID: abc-123') && out.includes('Status: Backlog'));
});

test('events match on title and start instant, not title alone', () => {
  const ev = (summary, dateTime) => ({ summary, start: { dateTime } });
  assert.ok(isSameEvent(ev('Standup', '2026-10-05T16:00:00.000Z'), ev('Standup', '2026-10-05T09:00:00-07:00')));
  assert.ok(!isSameEvent(ev('Standup', '2026-10-05T16:00:00.000Z'), ev('Standup', '2026-10-06T16:00:00.000Z')));
  assert.ok(!isSameEvent(ev('Standup', '2026-10-05T16:00:00.000Z'), ev('Retro', '2026-10-05T16:00:00.000Z')));
});

test('mergeText puts new text first and skips repeats', () => {
  const { mergeText } = require('../src/notion/databases');
  assert.strictEqual(mergeText('', 'new'), 'new');
  assert.strictEqual(mergeText('old', ''), 'old');
  assert.strictEqual(mergeText('old', 'new'), 'new\nold');
  assert.strictEqual(mergeText('new\nold', 'new'), 'new\nold');
});

test('rows without a Slack thread (e.g. from parakeet-notes) yield no thread TS', () => {
  const { getSlackThreadTs } = require('../src/notion/databases');
  assert.strictEqual(getSlackThreadTs({ properties: { 'Slack Thread TS': { rich_text: [] } } }), null);
  assert.strictEqual(getSlackThreadTs({ properties: {} }), null);
  assert.strictEqual(getSlackThreadTs(undefined), null);
  assert.strictEqual(getSlackThreadTs({ properties: { 'Slack Thread TS': { rich_text: [{ plain_text: ' ' }] } } }), null);
  assert.strictEqual(getSlackThreadTs({ properties: { 'Slack Thread TS': { rich_text: [{ plain_text: '1760000000.000100' }] } } }), '1760000000.000100');
});
