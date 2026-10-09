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
  for (const d of ['people', 'projects', 'admin', 'needs_review']) assert.ok(out.includes(d));
  assert.ok(out.includes('0.6'));
  assert.ok(out.includes('<message>\ncall Dan\n</message>'));
  noPlaceholders(out.replace('{{TODAY}}', ''));
});

test('reclassification prompt fills category (twice) and defaults status', () => {
  const out = p.buildReclassificationPrompt('task text', 'admin', undefined, NOW);
  assert.equal(out.match(/admin record/g).length, 1);
  assert.ok(out.includes('"destination": "admin"'));
  assert.ok(out.includes('Status: Backlog'));
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

test('digest prompts use the configured name, with a fallback and no leftover placeholders', () => {
  for (const build of [
    (name) => p.buildDailyDigestPrompt('c', [], [], NOW, name),
    (name) => p.buildWeeklyDigestPrompt('c', [], NOW, name)
  ]) {
    const named = build('Bryan');
    assert.ok(named.includes('Bryan is a Director of Engineering'));
    assert.ok(!named.includes('the user'));
    noPlaceholders(named);

    const fallback = build(undefined);
    assert.ok(fallback.includes('The user is a Director of Engineering'));
    noPlaceholders(fallback);
  }
});

test('new records default to Backlog and only the digest activates them', () => {
  const { buildCategorizationPrompt, buildDailyDigestPrompt } = require('../src/claude/prompts');
  const cat = buildCategorizationPrompt('Call Sam');
  assert.ok(cat.includes('starts as "Backlog"') && cat.includes('never output "Active"'));
  assert.ok(p.buildReclassificationPrompt('x', 'admin').includes('Status: Backlog'));
  assert.ok(buildDailyDigestPrompt('ctx').includes('sourceId'));
});
