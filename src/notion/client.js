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

const getDatabaseIds = () => {
  const config = getNotionConfig();
  return config.databases;
};

// Cache mapping database_id -> data_source_id (SDK v5 removed databases.query)
const dataSourceCache = new Map();

const getDataSourceId = async (databaseId) => {
  if (dataSourceCache.has(databaseId)) return dataSourceCache.get(databaseId);

  const client = getClient();
  const db = await client.databases.retrieve({ database_id: databaseId });
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
  return client.dataSources.query({ data_source_id: dataSourceId, ...rest });
};

module.exports = {
  getClient,
  getDatabaseIds,
  queryDatabase
};
