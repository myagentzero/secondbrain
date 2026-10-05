const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/claude/prompts');

// Noon UTC on a Monday: still Monday in America/Phoenix (UTC-7).
const NOW = new Date('2026-07-20T19:00:00Z');

const noPlaceholders = (s) => assert.doesNotMatch(s, /{{\w+}}/);

test('getDateContext uses Phoenix time', () => {
  assert.deepEqual(p.getDateContext(new Date('2026-07-21T03:00:00Z')), { date: 'July 20, 2026', dayOfWeek: 'Monday' });
});

test('render leaves user text untouched ($ patterns and placeholders)', () => {
  const out = p.buildCategorizationPrompt('pay $& and $1 and {{TODAY}}', NOW);
  assert.ok(out.includes('pay $& and $1 and {{TODAY}}'));
});

test('categorization prompt is fully rendered and lists every destination', () => {
  const out = p.buildCategorizationPrompt('call Dan', NOW);
  assert.match(out, /July 20, 2026 \(Monday\)/);
  for (const d of ['people', 'projects', 'ideas', 'admin', 'needs_review']) assert.ok(out.includes(d));
  assert.ok(out.includes('0.6'));
  assert.ok(out.includes('<message>\ncall Dan\n</message>'));
  noPlaceholders(out.replace('{{TODAY}}', ''));
});

test('reclassification prompt fills category (twice) and defaults status', () => {
  const out = p.buildReclassificationPrompt('idea text', 'ideas', undefined, NOW);
  assert.equal(out.match(/ideas record/g).length, 1);
  assert.ok(out.includes('"destination": "ideas"'));
  assert.ok(out.includes('Status: Active'));
  noPlaceholders(out);
});

test('daily digest includes task sections only when non-empty', () => {
  const empty = p.buildDailyDigestPrompt('ctx', [], [], NOW);
  assert.ok(!empty.includes('<existing_tasks'));
  assert.ok(!empty.includes('<completed_tasks'));
  noPlaceholders(empty);

  const full = p.buildDailyDigestPrompt('ctx', [{ title: 'A' }], [{ title: 'B' }], NOW);
  assert.ok(full.includes('- A'));
  assert.ok(full.includes('- B'));
  noPlaceholders(full);
});

test('weekly digest renders completed tasks and context', () => {
  const out = p.buildWeeklyDigestPrompt('CAPTURE SUMMARY x', [{ title: 'Done thing' }], NOW);
  assert.ok(out.includes('CAPTURE SUMMARY x'));
  assert.ok(out.includes('- Done thing'));
  noPlaceholders(out);
  assert.ok(!p.buildWeeklyDigestPrompt('c', [], NOW).includes('COMPLETED TASKS LAST WEEK\n'));
});

test('task match prompt renders both lists', () => {
  const out = p.buildTaskMatchPrompt('1. Ship it', '- ID: abc');
  assert.ok(out.includes('1. Ship it') && out.includes('- ID: abc'));
  noPlaceholders(out);
});

test('prompts stay compact', () => {
  // Rough token guard (~4 chars/token) on the static text.
  for (const out of [
    p.buildCategorizationPrompt('', NOW),
    p.buildReclassificationPrompt('', 'admin', '', NOW),
    p.buildDailyDigestPrompt('', [], [], NOW),
    p.buildWeeklyDigestPrompt('', [], NOW)
  ]) assert.ok(out.length < 4000, `prompt is ${out.length} chars`);
});
