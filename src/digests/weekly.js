const {
  queryWeekInboxLog,
  queryAllOpenProjects,
  queryAllOpenAdmin,
  queryNeedsReviewInboxLog
} = require('../notion/databases');
const { generateWeeklyDigest } = require('../claude/categorize');
const { getApp } = require('../slack/client');
const { getSlackConfig } = require('../config');
const { deleteOldCompletedTasks, listCompletedTasks } = require('../tasks/tasks');
const { getUpcomingEvents } = require('../calendar/sync');
const { memoryStore } = require('./memory');
const { prop, section, fields } = require('./format');
const { computeWeekStats, getHistory, saveWeekStats, formatTrendSection, weekKey } = require('./weeklyStats');

const UPCOMING_MEETING_DAYS = 7;

// Convert the model's standard markdown output into Slack mrkdwn, since Slack
// doesn't render # headers or **bold**
const sanitizeForSlack = (text) => {
  return text
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .split('\n')
    .filter(line => !/^-{3,}$/.test(line.trim()))
    .join('\n')
    .trim();
};

// One Inbox Log entry: "[filed-to] destination name (or start of the original text)"
const inboxLine = (item, i) => {
  const originalText = prop.title(item, 'Original Text') || 'No text';
  const destName = prop.text(item, 'Destination Name') || originalText.substring(0, 60);
  return `${i + 1}. [${prop.select(item, 'Filed-To') || 'Unknown'}] ${destName}`;
};

// Format upcoming Outlook/shared calendar meetings
const formatUpcomingEvents = (events) =>
  section('UPCOMING MEETINGS THIS WEEK', events.map((event, i) => {
    const start = new Date(event.start.dateTime || event.start.date);
    const when = start.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Phoenix'
    });

    return `${i + 1}. [${when}] ${event.summary}${event.location ? ' @ ' + event.location : ''}`;
  }));

const formatActiveProjects = (projects) =>
  section('ACTIVE PROJECTS STATUS', projects.flatMap((p, i) => [
    `${i + 1}. ${prop.title(p, 'Name') || 'Untitled'}`,
    ...fields([
      ['Status', prop.select(p, 'Status') || 'Unknown'],
      ['Next', prop.text(p, 'Next Action')],
      ['Last Touched', prop.date(p, 'Last Touched') || 'Unknown']
    ])
  ]));

const formatActiveAdminTasks = (adminTasks) =>
  section('ACTIVE ADMIN TASKS', adminTasks.flatMap((task, i) => [
    `${i + 1}. ${prop.title(task, 'Name') || 'Untitled'}`,
    ...fields([
      ['Notes', prop.text(task, 'Notes')],
      ['Due', prop.date(task, 'Due Date')],
      ['Created', prop.date(task, 'Created') || 'Unknown'],
      ['Last Touched', prop.date(task, 'Last Touched')]
    ])
  ]));

// Build the weekly context. Each fact appears once: per-category counts live in the
// trend section, and Needs Review items are listed only under NEEDS REVIEW.
const buildWeeklyContext = (inboxLog, projects, adminTasks, needsReviewItems, upcomingEvents, trendSection = '') => {
  const needsReviewIds = new Set(needsReviewItems.results.map(item => item.id));
  const captured = inboxLog.results.filter(item => !needsReviewIds.has(item.id));

  return [
    section('ITEMS CAPTURED LAST WEEK', captured.map(inboxLine)),
    trendSection,
    formatActiveProjects(projects.results),
    formatActiveAdminTasks(adminTasks.results),
    section('NEEDS REVIEW', needsReviewItems.results.map(inboxLine)),
    formatUpcomingEvents(upcomingEvents)
  ].join('');
};

const runWeeklyDigest = async () => {
  console.log('Running weekly digest...');

  try {
    // Query Notion databases, completed tasks, and upcoming meetings
    const [inboxLog, projects, adminTasks, completedTasks, needsReviewItems, upcomingEvents] = await Promise.all([
      queryWeekInboxLog(),
      queryAllOpenProjects(),
      queryAllOpenAdmin(),
      listCompletedTasks(7),
      queryNeedsReviewInboxLog(),
      getUpcomingEvents(UPCOMING_MEETING_DAYS).catch(err => {
        console.error('Failed to fetch upcoming meetings:', err.message);
        return [];
      })
    ]);

    console.log(`Found ${inboxLog.results.length} inbox items, ${projects.results.length} projects, ${adminTasks.results.length} admin tasks, ${completedTasks.length} completed tasks, ${needsReviewItems.results.length} needing review, ${upcomingEvents.length} upcoming meetings`);

    // Compare this week against the stored prior weeks
    const weekStats = computeWeekStats(inboxLog.results, completedTasks);
    const trendSection = formatTrendSection(weekStats, getHistory(weekStats.weekEnding));

    // Build context
    const context = buildWeeklyContext(inboxLog, projects, adminTasks, needsReviewItems, upcomingEvents, trendSection);

    // Generate digest with Claude
    const rawDigest = await generateWeeklyDigest(context, completedTasks);
    const digest = sanitizeForSlack(rawDigest);
    console.log('Weekly digest generated');

    // Post to Slack #weekly-digest channel
    const app = getApp();
    const config = getSlackConfig();
    const weeklyDigestChannel = config.weeklyDigestChannel || 'weekly-digest';

    await app.client.chat.postMessage({
      channel: weeklyDigestChannel,
      text: digest,
      username: 'Weekly Digest',
      icon_emoji: ':date:'
    });
    console.log('Posted to Slack');

    // Persist only after a successful post so a failed run doesn't record a week
    try {
      saveWeekStats(weekStats);
      console.log('Saved weekly stats');
    } catch (statsError) {
      console.error('Failed to save weekly stats:', statsError.message);
    }

    // Store digest in agentzero memory
    try {
      // Phoenix date: at 8pm Sunday the UTC date is already Monday
      const today = weekKey().replace(/-/g, '_');
      await memoryStore(`secondbrain_weekly_digest_${today}`, digest, 'daily');
      console.log('Stored digest in agentzero memory');
    } catch (memError) {
      console.error('Failed to store in agentzero memory:', memError.message);
    }

    // Clean up completed Google Tasks older than 7 days
    const deletedCount = await deleteOldCompletedTasks(7);
    console.log(`Cleaned up ${deletedCount} completed tasks`);

    console.log('Weekly digest complete');
    return digest;

  } catch (error) {
    console.error('Error running weekly digest:', error);
    throw error;
  }
};

// Allow running directly for testing
if (require.main === module) {
  const { startApp } = require('../slack/client');

  (async () => {
    await startApp();
    await runWeeklyDigest();
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runWeeklyDigest,
  buildWeeklyContext
};
