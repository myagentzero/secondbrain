// One-time migration: add a "Created by" select to the Inbox Log and backfill existing rows with the app name.
// Safe to re-run: the property is only added when missing and only empty rows are written.
const { getClient, getDatabaseIds, queryDatabase, updatePage } = require('../src/notion/client');
const { APP_NAME } = require('../src/notion/databases');

const PROPERTY = 'Created by';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const { inboxLog } = getDatabaseIds();
  const client = getClient();

  const db = await client.databases.retrieve({ database_id: inboxLog });
  const dataSourceId = db.data_sources[0].id;
  const dataSource = await client.dataSources.retrieve({ data_source_id: dataSourceId });

  if (dataSource.properties[PROPERTY]) {
    console.log(`"${PROPERTY}" already exists (type: ${dataSource.properties[PROPERTY].type})`);
  } else {
    await client.dataSources.update({
      data_source_id: dataSourceId,
      properties: { [PROPERTY]: { select: { options: [{ name: APP_NAME, color: 'blue' }] } } }
    });
    console.log(`Added "${PROPERTY}" select to Inbox Log`);
  }

  let cursor;
  let updated = 0;
  let skipped = 0;
  do {
    const page = await queryDatabase({ database_id: inboxLog, page_size: 100, start_cursor: cursor });
    for (const row of page.results) {
      if (row.properties?.[PROPERTY]?.select?.name) {
        skipped++;
        continue;
      }
      await updatePage({ page_id: row.id, properties: { [PROPERTY]: { select: { name: APP_NAME } } } });
      updated++;
      await sleep(350);
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  console.log(`Backfilled ${updated} rows (${skipped} already set)`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
