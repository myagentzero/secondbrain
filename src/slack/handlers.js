const { getApp } = require('./client');
const { categorizeMessage, reclassifyMessage } = require('../claude/categorize');
const {
  createInboxLogEntry,
  createPeopleEntry,
  createProjectsEntry,
  createIdeasEntry,
  createAdminEntry,
  findInboxLogByThreadTs,
  updateInboxLogEntry,
  archivePage,
  updateProjectsEntry,
  updateAdminEntry,
  updatePeopleEntry
} = require('../notion/databases');

const CONFIDENCE_THRESHOLD = 0.6;

// Status keywords mapping (module-level for reuse)
const statuses = {
  'Active': ['active', 'started', 'progress', 'todo', 'unknown'],
  'Waiting': ['waiting', 'someday', 'pending', 'hold'],
  'Blocked': ['blocked', 'block', 'stuck', 'issue'],
  'Done': ['done', 'finish', 'finished', 'complete', 'completed', 'closed'],
};

const allStatusKeywords = new Set(Object.values(statuses).flat());

// Parse fix/update commands
const parseCorrection = (message) => {
  const fixMatch = message.match(/(fix|update):\s*(.+)/i);
  if (!fixMatch) return null;

  const correction = fixMatch[2].trim().toLowerCase();

  const destinations = {
    'people': ['people', 'person'],
    'projects': ['projects', 'project'],
    'ideas': ['ideas', 'idea'],
    'admin': ['admin', 'task', 'errand']
  };

  const newDestination = Object.entries(destinations).find(([, kws]) =>
    kws.some(kw => correction.includes(kw))
  )?.[0] ?? null;

  const newStatus = Object.entries(statuses).find(([, kws]) =>
    kws.some(kw => correction.includes(kw))
  )?.[0] ?? null;

  return { newDestination, newStatus, correction };
};

// Create entry in appropriate destination database
const createDestinationEntry = async (destination, data) => {
  switch (destination) {
    case 'people':
      return createPeopleEntry({
        name: data.name,
        status: data.status,
        context: data.context,
        followUps: data.followUps,
        tags: data.tags
      });
    case 'projects':
      return createProjectsEntry({
        name: data.name,
        status: data.status,
        nextAction: data.nextAction,
        notes: data.notes,
        tags: data.tags
      });
    case 'ideas':
      return createIdeasEntry({
        name: data.name,
        oneLiner: data.oneLiner,
        notes: data.notes,
        tags: data.tags
      });
    case 'admin':
      return createAdminEntry({
        name: data.name,
        notes: data.notes,
        status: data.status,
        dueDate: data.dueDate
      });
    default:
      return null;
  }
};

const setupHandlers = () => {
  const app = getApp();

  // Handle new messages in #secondbrain channel
  app.message(async ({ message, say }) => {
    // Skip bot messages
    if (message.bot_id) return;

    // Skip thread replies that are fix/update commands (handled separately)
    const text = message.text || '';
    const lowerText = text.toLowerCase();
    if (lowerText.startsWith('fix:') || lowerText.startsWith('update:')) {
      // Handle fix/update command
      await handleCorrection(message, say);
      return;
    }

    // Handle status keyword shortcuts (e.g., "done", "active", "waiting")
    const normalizedText = lowerText.trim();
    if (allStatusKeywords.has(normalizedText)) {
      await handleCorrection({ ...message, text: `update: ${normalizedText}` }, say);
      return;
    }

    // Skip thread replies that are not top-level messages
    if (message.thread_ts && message.thread_ts !== message.ts) {
      return;
    }

    console.log(`Processing message: ${text.substring(0, 50)}...`);

    try {
      // Categorize with Claude
      const result = await categorizeMessage(text);
      console.log(`Categorized as ${result.destination} with confidence ${result.confidence}`);

      // Handle low confidence
      if (result.confidence < CONFIDENCE_THRESHOLD || result.destination === 'needs_review') {
        // Create inbox log entry for needs review
        await createInboxLogEntry({
          originalText: text,
          destination: 'needs_review',
          destinationName: result.destination,
          confidence: result.confidence,
          status: 'Needs Review',
          slackThreadTs: message.ts,
          filedTo: 'Needs Review'
        });

        await say({
          text: `I'm not sure how to classify this (confidence: ${result.confidence.toFixed(2)})\n\nCould you repost with a prefix?\n- "person: ..." for people\n- "project: ..." for projects\n- "idea: ..." for ideas\n- "admin: ..." for tasks/errands\n\nOr reply "fix: [category]" to classify this one`,
          thread_ts: message.ts
        });
        return;
      }

      // Create entry in destination database
      const destEntry = await createDestinationEntry(result.destination, result);

      // Create inbox log entry
      await createInboxLogEntry({
        originalText: text,
        destination: result.destination,
        destinationName: result.name,
        destinationUrl: destEntry ? destEntry.url : null,
        notionRecordId: destEntry ? destEntry.id : null,
        confidence: result.confidence,
        status: result.status,
        slackThreadTs: message.ts,
        filedTo: result.destination
      });

      // Reply with confirmation
      let replyText = `Filed as ${result.destination}\n\n**${result.name}**\nConfidence: ${result.confidence.toFixed(2)}`;
      if (result.status) {
        replyText += `\nStatus: ${result.status}`;
      }

      await say({
        text: replyText,
        thread_ts: message.ts
      });

    } catch (error) {
      console.error('Error processing message:', error);
      await say({
        text: `Sorry, I encountered an error processing this message: ${error.message}`,
        thread_ts: message.ts
      });
    }
  });
};

