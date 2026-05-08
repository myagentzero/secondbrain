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

// Parse one-word reply for status or destination
const parseCorrection = (message) => {
  const word = message.trim().toLowerCase();

  const destinations = {
    'people': ['people', 'person',"employee", "contact"],
    'projects': ['projects', 'project'],
    'ideas': ['ideas', 'idea'],
    'admin': ['admin', 'task', 'errand', "todo", "chore"]
  };

  const newDestination = Object.entries(destinations).find(([, kws]) =>
    kws.some(kw => word === kw)
  )?.[0] ?? null;

  const newStatus = Object.entries(statuses).find(([, kws]) =>
    kws.some(kw => word === kw)
  )?.[0] ?? null;

  return { newDestination, newStatus, word };
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

    const text = message.text || '';
    const lowerText = text.toLowerCase().trim();

    if (message.thread_ts && message.thread_ts !== message.ts) {
      const words = lowerText.split(/\s+/);
      if (words.length === 1) {
        await handleCorrection(message, say);
      }
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
          text: `I'm not sure how to classify this (confidence: ${result.confidence.toFixed(2)}). Please reply in the thread with one word: a status (Active, Waiting, Blocked, Done) or destination (People, Projects, Ideas, Admin).`,
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

// Handle one-word reply corrections
const handleCorrection = async (message, say) => {
  const text = message.text || '';
  const threadTs = message.thread_ts;

  const parsed = parseCorrection(text);
  if (!parsed.newDestination && !parsed.newStatus) {
    const availableOptions = [
      '*Statuses*: Active, Waiting, Blocked, Done',
      '*Destinations*: People, Projects, Ideas, Admin'
    ];
    await say({
      text: `I don't recognize "${text}". Available one-word replies:\n\n${availableOptions.join('\n')}`,
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

    // Handle destination change
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

    // Handle status update
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
