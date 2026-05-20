const { getDatabaseIds, queryDatabase, createPage, updatePage } = require('./client');

const getMSTDate = () => {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Phoenix' }).replace(' ', 'T');
};

const moveWeekendToMonday = (date) => {
  const adjusted = new Date(date);
  const day = adjusted.getDay();

  if (day === 6) {
    adjusted.setDate(adjusted.getDate() + 2);
  } else if (day === 0) {
    adjusted.setDate(adjusted.getDate() + 1);
  }

  return adjusted;
};

const formatDateForNotion = (value) => {
  if (!value) return null;

  // Guard: treat past dates as null so callers fall back to their default
  const isPast = (date) => {
    const today = new Date(getMSTDate().split('T')[0] + 'T00:00:00');
    return date < today;
  };

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const adjusted = moveWeekendToMonday(value);
    return isPast(adjusted) ? null : adjusted;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;

    // Already in YYYY-MM-DD format.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const parsedDateOnly = new Date(`${trimmed}T00:00:00`);
      if (!Number.isNaN(parsedDateOnly.getTime())) {
        const adjusted = moveWeekendToMonday(parsedDateOnly);
        return isPast(adjusted) ? null : adjusted;
      }
      return null;
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      const adjusted = moveWeekendToMonday(parsed);
      return isPast(adjusted) ? null : adjusted;
    }
  }

  return null;
};

const getDefaultAdminDueDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 7);

  return moveWeekendToMonday(d);
};

// Create entry in Inbox Log
const createInboxLogEntry = async ({
  originalText,
  destination,
  destinationName,
  destinationUrl,
  notionRecordId,
  confidence,
  status,
  slackThreadTs,
  filedTo
}) => {
  const { inboxLog } = getDatabaseIds();

  const properties = {
    'Original Text': { title: [{ text: { content: originalText } }] },
    'Filed-To': { select: { name: filedTo || destination } },
    'Destination Name': { rich_text: [{ text: { content: destinationName || '' } }] },
    'Created': { date: { start: getMSTDate() } },
    'Slack Thread TS': { rich_text: [{ text: { content: slackThreadTs || '' } }] }
  };

  if (destinationUrl) {
    properties['Destination URL'] = { url: destinationUrl };
  }
  if (notionRecordId) {
    properties['Notion Record ID'] = { rich_text: [{ text: { content: notionRecordId } }] };
  }
  if (confidence !== undefined) {
    properties['Confidence'] = { number: confidence };
  }
  if (status) {
    properties['Status'] = { select: { name: status } };
  }

  return createPage({
    parent: { database_id: inboxLog },
    properties
  });
};

