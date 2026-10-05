const { createMessage, getModel } = require('../llm/client');
const { getUserName } = require('../config');
const {
  buildCategorizationPrompt,
  buildReclassificationPrompt,
  buildDailyDigestPrompt,
  buildWeeklyDigestPrompt,
  buildTaskMatchPrompt
} = require('./prompts');

// LLM responses can occasionally come back malformed (empty content, no text
// block) when a provider hiccups. Extracting through one helper means every
// call site gets a clear error instead of a raw "Cannot read properties of
// undefined" and callers can decide how to fail soft.
const extractResponseText = (response) => {
  const text = response?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`LLM response missing text content: ${JSON.stringify(response)?.slice(0, 500)}`);
  }
  return text;
};

const categorizeMessage = async (text) => {
  const prompt = buildCategorizationPrompt(text);

  const response = await createMessage({
    model: getModel('categorize'),
    maxTokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const aiResponse = extractResponseText(response);
  return parseCategorizationResponse(aiResponse);
};

const parseCategorizationResponse = (response) => {
  // Remove markdown code blocks if present
  let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      destination: parsed.destination || 'Needs Review',
      confidence: parsed.confidence,
      data: parsed.data,
      name: parsed.data.name || parsed.data.original_text || 'Untitled',
      status: parsed.data.status || 'Active',
      nextAction: parsed.data.next_action || null,
      context: parsed.data.context || null,
      followUps: parsed.data.follow_ups || null,
      oneLiner: parsed.data.one_liner || null,
      notes: parsed.data.notes || null,
      dueDate: parsed.data.due_date || null,
      tags: parsed.data.tags || []
    };
  } catch (e) {
    return {
      destination: 'Needs Review',
      confidence: 0,
      data: { original_text: response },
      name: 'Parse Error',
      error: e.message
    };
  }
};

const reclassifyMessage = async (text, newCategory, currentStatus) => {
  const prompt = buildReclassificationPrompt(text, newCategory, currentStatus);

  const response = await createMessage({
    model: getModel('categorize'),
    maxTokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const aiResponse = extractResponseText(response);
  return parseCategorizationResponse(aiResponse);
};

const generateDailyDigestStructured = async (context, existingTasks = [], completedTasks = []) => {
  const prompt = buildDailyDigestPrompt(context, existingTasks, completedTasks, undefined, getUserName());

  const response = await createMessage({
    model: getModel('digest'),
    maxTokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    const aiResponse = extractResponseText(response);
    const cleaned = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse structured digest:', e.message);
    return {
      newTasks: [],
      peopleToConnect: [],
      watchOutFor: 'Digest generation failed to parse today — check server logs for the raw model response.',
      smallWin: null,
      error: e.message
    };
  }
};

const formatDigestForSlack = (digest, userName = getUserName()) => {
  let text = `Good morning${userName ? `, ${userName}` : ''}!\n\n`;

  if (digest.newTasks && digest.newTasks.length > 0) {
    text += '*Top Actions Today:*\n';
    digest.newTasks.forEach((action, i) => {
      text += `${i + 1}. ${action.title}\n`;
    });
    text += '\n';
  }

  if (digest.peopleToConnect && digest.peopleToConnect.length > 0) {
    text += '*People to Connect With:*\n';
    digest.peopleToConnect.forEach(person => {
      text += `- ${person.name}: ${person.followUp}\n`;
    });
    text += '\n';
  }

  if (digest.watchOutFor) {
    text += '*Watch Out For:*\n';
    text += `${digest.watchOutFor}\n\n`;
  }

  if (digest.smallWin) {
    text += '*One Small Win to Notice:*\n';
    text += `${digest.smallWin}\n`;
  }

  return text.trim();
};

const generateWeeklyDigest = async (context, completedTasks = []) => {
  const prompt = buildWeeklyDigestPrompt(context, completedTasks, undefined, getUserName());

  const response = await createMessage({
    model: getModel('digest'),
    maxTokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });

  return extractResponseText(response);
};

const matchCompletedTasksToInbox = async (completedTasks, inboxItems) => {
  if (!completedTasks.length || !inboxItems.length) {
    return { matches: [] };
  }

  const tasksText = completedTasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');

  const itemsText = inboxItems.map(item => {
    const id = item.id;
    const destName = item.properties?.['Destination Name']?.rich_text?.[0]?.plain_text || 'Untitled';
    const filedTo = item.properties?.['Filed-To']?.select?.name || 'Unknown';
    const status = item.properties?.Status?.select?.name || 'Unknown';
    return `- ID: ${id} | Name: ${destName} | Filed-To: ${filedTo} | Status: ${status}`;
  }).join('\n');

  const prompt = buildTaskMatchPrompt(tasksText, itemsText);

  const response = await createMessage({
    model: getModel('categorize'),
    maxTokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    const aiResponse = extractResponseText(response);
    const cleaned = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse task completion matches:', e.message);
    return { matches: [] };
  }
};

module.exports = {
  categorizeMessage,
  reclassifyMessage,
  generateDailyDigestStructured,
  formatDigestForSlack,
  generateWeeklyDigest,
  matchCompletedTasksToInbox
};

