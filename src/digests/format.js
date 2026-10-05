// Helpers for turning Notion pages into the plain-text context sections fed to the LLM.

// Property readers that tolerate missing properties
const prop = {
  title: (page, name) => page.properties?.[name]?.title?.[0]?.plain_text,
  text: (page, name) => page.properties?.[name]?.rich_text?.[0]?.plain_text,
  select: (page, name) => page.properties?.[name]?.select?.name,
  date: (page, name) => page.properties?.[name]?.date?.start
};

// A "## HEADING" block, or '' when there are no lines so empty sections are omitted
const section = (heading, lines) => (lines.length ? `\n## ${heading}\n${lines.join('\n')}\n` : '');

// Indented "label: value" lines, skipping missing values
const fields = (pairs) =>
  pairs.filter(([, value]) => value).map(([label, value]) => `   ${label}: ${value}`);

module.exports = { prop, section, fields };
