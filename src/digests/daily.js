const {
  queryActiveProjects,
  queryPeopleWithFollowUps,
  queryOverdueAdmin,
  queryUpcomingAdmin,
  activateInboxLogEntries,
  updateProjectsEntry,
  updatePeopleEntry,
  updateAdminEntry
} = require('../notion/databases');
const { generateDailyDigestStructured, formatDigestForSlack } = require('../claude/categorize');
const { createDailyTasks, listTasks, listCompletedTasks } = require('../tasks/tasks');
const { getApp } = require('../slack/client');
const { getSlackConfig } = require('../config');
const { checkKeyExpiration } = require('../llm/client');
const { memoryStore } = require('./memory');
const { prop, section, fields } = require('./format');

// One admin task: name plus ID, status, due date and notes when present
const adminLines = (task, i) => [
  `${i + 1}. ${prop.title(task, 'Name') || 'Untitled'}`,
  ...fields([
    ['ID', task.id],
    ['Status', prop.select(task, 'Status')],
    ['Due', prop.date(task, 'Due Date') || 'No date'],
    ['Notes', prop.text(task, 'Notes')]
  ])
];

// Build context string from Notion data
const buildDailyContext = (projects, people, admin, upcomingAdmin, keyAlert = null) => {
  const alertLines = keyAlert
    ? [`1. ${keyAlert.name} [URGENT]`, ...fields([['Due', keyAlert.dueDate], ['Notes', keyAlert.notes]])]
    : [];
  // Regular tasks are numbered after the alert so numbering stays continuous
  const offset = keyAlert ? 1 : 0;

  // Only people with a follow-up are worth a line; the rest are noise
  const peopleWithFollowUps = people.results.filter(p => prop.title(p, 'Name') && prop.text(p, 'Follow-ups'));

  return [
    section('ACTIVE PROJECTS', projects.results.flatMap((p, i) => [
      `${i + 1}. ${prop.title(p, 'Name') || 'Untitled'}`,
      ...fields([
        ['ID', p.id],
        ['Status', prop.select(p, 'Status') || 'Unknown'],
        ['Next Action', prop.text(p, 'Next Action')]
      ])
    ])),
    section('PEOPLE TO FOLLOW UP WITH', peopleWithFollowUps.flatMap((p, i) => [
      `${i + 1}. ${prop.title(p, 'Name')}`,
      ...fields([
        ['ID', p.id],
        ['Status', prop.select(p, 'Status')],
        ['Follow-up', prop.text(p, 'Follow-ups')]
      ])
    ])),
    section('TASKS DUE', [
      ...alertLines,
      ...admin.results.flatMap((task, i) => adminLines(task, i + offset))
    ]),
    section('UPCOMING TASKS (Next Week)', upcomingAdmin.results.flatMap((task, i) => adminLines(task, i)))
  ].join('');
};

// Queries are capped to keep the prompt small; say so in the logs when rows are dropped
const warnIfTruncated = (label, response) => {
  if (response.has_more) console.warn(`Daily digest: ${label} truncated to ${response.results.length} rows`);
};

// Record ID -> the updater for its Notion table, for the records shown to the LLM
const buildRecordUpdaters = (projects, people, admin, upcomingAdmin) => {
  const updaters = new Map();
  const add = (response, updater) => response.results.forEach(page => updaters.set(page.id, updater));
  add(projects, updateProjectsEntry);
  add(people, updatePeopleEntry);
  add(admin, updateAdminEntry);
  add(upcomingAdmin, updateAdminEntry);
  return updaters;
};

// A record becomes Active once it has a Google Task. Ignores IDs the LLM made up.
const activateTaskedRecords = async (createdTasks, updaters) => {
  const ids = [...new Set(createdTasks.map(t => t.sourceId).filter(id => updaters.has(id)))];

  for (const id of ids) {
    try {
      await updaters.get(id)(id, { status: 'Active' });
      const rows = await activateInboxLogEntries(id);
      console.log(`Marked ${id} Active (${rows} Inbox Log row(s))`);
    } catch (error) {
      console.error(`Failed to mark ${id} Active:`, error.message);
    }
  }
};

const runDailyDigest = async () => {
  console.log('Running daily digest...');

  try {
    // Query Notion databases, existing Google Tasks, and key expiration
    const [projects, people, admin, upcomingAdmin, existingTasks, completedTasks, keyExpiration] = await Promise.all([
      queryActiveProjects(),
      queryPeopleWithFollowUps(),
      queryOverdueAdmin(),
      queryUpcomingAdmin(),
      listTasks(),
      listCompletedTasks(5),
      checkKeyExpiration()
    ]);

    [['projects', projects], ['people', people], ['overdue admin tasks', admin], ['upcoming admin tasks', upcomingAdmin]]
      .forEach(([label, response]) => warnIfTruncated(label, response));

    console.log(`Found ${projects.results.length} projects, ${people.results.length} people, ${admin.results.length} admin tasks, ${upcomingAdmin.results.length} upcoming tasks, ${existingTasks.length} existing tasks, ${completedTasks.length} completed tasks`);

    // Check if API key is expiring soon
    let keyExpirationAlert = null;
    if (keyExpiration) {
      const expiresDate = new Date(keyExpiration);
      const now = new Date();
      const daysUntilExpiry = Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24));
      if (daysUntilExpiry <= 5) {
        keyExpirationAlert = {
          name: 'Renew OpenAI LLM API key',
          dueDate: keyExpiration.split('T')[0],
          notes: `Key expires in ${daysUntilExpiry} day(s)`
        };
        console.log(`OpenAI LLM API key expires in ${daysUntilExpiry} day(s)`);
      }
    }

    // Build context
    const context = buildDailyContext(projects, people, admin, upcomingAdmin, keyExpirationAlert);

    // Generate structured digest with Claude (passing existing and completed tasks to avoid duplicates)
    const digest = await generateDailyDigestStructured(context, existingTasks, completedTasks);

    // Format digest for Slack
    const slackText = formatDigestForSlack(digest);

    // Post to Slack #daily-digest channel
    const app = getApp();
    const config = getSlackConfig();
    const dailyDigestChannel = config.dailyDigestChannel || 'daily-digest';

    await app.client.chat.postMessage({
      channel: dailyDigestChannel,
      text: slackText,
      username: 'Daily Digest',
      icon_emoji: ':date:'
    });
    console.log('Posted to Slack');

    // Store digest in agentzero memory
    try {
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '_');
      await memoryStore(`secondbrain_daily_digest_${today}`, slackText, 'daily');
      console.log('Stored digest in agentzero memory');
    } catch (memError) {
      console.error('Failed to store in agentzero memory:', memError.message);
    }

    // Create Google Tasks for Top 3 Actions
    try {
      if (digest.newTasks && digest.newTasks.length > 0) {
        const created = await createDailyTasks(digest.newTasks);
        await activateTaskedRecords(created, buildRecordUpdaters(projects, people, admin, upcomingAdmin));
      } else {
        console.log('No actions to create tasks for');
      }
    } catch (taskError) {
      console.error('Failed to create tasks:', taskError.message);
    }

    console.log('Daily digest complete');
    return digest;

  } catch (error) {
    console.error('Error running daily digest:', error);
    throw error;
  }
};

// Allow running directly for testing
if (require.main === module) {
  const { startApp } = require('../slack/client');

  (async () => {
    await startApp();
    await runDailyDigest();
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runDailyDigest,
  buildDailyContext
};
