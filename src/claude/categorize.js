const { createMessage, getModel } = require('../llm/client');

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

const CATEGORIZATION_PROMPT = `# INPUT
{{INPUT}}

# INSTRUCTIONS
1. Determine which category this belongs to:
   - "people" - information about a person, relationship update, something someone said
   - "projects" - a project, task with multiple steps, ongoing work
   - "ideas" - a thought, insight, concept, something to explore later
   - "admin" - a simple errand, one-off task, meeting/event prep, something with a due date or deadline, or a reminder. A one-off task is still admin even if it involves coordinating with another person (e.g. "finalize the agenda with Dan on Monday", "complete pre-work for the offsite by 7/27") — it only becomes a project if it has multiple ongoing steps or no clear end date.

   Ticket-tracker heuristic (apply before falling back to "needs_review"):
   - If a Jira ticket (or "ticket"/"tickets" in a Jira-like engineering context) is mentioned, default to "projects" — creating/managing tickets implies ongoing, multi-step work.
   - If a ServiceNow ticket is mentioned, default to "admin" — ServiceNow tickets are typically one-off requests or errands.

2. Extract the relevant fields based on category

3. Assign a confidence score (0.0 to 1.0):
   - 0.9-1.0: Very clear category, obvious classification
   - 0.7-0.89: Fairly confident, good match
   - 0.5-0.69: Uncertain, could be multiple categories
   - Below 0.5: Very unclear, needs human review

4. If confidence is below 0.6, set destination to "needs_review"

5. Return ONLY this JSON, no other text

For PEOPLE:
{
  "destination": "people",
  "confidence": 0.85,
  "data": {
    "name": "Person's Name",
    "status": "Active",
    "context": "How you know them or their role",
    "follow_ups": "Things to remember for next time",
    "tags": ["work", "friend"]
  }
}

For PROJECTS:
{
  "destination": "projects",
  "confidence": 0.85,
  "data": {
    "name": "Project Name",
    "status": "Active",
    "next_action": "Specific next action to take",
    "notes": "Additional context",
    "tags": ["work"]
  }
}

For IDEAS:
{
  "destination": "ideas",
  "confidence": 0.85,
  "data": {
    "name": "Idea Title",
    "one_liner": "Core insight in one sentence",
    "notes": "Elaboration if provided",
    "tags": ["product"]
  }
}

For ADMIN:
{
  "destination": "admin",
  "confidence": 0.85,
  "data": {
    "name": "Task name",
    "status": "Active",
    "due_date": "YYYY-MM-DD",
    "notes": "Additional context and details to follow up on"
  }
}

For UNCLEAR (confidence below 0.6):
{
  "destination": "needs_review",
  "confidence": 0.45,
  "data": {
    "original_text": "The original message",
    "possible_categories": ["projects", "admin"],
    "reason": "Could be a project or a simple task"
  }
}

# RULES
- "next_action" must be specific and executable. "Work on website" is bad. "Email Sarah to confirm deadline" is good.
- If a person's name is mentioned, consider if this is really about that person or about a project/task involving them. Mentioning a person's name for coordination on a single task (e.g. "with Dan", "with Sarah") does NOT by itself lower confidence or make something "needs_review" — it's still a normal admin/project item.
- A concrete one-off task with a deadline, a named event/meeting, or a clear single deliverable should score 0.8+ confidence as "admin" (or "projects" if it clearly has multiple ongoing steps) — do not default to "needs_review" just because a date or person is present.
- Status options for people: "Active", "Needs Review"
- Status options for projects and admin: "Active", "Waiting", "Blocked", "Done"
- Today's date is {{TODAY}} {{DAY_OF_WEEK}}. Use this to resolve relative dates like "tomorrow", "next week", "Friday", etc. to help determine due dates.
- Extract dates when mentioned and format as YYYY-MM-DD. Due date should be a date in the future, otherwise set to null
- If no clear tags apply, use an empty array []
- Always return valid JSON with no markdown formatting`;

