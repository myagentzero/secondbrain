const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../src/digests/weeklyStats');

const item = (cat) => ({ properties: { 'Filed-To': { select: { name: cat } } } });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')), 'stats.json');
const week = (d, captures = 1) => ({ weekEnding: d, captures, byCategory: { Ideas: captures }, tasksCompleted: 2 });

test('computeWeekStats counts categories and tasks', () => {
  const st = s.computeWeekStats([item('Ideas'), item('Ideas'), item('Admin')], [{}], new Date('2026-10-05T03:00:00Z'));
  assert.deepStrictEqual(st.byCategory, { ideas: 2, admin: 1 });
  assert.strictEqual(st.captures, 3);
  assert.strictEqual(st.tasksCompleted, 1);
  assert.strictEqual(st.weekEnding, '2026-10-04'); // Phoenix is UTC-7
});

test('category keys are lowercased and missing tasksCompleted is tolerated', () => {
  const st = s.computeWeekStats([item('Admin'), item('admin')], []);
  assert.deepStrictEqual(st.byCategory, { admin: 2 });
  const out = s.formatTrendSection(week('2026-10-04'), [{ weekEnding: '2026-09-27', captures: 4, byCategory: {} }]);
  assert.ok(out.includes('not recorded') && !out.includes('NaN') && !out.includes('null'));
});

test('saveWeekStats upserts and keeps current plus 5 prior weeks', () => {
  const f = tmpFile();
  for (let i = 1; i <= 8; i++) s.saveWeekStats(week(`2026-0${i}-01`), f);
  s.saveWeekStats(week('2026-08-01', 9), f);
  const weeks = s.loadStats(f);
  assert.strictEqual(weeks.length, 6);
  assert.strictEqual(weeks[0].weekEnding, '2026-03-01');
  assert.strictEqual(weeks.at(-1).captures, 9);
});

test('getHistory excludes the current week; missing file is empty', () => {
  const f = tmpFile();
  assert.deepStrictEqual(s.loadStats(f), []);
  s.saveWeekStats(week('2026-09-27'), f);
  s.saveWeekStats(week('2026-10-04'), f);
  assert.deepStrictEqual(s.getHistory('2026-10-04', f).map(w => w.weekEnding), ['2026-09-27']);
});

test('formatTrendSection handles no history and with history', () => {
  assert.ok(s.formatTrendSection(week('2026-10-04'), []).includes('No prior weeks'));
  const out = s.formatTrendSection(week('2026-10-04', 4), [week('2026-09-27', 2)]);
  assert.ok(out.includes('(this week)') && out.includes('average: 2.0 captures'));
});
