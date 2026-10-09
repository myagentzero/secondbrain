const { getDatabaseIds, queryDatabase, createPage, updatePage } = require('./client');

// Stamped on every Inbox Log row this app creates (the "Created by" column)
const APP_NAME = require('../../package.json').name;

const getMSTDate = () => {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Phoenix' }).replace(' ', 'T');
};

// Notion rejects rich text / title content over 2000 characters
const NOTION_TEXT_LIMIT = 2000;
const rt = (text) => {
  const value = String(text ?? '');
  const content = value.length > NOTION_TEXT_LIMIT ? `${value.slice(0, NOTION_TEXT_LIMIT - 1)}…` : value;
  return [{ text: { content } }];
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

// YYYY-MM-DD from local date parts (toISOString would shift the day after 5pm Phoenix)
const toDateString = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// One week out from today's Phoenix date, at local midnight
const getDefaultAdminDueDate = () => {
  const d = new Date(`${getMSTDate().split('T')[0]}T00:00:00`);
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
    'Original Text': { title: rt(originalText) },
    'Filed-To': { select: { name: filedTo || destination } },
    'Destination Name': { rich_text: rt(destinationName || '') },
    'Created': { date: { start: getMSTDate() } },
    'Created by': { select: { name: APP_NAME } },
    'Slack Thread TS': { rich_text: rt(slackThreadTs || '') }
  };

  if (destinationUrl) {
    properties['Destination URL'] = { url: destinationUrl };
  }
  if (notionRecordId) {
    properties['Notion Record ID'] = { rich_text: rt(notionRecordId) };
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
    'Name': { title: rt(name) },
    'Status': { select: { name: status || 'Backlog' } },
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (context) {
    properties['Context'] = { rich_text: rt(context) };
  }
  if (followUps) {
    properties['Follow-ups'] = { rich_text: rt(followUps) };
  }
  if (tags && tags.length > 0) {
    properties['Tags'] = { multi_select: tags.map(t => ({ name: t })) };
  }

  return createPage({
    parent: { database_id: people },
    properties
  });
};

// Text of a rich_text/title property, joined across segments
const plainText = (parts) => (parts || []).map(part => part.plain_text).join('');

// Combine existing and new text, newest first (Notion caps field length, so the oldest is what gets cut).
// Skips the addition when it is already there.
const mergeText = (existing, addition) => {
  if (!addition) return existing || '';
  if (!existing) return addition;
  return existing.includes(addition) ? existing : `${addition}\n${existing}`;
};

// Find an existing People record by name (case-insensitive, ignoring surrounding spaces)
const findPeopleByName = async (name) => {
  const { people } = getDatabaseIds();
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;

  const response = await queryDatabase({
    database_id: people,
    filter: { property: 'Name', title: { contains: String(name).trim() } },
    page_size: 20
  });

  return response.results.find(page => plainText(page.properties?.Name?.title).trim().toLowerCase() === wanted) || null;
};

// Fold a new capture into an existing People record. A Done person comes back as Backlog with
// context and follow-ups replaced; any other status is left alone and text is merged. Returns { page, reopened }.
const updatePersonFromCapture = async (existing, { context, followUps, tags }) => {
  const props = existing.properties || {};
  const reopened = props.Status?.select?.name === 'Done';

  const properties = {
    'Last Touched': { date: { start: getMSTDate() } }
  };
  if (reopened) {
    properties['Status'] = { select: { name: 'Backlog' } };
  }
  // A reopened (Done) person starts fresh: their old context and follow-ups are stale, so replace
  // them outright, even clearing them when the new capture has none. Otherwise new text goes first.
  if (reopened) {
    properties['Context'] = { rich_text: rt(context || '') };
    properties['Follow-ups'] = { rich_text: rt(followUps || '') };
  } else {
    if (context) {
      properties['Context'] = { rich_text: rt(mergeText(plainText(props.Context?.rich_text), context)) };
    }
    if (followUps) {
      properties['Follow-ups'] = { rich_text: rt(mergeText(plainText(props['Follow-ups']?.rich_text), followUps)) };
    }
  }
  if (tags && tags.length > 0) {
    const names = new Set([...(props.Tags?.multi_select || []).map(t => t.name), ...tags]);
    properties['Tags'] = { multi_select: [...names].map(name => ({ name })) };
  }

  const page = await updatePage({ page_id: existing.id, properties });
  return { page, reopened };
};

// Create Projects entry
const createProjectsEntry = async ({ name, status, nextAction, notes, tags }) => {
  const { projects } = getDatabaseIds();

  const properties = {
    'Name': { title: rt(name) },
    'Status': { select: { name: status || 'Backlog' } },
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (nextAction) {
    properties['Next Action'] = { rich_text: rt(nextAction) };
  }
  if (notes) {
    properties['Notes'] = { rich_text: rt(notes) };
  }
  if (tags && tags.length > 0) {
    properties['Tags'] = { multi_select: tags.map(t => ({ name: t })) };
  }

  return createPage({
    parent: { database_id: projects },
    properties
  });
};

// Create Admin entry
const createAdminEntry = async ({ name, notes, status, dueDate }) => {
  const { admin } = getDatabaseIds();

  const properties = {
    'Name': { title: rt(name) },
    'Status': { select: { name: status || 'Backlog' } },
    'Created': { date: { start: getMSTDate() } },
    'Last Touched': { date: { start: getMSTDate() } }
  };

  if (notes) {
    properties['Notes'] = { rich_text: rt(notes) };
  }
  const effectiveDueDate = formatDateForNotion(dueDate) || getDefaultAdminDueDate();
  properties['Due Date'] = { date: { start: toDateString(effectiveDueDate) } };

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

// Find Inbox Log entry by the Notion record it was filed to
const findInboxLogByRecordId = async (recordId) => {
  const { inboxLog } = getDatabaseIds();

  const response = await queryDatabase({
    database_id: inboxLog,
    filter: {
      property: 'Notion Record ID',
      rich_text: { equals: recordId }
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
    properties['Destination Name'] = { rich_text: rt(updates.destinationName) };
  }
  if (updates.destinationUrl) {
    properties['Destination URL'] = { url: updates.destinationUrl };
  }
  if (updates.notionRecordId) {
    properties['Notion Record ID'] = { rich_text: rt(updates.notionRecordId) };
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

// Run a query to completion, following pagination. Returns { results } like a single page.
const queryAll = async (params) => {
  const results = [];
  let cursor;

  do {
    const response = await queryDatabase({ ...params, page_size: 100, start_cursor: cursor });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return { results };
};

// OR filter matching any of the given Status values
const statusIn = (...names) => ({
  or: names.map(name => ({ property: 'Status', select: { equals: name } }))
});

// Query projects the digest can draw from: Backlog (not yet tasked) or Active
const queryActiveProjects = async () => {
  const { projects } = getDatabaseIds();

  return queryDatabase({
    database_id: projects,
    filter: statusIn('Backlog', 'Active'),
    page_size: 20
  });
};

// Query backlog/active people who have a follow-up written down (for daily digest)
const queryPeopleWithFollowUps = async () => {
  const { people } = getDatabaseIds();

  return queryDatabase({
    database_id: people,
    filter: {
      and: [
        statusIn('Backlog', 'Active'),
        { property: 'Follow-ups', rich_text: { is_not_empty: true } }
      ]
    },
    page_size: 10
  });
};

// Query admin tasks due today, overdue, or undated (for daily digest), oldest first.
// Upcoming tasks start tomorrow, so no due date falls between the two queries.
const queryOverdueAdmin = async () => {
  const { admin } = getDatabaseIds();

  return queryDatabase({
    database_id: admin,
    filter: {
      and: [
        {
          or: [
            { property: 'Due Date', date: { on_or_before: getMSTDate().split('T')[0] } },
            { property: 'Due Date', date: { is_empty: true } }
          ]
        },
        statusIn('Backlog', 'Active')
      ]
    },
    page_size: 10,
    sorts: [{ property: 'Due Date', direction: 'ascending' }]
  });
};

// Query upcoming admin tasks (next week) for daily digest
const queryUpcomingAdmin = async () => {
  const { admin } = getDatabaseIds();

  return queryDatabase({
    database_id: admin,
    filter: {
      and: [
        { property: 'Due Date', date: { after: getMSTDate().split('T')[0] } },
        statusIn('Backlog', 'Active')
      ]
    },
    page_size: 10,
    sorts: [{ property: 'Due Date', direction: 'ascending' }]
  });
};

// Query this week's inbox log (for weekly digest)
const queryWeekInboxLog = async () => {
  const { inboxLog } = getDatabaseIds();

  return queryAll({
    database_id: inboxLog,
    filter: {
      property: 'Created',
      date: { past_week: {} }
    }
  });
};

// Query all backlog/active/blocked projects (for weekly digest)
const queryAllOpenProjects = async () => {
  const { projects } = getDatabaseIds();

  return queryAll({
    database_id: projects,
    filter: statusIn('Backlog', 'Active', 'Blocked')
  });
};

// Query all backlog/active admin tasks (for weekly digest)
const queryAllOpenAdmin = async () => {
  const { admin } = getDatabaseIds();

  return queryAll({
    database_id: admin,
    filter: statusIn('Backlog', 'Active'),
    sorts: [{ property: 'Due Date', direction: 'ascending' }]
  });
};

// Query open inbox log entries (Backlog, Active, or Blocked)
const queryOpenInboxLog = async () => {
  const { inboxLog } = getDatabaseIds();

  return queryAll({
    database_id: inboxLog,
    filter: statusIn('Backlog', 'Active', 'Blocked')
  });
};

// Query inbox log entries needing review (for weekly planning digest)
const queryNeedsReviewInboxLog = async () => {
  const { inboxLog } = getDatabaseIds();

  return queryAll({
    database_id: inboxLog,
    filter: {
      property: 'Status',
      select: { equals: 'Needs Review' }
    }
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
  APP_NAME,
  createInboxLogEntry,
  createPeopleEntry,
  findPeopleByName,
  updatePersonFromCapture,
  mergeText,
  createProjectsEntry,
  createAdminEntry,
  findInboxLogByThreadTs,
  findInboxLogByRecordId,
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
  queryAllOpenAdmin,
  queryOpenInboxLog,
  queryNeedsReviewInboxLog,
  queryAllRecordsFromDatabase,
  queryAllInboxLogRecordIds
};

