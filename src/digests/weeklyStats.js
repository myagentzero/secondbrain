const fs = require('fs');
const path = require('path');

const STATS_PATH = path.join(__dirname, '..', '..', 'data', 'weekly-stats.json');
const HISTORY_WEEKS = 5;
const TIMEZONE = 'America/Phoenix';

// YYYY-MM-DD in Phoenix time; this is the key for the week ending that day
const weekKey = (now = new Date()) =>
  now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

// Reduce the week's raw data to the numbers we keep long-term
const computeWeekStats = (inboxItems, completedTasks, now = new Date()) => {
  const byCategory = {};
  inboxItems.forEach(item => {
    // Lowercased so 'Admin' and 'admin' don't split into separate buckets
    const cat = (item.properties?.['Filed-To']?.select?.name || 'Unknown').toLowerCase();
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });

  return {
    weekEnding: weekKey(now),
    captures: inboxItems.length,
    byCategory,
    tasksCompleted: completedTasks.length
  };
};

// Returns all stored weeks, oldest first. Missing or corrupt file means no history.
const loadStats = (filePath = STATS_PATH) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed.weeks) ? parsed.weeks : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read weekly stats:', err.message);
    return [];
  }
};

// Upsert this week (re-running on the same day overwrites) and keep the newest
// HISTORY_WEEKS prior weeks plus the current one
const saveWeekStats = (stats, filePath = STATS_PATH) => {
  const weeks = loadStats(filePath)
    .filter(w => w.weekEnding !== stats.weekEnding)
    .concat(stats)
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding))
    .slice(-(HISTORY_WEEKS + 1));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ weeks }, null, 2));
  fs.renameSync(tmp, filePath);
  return weeks;
};

// Prior weeks only (excludes the current week's key), oldest first
const getHistory = (currentWeekEnding, filePath = STATS_PATH) =>
  loadStats(filePath)
    .filter(w => w.weekEnding < currentWeekEnding)
    .slice(-HISTORY_WEEKS);

const formatWeekLine = (w, label = '') => {
  const cats = Object.entries(w.byCategory || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const done = w.tasksCompleted == null ? 'tasks completed not recorded' : `${w.tasksCompleted} tasks completed`;
  return `- ${w.weekEnding}${label}: ${w.captures} captures (${cats}); ${done}`;
};

// Context section comparing the current week with up to 5 prior weeks
const formatTrendSection = (current, history) => {
  let text = '\n## WEEKLY TREND (oldest first)\n';
  if (!history.length) {
    return text + 'No prior weeks recorded yet; do not claim any trend.\n' + formatWeekLine(current, ' (this week)') + '\n';
  }

  history.forEach(w => { text += formatWeekLine(w) + '\n'; });
  text += formatWeekLine(current, ' (this week)') + '\n';

  // Average only over weeks that have the value (seeded weeks may lack tasksCompleted)
  const avg = (key) => {
    const vals = history.map(w => w[key]).filter(v => v != null);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : 'n/a';
  };
  text += `- Prior ${history.length}-week average: ${avg('captures')} captures, ${avg('tasksCompleted')} tasks completed\n`;
  return text;
};

module.exports = {
  STATS_PATH,
  HISTORY_WEEKS,
  weekKey,
  computeWeekStats,
  loadStats,
  saveWeekStats,
  getHistory,
  formatTrendSection
};