// Create People entry
const createPeopleEntry = async ({ name, status, context, followUps, tags }) => {
  const { people } = getDatabaseIds();

  const properties = {
    'Name': { title: [{ text: { content: name } }] },
    'Status': { select: { name: status || 'Active' } },
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (context) {
    properties['Context'] = { rich_text: [{ text: { content: context } }] };
  }
  if (followUps) {
    properties['Follow-ups'] = { rich_text: [{ text: { content: followUps } }] };
  }
  if (tags && tags.length > 0) {
    properties['Tags'] = { multi_select: tags.map(t => ({ name: t })) };
  }

  return createPage({
    parent: { database_id: people },
    properties
  });
};

// Create Projects entry
const createProjectsEntry = async ({ name, status, nextAction, notes, tags }) => {
  const { projects } = getDatabaseIds();

  const properties = {
    'Name': { title: [{ text: { content: name } }] },
    'Status': { select: { name: status || 'Active' } },
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (nextAction) {
    properties['Next Action'] = { rich_text: [{ text: { content: nextAction } }] };
  }
  if (notes) {
    properties['Notes'] = { rich_text: [{ text: { content: notes } }] };
  }
  if (tags && tags.length > 0) {
    properties['Tags'] = { multi_select: tags.map(t => ({ name: t })) };
  }

  return createPage({
    parent: { database_id: projects },
    properties
  });
};

// Create Ideas entry
const createIdeasEntry = async ({ name, oneLiner, notes, tags }) => {
  const { ideas } = getDatabaseIds();

  const properties = {
    'Name': { title: [{ text: { content: name } }] },
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (oneLiner) {
    properties['One-Liner'] = { rich_text: [{ text: { content: oneLiner } }] };
  }
  if (notes) {
    properties['Notes'] = { rich_text: [{ text: { content: notes } }] };
  }
  if (tags && tags.length > 0) {
    properties['Tags'] = { multi_select: tags.map(t => ({ name: t })) };
  }

  return createPage({
    parent: { database_id: ideas },
    properties
  });
};

// Create Admin entry
const createAdminEntry = async ({ name, notes, status, dueDate }) => {
  const { admin } = getDatabaseIds();

  const properties = {
    'Name': { title: [{ text: { content: name } }] },
    'Status': { select: { name: status || 'Active' } },
    'Created': { date: { start: getMSTDate() } }
  };

  if (notes) {
    properties['Notes'] = { rich_text: [{ text: { content: notes } }] };
  }
  const effectiveDueDate = formatDateForNotion(dueDate) || getDefaultAdminDueDate();
  properties['Due Date'] = { date: { start: effectiveDueDate.toISOString().split('T')[0] } };

  return createPage({
    parent: { database_id: admin },
    properties
  });
};

// Find Inbox Log entry by Slack thread timestamp
const findInboxLogByThreadTs = async (threadTs) => {
  const { inboxLog } = getDatabaseIds();

  const response = await queryDatabase({
    database_id: inboxLog,
    filter: {
      property: 'Slack Thread TS',
      rich_text: { equals: threadTs }
    },
    page_size: 1
  });

  return response.results[0] || null;
};

// Update Inbox Log entry
const updateInboxLogEntry = async (pageId, updates) => {
  const properties = {};

  if (updates.status) {
    properties['Status'] = { select: { name: updates.status } };
  }
  if (updates.filedTo) {
    properties['Filed-To'] = { select: { name: updates.filedTo } };
  }
  if (updates.destinationName) {
    properties['Destination Name'] = { rich_text: [{ text: { content: updates.destinationName } }] };
  }
  if (updates.destinationUrl) {
    properties['Destination URL'] = { url: updates.destinationUrl };
  }
  if (updates.notionRecordId) {
    properties['Notion Record ID'] = { rich_text: [{ text: { content: updates.notionRecordId } }] };
  }

  return updatePage({
    page_id: pageId,
    properties
  });
};

// Archive a page (used for re-categorization)
const archivePage = async (pageId) => {
  return updatePage({
    page_id: pageId,
    in_trash: true
  });
};

// Update Projects status
const updateProjectsEntry = async (pageId, { status }) => {
  const properties = {
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (status) {
    properties['Status'] = { select: { name: status } };
  }

  return updatePage({
    page_id: pageId,
    properties
  });
};

// Update Admin status
const updateAdminEntry = async (pageId, { status }) => {
  const properties = {
    'Created': { date: { start: getMSTDate() } }
  };

  if (status) {
    properties['Status'] = { select: { name: status } };
  }

  return updatePage({
    page_id: pageId,
    properties
  });
};

// Update People status
const updatePeopleEntry = async (pageId, { status }) => {
  const properties = {
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (status) {
    properties['Status'] = { select: { name: status } };
  }

  return updatePage({
    page_id: pageId,
    properties
  });
};

// Query active projects (for daily digest)
const queryActiveProjects = async () => {
  const { projects } = getDatabaseIds();

  return queryDatabase({
    database_id: projects,
    filter: {
      or: [
        { property: 'Status', select: { equals: 'Active' } },
        { property: 'Status', select: { equals: 'Waiting' } }
      ]
    },
    page_size: 20
  });
};

// Query people with follow-ups (for daily digest)
const queryPeopleWithFollowUps = async () => {
  const { people } = getDatabaseIds();

  return queryDatabase({
    database_id: people,
    filter: {
      or: [
        { property: 'Status', select: { equals: 'Active' } },
        { property: 'Status', select: { equals: 'Waiting' } }
      ]
    },
    page_size: 10
  });
};

// Query overdue admin tasks (for daily digest)
const queryOverdueAdmin = async () => {
  const { admin } = getDatabaseIds();

  return queryDatabase({
    database_id: admin,
    filter: {
      and: [
        {
          or: [
            { property: 'Due Date', date: { before: getMSTDate() } },
            { property: 'Due Date', date: { is_empty: true } }
          ]
        },
        { property: 'Status', select: { equals: 'Active' } }
      ]
    },
    page_size: 10
  });
};

// Query upcoming admin tasks (next week) for daily digest
const queryUpcomingAdmin = async () => {
  const { admin } = getDatabaseIds();

  return queryDatabase({
    database_id: admin,
    filter: {
      and: [
        { property: 'Due Date', date: { after: getMSTDate() } },
        { property: 'Status', select: { equals: 'Active' } }
      ]
    },
    page_size: 10,
    sorts: [{ property: 'Due Date', direction: 'ascending' }]
  });
};

// Query this week's inbox log (for weekly digest)
const queryWeekInboxLog = async () => {
  const { inboxLog } = getDatabaseIds();

  return queryDatabase({
    database_id: inboxLog,
    filter: {
      property: 'Created',
      date: { past_week: {} }
    },
    page_size: 50
  });
};

// Query all active/waiting/blocked projects (for weekly digest)
const queryAllOpenProjects = async () => {
  const { projects } = getDatabaseIds();

  return queryDatabase({
    database_id: projects,
    filter: {
      or: [
        { property: 'Status', select: { equals: 'Active' } },
        { property: 'Status', select: { equals: 'Waiting' } },
        { property: 'Status', select: { equals: 'Blocked' } }
      ]
    },
    page_size: 30
  });
};

// Query open inbox log entries (Active, Waiting, or Blocked)
const queryOpenInboxLog = async () => {
  const { inboxLog } = getDatabaseIds();

  return queryDatabase({
    database_id: inboxLog,
    filter: {
      or: [
        { property: 'Status', select: { equals: 'Active' } },
        { property: 'Status', select: { equals: 'Waiting' } },
        { property: 'Status', select: { equals: 'Blocked' } }
      ]
    },
    page_size: 100
  });
};

// Query all records from a database (with pagination)
const queryAllRecordsFromDatabase = async (databaseId, pageSize = 100) => {
  const allResults = [];
  let cursor = undefined;

  while (true) {
    const response = await queryDatabase({
      database_id: databaseId,
      page_size: pageSize,
      start_cursor: cursor
    });

    allResults.push(...response.results);

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  return allResults;
};

// Query all inbox log record IDs for orphan detection
const queryAllInboxLogRecordIds = async () => {
  const { inboxLog } = getDatabaseIds();
  const records = await queryAllRecordsFromDatabase(inboxLog);

  const recordIds = new Set();
  for (const record of records) {
    const notionRecordId = record.properties?.['Notion Record ID']?.rich_text?.[0]?.plain_text;
    if (notionRecordId) {
      recordIds.add(notionRecordId);
    }
  }

  return recordIds;
};

module.exports = {
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
  updatePeopleEntry,
  queryActiveProjects,
  queryPeopleWithFollowUps,
  queryOverdueAdmin,
  queryUpcomingAdmin,
  queryWeekInboxLog,
  queryAllOpenProjects,
  queryOpenInboxLog,
  queryAllRecordsFromDatabase,
  queryAllInboxLogRecordIds
};

