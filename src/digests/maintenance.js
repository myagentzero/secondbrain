const {
  queryOpenInboxLog,
  updateInboxLogEntry,
  updateProjectsEntry,
  updateAdminEntry,
  updatePeopleEntry,
  queryAllRecordsFromDatabase,
  queryAllInboxLogRecordIds,
  getSlackThreadTs
} = require('../notion/databases');
const { matchCompletedTasksToInbox } = require('../claude/categorize');
const { listCompletedTasks } = require('../tasks/tasks');
const { getApp } = require('../slack/client');
const { getSlackConfig, getNotionConfig } = require('../config');

const RATE_LIMIT_MS = 500;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const runDailyMaintenance = async () => {
  console.log('Running daily maintenance...');

  try {
    // Fetch completed tasks and open inbox items in parallel
    const [recentCompleted, openInbox] = await Promise.all([
      listCompletedTasks(2),
      queryOpenInboxLog()
    ]);

    console.log(`Found ${recentCompleted.length} recently completed tasks, ${openInbox.results.length} open inbox items`);

    if (recentCompleted.length === 0 || openInbox.results.length === 0) {
      console.log('Daily maintenance complete — no items to process');
      return { closed: 0 };
    }

    // Match completed tasks to open inbox items using Claude
    const { matches } = await matchCompletedTasksToInbox(recentCompleted, openInbox.results);
    console.log(`Found ${matches.length} matches to auto-close`);

    if (matches.length === 0) {
      console.log('Daily maintenance complete — nothing to close');
      return { closed: 0 };
    }

    // Build a lookup map from inbox results
    const inboxMap = new Map();
    for (const item of openInbox.results) {
      inboxMap.set(item.id, item);
    }

    const app = getApp();
    const config = getSlackConfig();
    const channel = config.secondbrainChannel || 'secondbrain';
    let closed = 0;

    for (const match of matches) {
      try {
        const entry = inboxMap.get(match.inboxItemId);
        if (!entry) {
          console.warn(`Inbox item ${match.inboxItemId} not found in results, skipping`);
          continue;
        }

        const notionRecordId = entry.properties?.['Notion Record ID']?.rich_text?.[0]?.plain_text;
        const filedTo = entry.properties?.['Filed-To']?.select?.name;
        const threadTs = getSlackThreadTs(entry);

        // Update inbox log status to Done
        await updateInboxLogEntry(entry.id, { status: 'Done' });

        // Update destination record
        if (notionRecordId) {
          if (filedTo === 'projects') {
            await updateProjectsEntry(notionRecordId, { status: 'Done' });
          } else if (filedTo === 'admin') {
            await updateAdminEntry(notionRecordId, { status: 'Done' });
          } else if (filedTo === 'people') {
            await updatePeopleEntry(notionRecordId, { status: 'Done' });
          }
        }

        // Post Slack thread reply (rows created outside Slack have no thread to reply to)
        if (!threadTs) {
          console.log(`No Slack thread for ${match.inboxDestinationName}; skipping Slack reply`);
        } else {
          const reply = await app.client.chat.postMessage({
            channel,
            text: `Auto-closed: matched completed task "${match.matchedTaskTitle}"`,
            thread_ts: threadTs
          });

          try {
            await app.client.reactions.add({ channel: reply.channel, timestamp: threadTs, name: 'checkered_flag' });
          } catch (error) {
            console.log('Could not add :checkered_flag: reaction:', error.message);
          }
        }

        closed++;
        console.log(`Auto-closed: ${match.inboxDestinationName} (matched "${match.matchedTaskTitle}")`);

        // Rate limit between updates
        if (matches.indexOf(match) < matches.length - 1) {
          await sleep(RATE_LIMIT_MS);
        }
      } catch (error) {
        console.error(`Failed to auto-close ${match.inboxDestinationName}:`, error.message);
      }
    }

    console.log(`Daily maintenance complete — auto-closed ${closed} items`);
    return { closed };

  } catch (error) {
    console.error('Error running daily maintenance:', error);
    throw error;
  }
};

const runWeeklyOrphanCleanup = async () => {
  console.log('Running weekly orphan cleanup...');

  try {
    const notion = require('../notion/client').getClient();
    const config = getNotionConfig();
    const { people, projects, admin } = config.databases;

    // Fetch all inbox log record IDs
    const inboxRecordIds = await queryAllInboxLogRecordIds();
    console.log(`Found ${inboxRecordIds.size} referenced records in Inbox Log`);

    // An empty set means the Inbox Log read failed or its schema changed; proceeding would trash every record
    if (inboxRecordIds.size === 0) {
      console.warn('No referenced records found in Inbox Log; skipping orphan cleanup');
      return { deleted: 0 };
    }

    let deleted = 0;

    // Process each of the three tables
    for (const [tableName, databaseId] of [
      ['People', people],
      ['Projects', projects],
      ['Admin', admin]
    ]) {
      console.log(`Checking ${tableName} table for orphans...`);

      const records = await queryAllRecordsFromDatabase(databaseId);
      console.log(`  Found ${records.length} total records in ${tableName}`);

      for (const record of records) {
        if (!inboxRecordIds.has(record.id)) {
          try {
            const title = record.properties?.['Name']?.title?.[0]?.plain_text || 'Unknown';
            await notion.pages.update({
              page_id: record.id,
              in_trash: true
            });
            deleted++;
            console.log(`  Trashed orphan: ${tableName}/${title}`);

            // Rate limit between deletions
            await sleep(RATE_LIMIT_MS);
          } catch (error) {
            console.error(`  Failed to archive ${tableName}/${record.id}:`, error.message);
          }
        }
      }
    }

    console.log(`Weekly orphan cleanup complete — trashed ${deleted} orphaned records`);
    return { deleted };

  } catch (error) {
    console.error('Error running weekly orphan cleanup:', error);
    throw error;
  }
};

// Allow running directly for testing
if (require.main === module) {
  const { startApp } = require('../slack/client');

  (async () => {
    await startApp();
    const command = process.argv[2];
    if (command === 'cleanup') {
      await runWeeklyOrphanCleanup();
    } else {
      await runDailyMaintenance();
    }
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runDailyMaintenance,
  runWeeklyOrphanCleanup
};