const categorizeMessage = async (text) => {
  const date = new Date();
  const today = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' });
  const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Phoenix' });
  const prompt = CATEGORIZATION_PROMPT
    .replace('{{INPUT}}', text)
    .replace('{{TODAY}}', today)
    .replace('{{DAY_OF_WEEK}}', dayOfWeek);

  const response = await createMessage({
    model: getModel(),
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

const RECLASSIFICATION_PROMPT = `Extract structured data from this text for a {{CATEGORY}} record.

{{TEXT}}

CATEGORY: {{CATEGORY}}
STATUS: {{STATUS}}
Today's date is {{TODAY}} {{DAY_OF_WEEK}}

# INSTRUCTIONS

Return ONLY this JSON, no other text

For PEOPLE:
{
  "destination": "people",
  "data": {
    "name": "Person's Name",
    "status": "Active",
    "context": "How you know them or their role",
    "follow_ups": "Things to remember for next time",
    "tags": ["work", "friend"]
  }
}

For PROJECTS:
{
  "destination": "projects",
  "data": {
    "name": "Project Name",
    "status": "Active",
    "next_action": "Specific next action to take",
    "notes": "Additional context",
    "tags": ["work"]
  }
}

For IDEAS:
{
  "destination": "ideas",
  "data": {
    "name": "Idea Title",
    "one_liner": "Core insight in one sentence",
    "notes": "Elaboration if provided",
    "tags": ["product"]
  }
}

For ADMIN:
{
  "destination": "admin",
  "data": {
    "name": "Task name",
    "status": "Active",
    "due_date": "YYYY-MM-DD or null if not specified",
    "notes": "Additional context and details to follow up on"
  }
}

# RULES
- Status options for people: "Active", "Needs Review"
- Status options for projects and admin: "Active", "Waiting", "Blocked", "Done"
- "next_action" must be specific and executable
- Extract dates when mentioned and format as YYYY-MM-DD. Due date should be a date in the future, otherwise set to null
- If no clear tags apply, use an empty array []`;

const reclassifyMessage = async (text, newCategory, currentStatus) => {
  const dateObj = new Date();
  const today = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' });
  const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Phoenix' });
  const prompt = RECLASSIFICATION_PROMPT
    .replace(/{{CATEGORY}}/g, newCategory)
    .replace('{{TEXT}}', text)
    .replace('{{STATUS}}', currentStatus || 'Active')
    .replace('{{TODAY}}', today)
    .replace('{{DAY_OF_WEEK}}', dayOfWeek);

  const response = await createMessage({
    model: getModel(),
    maxTokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const aiResponse = extractResponseText(response);
  return parseCategorizationResponse(aiResponse);
};

const DAILY_DIGEST_STRUCTURED_PROMPT = `You are a personal productivity assistant for a Director of Software Engineering working at an eCommerce Company. Generate a structured daily digest for me based on the following data.

{{CONTEXT}}
{{EXISTING_TASKS}}

{{COMPLETED_TASKS}}

Today's date is {{DATE}} {{DAY_OF_WEEK}}

# OUTPUT FORMAT (return ONLY this JSON, no other text)
{
  "newTasks": [
    { "title": "Most important action", "notes": "Brief context or source" },
    { "title": "Second priority action", "notes": "Brief context" },
    { "title": "Third priority action", "notes": "Brief context" }
  ],
  "peopleToConnect": [
    { "name": "Person name", "followUp": "Brief reminder" }
  ],
  "watchOutFor": "Things that might be stuck, overdue, or getting neglected",
  "smallWin": "Something positive or progress made, or encouraging thought"
}

# RULES
- Keep notes brief (under 150 characters)
- If no peopleToConnect, use empty array []
- If nothing to watch out for, use null
- If no small win to note, use null
- Always return valid JSON with no markdown formatting

For newTasks:
- Be specific and actionable, not motivational
- "Work on website" is bad. "Email Sarah to confirm deadline" is a good task
- Prioritize TASKS DUE and ACTIVE PROJECTS based on concrete actions
- There can be fewer than 3 newTasks, that's fine
- Do not suggest newTasks that duplicate what is already captured in existing existing tasks
- Do not reopen completed tasks as new tasks
- If no newTasks, use empty array []`;

const generateDailyDigestStructured = async (context, existingTasks = [], completedTasks = []) => {
  const dateObj = new Date();
  const date = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' });
  const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Phoenix' });

  // Format existing tasks for the prompt
  const existingTasksText = existingTasks.length > 0
    ? 'EXISTING TASKS (already captured, use as reference do not duplicate as newTasks):\n' + existingTasks.map(t => ` - ${t.title}`).join('\n')
    : '';

  // Format completed tasks for the prompt
  const completedTasksText = completedTasks.length > 0
    ? 'COMPLETED TASKS IN THE LAST 5 DAYS (do not reopen as new tasks):\n' + completedTasks.map(t => ` - ${t.title}`).join('\n')
    : '';

  const prompt = DAILY_DIGEST_STRUCTURED_PROMPT
    .replace('{{CONTEXT}}', context)
    .replace('{{DATE}}', date)
    .replace('{{DAY_OF_WEEK}}', dayOfWeek)
    .replace('{{EXISTING_TASKS}}', existingTasksText)
    .replace('{{COMPLETED_TASKS}}', completedTasksText);

  const response = await createMessage({
    model: getModel(),
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

const formatDigestForSlack = (digest) => {
  let text = 'Good morning!\n\n';

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

const WEEKLY_DIGEST_PROMPT = `You are a personal productivity assistant for a Director of Software Engineering working at an eCommerce Company. I manage three teams working on catalog, basket, and product definition software. This runs Sunday night, so review the week that just ended and plan the week ahead. Analyze the following data and generate an insightful summary for me.

{{CONTEXT}}
{{COMPLETED_TASKS}}

Today's date is {{DATE}} {{DAY_OF_WEEK}}

# INSTRUCTIONS
Create a weekly review + week-ahead plan with this format:

# Week in Review

## Quick Stats
[Pull directly from CAPTURE SUMMARY — total captures and the per-category breakdown]

## What Moved Forward
- [A project from ACTIVE PROJECTS STATUS with a recent Last Touched date, or a completed item from COMPLETED TASKS LAST WEEK]
- [Another win or completion]

## Open Loops (needs attention)
1. [Something blocked, stalled, or waiting too long — draw from ACTIVE PROJECTS STATUS and ACTIVE ADMIN TASKS]
2. [Another concern]

## Needs Review
[List items from the NEEDS REVIEW section that need a decision, with a one-line reason why each is ambiguous. Skip if section is empty, don't make something up.]

## Week Ahead: Meetings to Prep For
[Scan UPCOMING MEETINGS THIS WEEK and flag the ones that likely need prep (external meetings, presentations, 1:1s with an open agenda item, anything tied to an active project or admin task) with a one-line prep suggestion each. Skip routine/recurring meetings with nothing to prep.]

## Patterns I Notice
[One observation about themes, recurring topics, or where energy is going, drawn from ITEMS CAPTURED LAST WEEK and CAPTURE SUMMARY]

## Suggested Focus for Next Week
1. [Specific action for highest priority item — ground this in ACTIVE PROJECTS STATUS, ACTIVE ADMIN TASKS, and/or UPCOMING MEETINGS THIS WEEK, not a generic suggestion]
2. [Second priority]
3. [Third priority]

# RULES
- Be analytical, not motivational
- Flag projects whose Last Touched date is more than a week old, and admin tasks whose Created date is more than a week old — both indicate no recent action
- Note if capture volume in CAPTURE SUMMARY was unusually high or low
- Only cite meetings, projects, admin tasks, and review items that actually appear, never invent one
- If a section has no content, skip it entirely.
- Suggest concrete next actions, not vague intentions
- If something looks stuck, say so directly
- Keep language concise and actionable
- Use emojis sparingly for emphasis, not decoration`;

const generateWeeklyDigest = async (context, completedTasks = []) => {
  const dateObj = new Date();
  const date = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' });
  const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Phoenix' });

  const completedTasksText = completedTasks.length > 0
    ? '\n## COMPLETED TASKS LAST WEEK\n' + completedTasks.map(t => `- ${t.title}`).join('\n')
    : '';

  const prompt = WEEKLY_DIGEST_PROMPT
    .replace('{{CONTEXT}}', context)
    .replace('{{DATE}}', date)
    .replace('{{DAY_OF_WEEK}}', dayOfWeek)
    .replace('{{COMPLETED_TASKS}}', completedTasksText);

  const response = await createMessage({
    model: getModel(),
    maxTokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });

  return extractResponseText(response);
};

const TASK_COMPLETION_MATCH_PROMPT = `You are matching completed Google Tasks against open inbox items from a personal productivity system.

# COMPLETED TASKS
{{TASKS}}

# OPEN INBOX ITEMS
{{INBOX_ITEMS}}

# INSTRUCTIONS
For each completed task, check if it semantically matches an open inbox item. A match means the task and inbox item refer to the same action, project, or topic — even if worded differently.

OUTPUT FORMAT (return ONLY this JSON, no other text):
{
  "matches": [
    {
      "inboxItemId": "notion-page-id",
      "inboxDestinationName": "Name from inbox item",
      "matchedTaskTitle": "Title of the completed task",
      "confidence": 0.85
    }
  ]
}

# RULES
- Only include matches with confidence >= 0.7
- Each inbox item should match at most one task
- If no matches exist, return { "matches": [] }
- Always return valid JSON with no markdown formatting`;

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

  const prompt = TASK_COMPLETION_MATCH_PROMPT
    .replace('{{TASKS}}', tasksText)
    .replace('{{INBOX_ITEMS}}', itemsText);

  const response = await createMessage({
    model: getModel(),
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

