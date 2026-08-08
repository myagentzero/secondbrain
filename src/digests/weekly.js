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
const { spawn } = require('child_process');

const UPCOMING_MEETING_DAYS = 7;

// Store content in agentzero memory
const memoryStore = (key, content, category) => {
  return new Promise((resolve, reject) => {
    const proc = spawn('agentzero', ['memory', 'store', key, '--category', category, '--', content]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agentzero exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => reject(err));
  });
};

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

// Format Inbox Log items (used for both active and needs-review sections)
const formatInboxItems = (heading, items) => {
  if (!items.length) return `\n## ${heading}\nNone\n`;

  let text = `\n## ${heading}\n`;
  items.forEach((item, i) => {
    const originalText = item.properties?.['Original Text']?.title?.[0]?.plain_text || 'No text';
    const filedTo = item.properties?.['Filed-To']?.select?.name || 'Unknown';
    const destName = item.properties?.['Destination Name']?.rich_text?.[0]?.plain_text || '';

    text += `${i + 1}. [${filedTo}] ${destName || originalText.substring(0, 60)}\n`;
  });

  return text;
};

// Format upcoming Outlook/shared calendar meetings
const formatUpcomingEvents = (events) => {
  if (!events.length) return '\n## UPCOMING MEETINGS THIS WEEK\nNone\n';

  let text = '\n## UPCOMING MEETINGS THIS WEEK\n';
  events.forEach((event, i) => {
    const start = new Date(event.start.dateTime || event.start.date);
    const when = start.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Phoenix'
    });

    text += `${i + 1}. [${when}] ${event.summary}${event.location ? ' @ ' + event.location : ''}\n`;
  });

  return text;
};

// Format active Admin tasks (used in weekly context, right after ACTIVE PROJECTS STATUS)
const formatActiveAdminTasks = (adminTasks) => {
  if (!adminTasks.length) return '\n## ACTIVE ADMIN TASKS\nNone\n\n';

  let text = '\n## ACTIVE ADMIN TASKS\n';
  adminTasks.forEach((task, i) => {
    const name = task.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
    const notes = task.properties?.Notes?.rich_text?.[0]?.plain_text || 'None';
    const dueDate = task.properties?.['Due Date']?.date?.start || 'None';
    const created = task.properties?.Created?.date?.start || 'Unknown';

    text += `${i + 1}. ${name}\n`;
    text += `   Notes: ${notes}\n`;
    text += `   Due: ${dueDate}\n`;
    text += `   Created: ${created}\n\n`;
  });

  return text;
};

// Build context string from Notion data
const buildWeeklyContext = (inboxLog, projects, adminTasks, needsReviewItems, upcomingEvents) => {
  let context = '## ITEMS CAPTURED LAST WEEK\n';

  inboxLog.results.forEach((item, i) => {
    const originalText = item.properties?.['Original Text']?.title?.[0]?.plain_text || 'No text';
    const filedTo = item.properties?.['Filed-To']?.select?.name || 'Unknown';
    const destName = item.properties?.['Destination Name']?.rich_text?.[0]?.plain_text || '';

    context += `${i + 1}. [${filedTo}] ${destName || originalText.substring(0, 50)}\n`;
  });

  // Count by category
  const categoryCounts = {};
  inboxLog.results.forEach(item => {
    const cat = item.properties?.['Filed-To']?.select?.name || 'Unknown';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  context += '\n## CAPTURE SUMMARY\n';
  context += `- Total Captures: ${inboxLog.results.length}\n`;
  for (const [cat, count] of Object.entries(categoryCounts)) {
    context += `- ${cat}: ${count}\n`;
  }

  if (projects.results.length > 0) {
    context += '\n## ACTIVE PROJECTS STATUS\n';
    projects.results.forEach((p, i) => {
      const name = p.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
      const status = p.properties?.Status?.select?.name || 'Unknown';
      const nextAction = p.properties?.['Next Action']?.rich_text?.[0]?.plain_text || 'None specified';
      const created = p.created_time ? p.created_time.split('T')[0] : 'Unknown';
      const lastTouched = p.properties?.['Last Touched']?.date?.start || 'Unknown';

      context += `${i + 1}. ${name}\n`;
      context += `   Status: ${status}\n`;
      context += `   Next: ${nextAction}\n`;
      context += `   Created: ${created}\n`;
      context += `   Last Touched: ${lastTouched}\n\n`;
    });
  }

  context += formatActiveAdminTasks(adminTasks.results);

  context += formatInboxItems('NEEDS REVIEW', needsReviewItems.results);
  context += formatUpcomingEvents(upcomingEvents);

  return context;
};

const runWeeklyDigest = async () => {
  console.log('Running weekly digest...');

  try {
    // Query Notion databases, completed tasks, and upcoming meetings
    const [inboxLog, projects, adminTasks, completedTasks, needsReviewItems, upcomingEvents] = await Promise.all([
      queryWeekInboxLog(),
      queryAllOpenProjects(),
      queryAllOpenAdmin(),
      listCompletedTasks(),
      queryNeedsReviewInboxLog(),
      getUpcomingEvents(UPCOMING_MEETING_DAYS).catch(err => {
        console.error('Failed to fetch upcoming meetings:', err.message);
        return [];
      })
    ]);

    console.log(`Found ${inboxLog.results.length} inbox items, ${projects.results.length} projects, ${adminTasks.results.length} admin tasks, ${completedTasks.length} completed tasks, ${needsReviewItems.results.length} needing review, ${upcomingEvents.length} upcoming meetings`);

    // Build context
    const context = buildWeeklyContext(inboxLog, projects, adminTasks, needsReviewItems, upcomingEvents);

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

    // Store digest in agentzero memory
    try {
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '_');
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
  runWeeklyDigest
};
