const {
  queryWeekInboxLog,
  queryAllOpenProjects
} = require('../notion/databases');
const { generateWeeklyDigest } = require('../claude/categorize');
const { getApp } = require('../slack/client');
const { getSlackConfig } = require('../config');
const { deleteOldCompletedTasks, listCompletedTasks } = require('../tasks/tasks');
const { spawn } = require('child_process');

// Store content in Zeroclaw memory
const memoryStore = (key, content, category) => {
  return new Promise((resolve, reject) => {
    const proc = spawn('zeroclaw', ['memory', 'store', key, content, '--category', category]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zeroclaw exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => reject(err));
  });
};

// Build context string from Notion data
const buildWeeklyContext = (inboxLog, projects) => {
  let context = '=== ITEMS CAPTURED THIS WEEK ===\n';

  inboxLog.results.forEach((item, i) => {
    const originalText = item.properties?.['Original Text']?.title?.[0]?.plain_text || 'No text';
    const filedTo = item.properties?.['Filed-To']?.select?.name || 'Unknown';
    const destName = item.properties?.['Destination Name']?.rich_text?.[0]?.plain_text || '';
    const status = item.properties?.Status?.select?.name || '';

    context += ` ${i + 1}. [${filedTo}] ${destName || originalText.substring(0, 50)}`;
    if (status === 'Needs Review') {
      context += `   WARNING: NEEDS REVIEW\n`;
    }
    context += '\n';
  });

  if (projects.results.length > 0) {
    context += '\n=== ACTIVE PROJECTS STATUS ===\n';
    projects.results.forEach((p, i) => {
      const name = p.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
      const status = p.properties?.Status?.select?.name || 'Unknown';
      const nextAction = p.properties?.['Next Action']?.rich_text?.[0]?.plain_text || 'None specified';

      context += ` ${i + 1}. ${name}\n`;
      context += `   Status: ${status}\n`;
      context += `   Next: ${nextAction}\n\n`;
    });
  }

  // Count by category
  const categoryCounts = {};
  inboxLog.results.forEach(item => {
    const cat = item.properties?.['Filed-To']?.select?.name || 'Unknown';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  context += '\n=== CAPTURE SUMMARY ===\n';
  for (const [cat, count] of Object.entries(categoryCounts)) {
    context += ` ${cat}: ${count}\n`;
  }

  return context;
};

const runWeeklyDigest = async () => {
  console.log('Running weekly digest...');

  try {
    // Query Notion databases and completed tasks
    const [inboxLog, projects, completedTasks] = await Promise.all([
      queryWeekInboxLog(),
      queryAllOpenProjects(),
      listCompletedTasks()
    ]);

    console.log(`Found ${inboxLog.results.length} inbox items, ${projects.results.length} projects, ${completedTasks.length} completed tasks`);

    // Build context
    const context = buildWeeklyContext(inboxLog, projects);
    const totalCaptures = inboxLog.results.length;

    // Generate digest with Claude
    const digest = await generateWeeklyDigest(context, totalCaptures, completedTasks);
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

    // Store digest in Zeroclaw memory
    try {
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '_');
      await memoryStore(`secondbrain_weekly_digest_${today}`, digest, 'daily');
      console.log('Stored digest in Zeroclaw memory');
    } catch (memError) {
      console.error('Failed to store in Zeroclaw memory:', memError.message);
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