// Handle fix/update corrections
const handleCorrection = async (message, say) => {
  const text = message.text || '';
  const threadTs = message.thread_ts;

  if (!threadTs) {
    await say({
      text: 'Fix/update commands must be replies to the original message thread.',
      thread_ts: message.ts
    });
    return;
  }

  const parsed = parseCorrection(text);
  if (!parsed) {
    await say({
      text: 'Could not parse the correction. Use "fix: [category]" or "update: [status]"',
      thread_ts: threadTs
    });
    return;
  }

  try {
    // Find the inbox log entry by thread timestamp
    const inboxLogEntry = await findInboxLogByThreadTs(threadTs);
    if (!inboxLogEntry) {
      await say({
        text: 'Could not find the original entry in Inbox Log.',
        thread_ts: threadTs
      });
      return;
    }

    const originalText = inboxLogEntry.properties?.['Original Text']?.title?.[0]?.plain_text || '';
    const currentFiledTo = inboxLogEntry.properties?.['Filed-To']?.select?.name || '';
    const notionRecordId = inboxLogEntry.properties?.['Notion Record ID']?.rich_text?.[0]?.plain_text || '';

    // Handle destination change (fix: command)
    if (parsed.newDestination) {
      console.log(`Re-categorizing to ${parsed.newDestination}`);

      // Archive old destination entry if it exists
      if (notionRecordId) {
        try {
          await archivePage(notionRecordId);
        } catch (e) {
          console.log('Could not archive old entry:', e.message);
        }
      }

      // Get new classification from Claude
      const reclassified = await reclassifyMessage(originalText, parsed.newDestination, 'Active');

      // Create new entry in destination database
      const destEntry = await createDestinationEntry(parsed.newDestination, reclassified);

      // Update inbox log
      await updateInboxLogEntry(inboxLogEntry.id, {
        filedTo: parsed.newDestination,
        destinationName: reclassified.name,
        destinationUrl: destEntry ? destEntry.url : null,
        notionRecordId: destEntry ? destEntry.id : null
      });

      await say({
        text: `Destination updated to ${parsed.newDestination}`,
        thread_ts: threadTs
      });
      return;
    }

    // Handle status update (update: command)
    if (parsed.newStatus) {
      console.log(`Updating status to ${parsed.newStatus}`);

      // Update inbox log status
      await updateInboxLogEntry(inboxLogEntry.id, {
        status: parsed.newStatus
      });

      // Update destination record if it exists
      const statusUpdaters = {
        projects: updateProjectsEntry,
        admin: updateAdminEntry,
        people: updatePeopleEntry,
      };
      if (notionRecordId && statusUpdaters[currentFiledTo]) {
        await statusUpdaters[currentFiledTo](notionRecordId, { status: parsed.newStatus });
      }

      await say({
        text: `Status updated to ${parsed.newStatus}`,
        thread_ts: threadTs
      });
      return;
    }

    await say({
      text: 'Could not determine what to update. Use "fix: [category]" or "update: [status]"',
      thread_ts: threadTs
    });

  } catch (error) {
    console.error('Error handling correction:', error);
    await say({
      text: `Error processing correction: ${error.message}`,
      thread_ts: threadTs
    });
  }
};

module.exports = {
  setupHandlers
};
