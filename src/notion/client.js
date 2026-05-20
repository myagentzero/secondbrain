const { Client } = require('@notionhq/client');
const { getNotionConfig } = require('../config');

let notionClient = null;

const getClient = () => {
  if (notionClient) return notionClient;

  const config = getNotionConfig();
  notionClient = new Client({
    auth: config.token,
    notionVersion: "2026-03-11"
  });
  return notionClient;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const RETRYABLE_CODES = new Set(['notionhq_client_request_timeout', 'service_unavailable']);

const withRetry = async (fn, maxAttempts = 3, baseDelayMs = 1000) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts || !RETRYABLE_CODES.has(err.code)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Notion request failed (${err.code}), attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
};

const getDatabaseIds = () => {
  const config = getNotionConfig();
  return config.databases;
};

// Cache mapping database_id -> data_source_id (SDK v5 removed databases.query)
const dataSourceCache = new Map();

const getDataSourceId = async (databaseId) => {
  if (dataSourceCache.has(databaseId)) return dataSourceCache.get(databaseId);

  const client = getClient();
  const db = await withRetry(() => client.databases.retrieve({ database_id: databaseId }));
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(`No data source found for database ${databaseId}`);
  }
  dataSourceCache.set(databaseId, dataSourceId);
  return dataSourceId;
};

// Drop-in replacement for the removed notion.databases.query()
const queryDatabase = async (params) => {
  const client = getClient();
  const { database_id, ...rest } = params;
  const dataSourceId = await getDataSourceId(database_id);
  return withRetry(() => client.dataSources.query({ data_source_id: dataSourceId, ...rest }));
};

const createPage = (params) => {
  const client = getClient();
  return withRetry(() => client.pages.create(params));
};

const updatePage = (params) => {
  const client = getClient();
  return withRetry(() => client.pages.update(params));
};

module.exports = {
  getClient,
  getDatabaseIds,
  queryDatabase,
  createPage,
  updatePage
};
