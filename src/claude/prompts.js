// Pure prompt builders (no network) so they can be unit tested.
//
// Conventions: instructions first, variable data in XML tags, one shared
// schema per record type. Rendering is single-pass with a function replacer so
// user text containing "$&" or "{{TODAY}}" is never interpreted.

const TIMEZONE = 'America/Phoenix';

const getDateContext = (now = new Date()) => ({
  date: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: TIMEZONE }),
  dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIMEZONE })
});

const render = (template, vars) =>
  template.replace(/{{(\w+)}}/g, (match, key) => (key in vars ? String(vars[key]) : match));

const USER_ROLE = 'a Director of Engineering at an eCommerce company, managing three teams working on the product catalog, catalog management tool, and credit reserve software.';

// Template variables for naming the user. Falls back to "the user" when no name is
// configured. Pronouns are never assumed: the prompts use the name or second person.
const userVars = (userName) => {
  const user = (userName || '').trim() || 'the user';
  return {
    USER: user,
    USER_CONTEXT: `${user[0].toUpperCase()}${user.slice(1)} is ${USER_ROLE}`
  };
};

const STATUS_RULES = `- Status for people: "Active", "Needs Review", or "Done". Status for projects and admin: "Active", "Waiting", "Blocked", or "Done".
- "next_action" must be specific and executable. Bad: "Work on website". Good: "Email Sarah to confirm deadline".
- Resolve relative dates ("tomorrow", "Friday") against today's date and format as YYYY-MM-DD. "due_date" must be a future date; otherwise null.
- Use [] for tags when none clearly apply.`;

// Record schemas shared by categorization and reclassification. "confidence"
// is added by the categorization prompt only.
const RECORD_SCHEMAS = `people:   {"name", "status", "context" (how you know them / their role), "follow_ups", "tags": []}
projects: {"name", "status", "next_action", "notes", "tags": []}
ideas:    {"name", "one_liner" (core insight, one sentence), "notes", "tags": []}
admin:    {"name", "status", "due_date" (YYYY-MM-DD or null), "notes" (context and details to follow up on)}`;

const CATEGORIZATION_PROMPT = `Categorize the captured message below and extract its fields.

<message>
{{INPUT}}
</message>

Today is {{TODAY}} ({{DAY_OF_WEEK}}).

# Categories
- "people": information about a person, a relationship update, something someone said.
- "projects": ongoing work with multiple steps or no clear end date.
- "ideas": a thought, insight, or concept to explore later.
- "admin": a one-off errand or task, meeting/event prep, anything with a due date, or a reminder. A one-off task stays admin even when it involves another person ("finalize the agenda with Dan on Monday", "complete pre-work for the offsite by 7/27").

Ticket heuristic: a Jira ticket (or "ticket(s)" in a Jira-like engineering context) defaults to "projects" because it implies ongoing multi-step work. A ServiceNow ticket defaults to "admin" because it is usually a one-off request.

# Confidence
Score 0.0-1.0: 0.9+ obvious, 0.7-0.89 good match, 0.5-0.69 could be several categories, below 0.5 very unclear.
A concrete one-off task with a deadline, a named event/meeting, or a single clear deliverable should score 0.8+ as admin (or projects if clearly multi-step). A person's name or a date alone does not lower confidence or justify "needs_review".
Below 0.6, use destination "needs_review".

# Output
Return only a JSON object with no markdown:
{"destination": "<people|projects|ideas|admin>", "confidence": <number>, "data": {<fields>}}

Fields by destination:
${RECORD_SCHEMAS}
needs_review: {"original_text", "possible_categories": [], "reason"}

${STATUS_RULES}`;

const RECLASSIFICATION_PROMPT = `Extract structured data from the text below for a {{CATEGORY}} record. The category is already decided; do not reconsider it.

<text>
{{TEXT}}
</text>

Status: {{STATUS}}
Today is {{TODAY}} ({{DAY_OF_WEEK}}).

Return only a JSON object with no markdown:
{"destination": "{{CATEGORY}}", "data": {<fields>}}

Fields by destination:
${RECORD_SCHEMAS}

${STATUS_RULES}`;

const DAILY_DIGEST_PROMPT = `Prepare the daily digest for {{USER}}. {{USER_CONTEXT}} The digest runs at 5am on weekdays, before the workday starts.

Today is {{DATE}} ({{DAY_OF_WEEK}}).

<data>
{{CONTEXT}}
</data>
{{EXISTING_TASKS}}{{COMPLETED_TASKS}}
# Reading the data
- TASKS DUE: admin tasks that are due today, overdue, or have no due date. An [URGENT] item is a system alert that comes first.
- UPCOMING TASKS: due later; use them to spot what to start early, not as today's work.
- ACTIVE PROJECTS: Waiting projects are blocked on someone else, so they rarely need a new task.
- PEOPLE TO FOLLOW UP WITH: people with an open follow-up.

# Output
Return only a JSON object with no markdown:
{
  "newTasks": [{"title": "...", "notes": "..."}],
  "peopleToConnect": [{"name": "...", "followUp": "..."}],
  "watchOutFor": "..." or null,
  "smallWin": "..." or null
}

# Rules
- newTasks: up to 3, most important first, [] if nothing qualifies. Rank [URGENT] items, then overdue tasks, then next actions on Active projects.
- Each title is a specific action {{USER}} can do today, not motivation. Bad: "Work on website". Good: "Email Sarah to confirm deadline".
- notes: under 150 characters, naming the project, person, or due date the task comes from.
- Skip anything already in existing_tasks, and do not recreate anything in completed_tasks.
- peopleToConnect: up to 3, each with the follow-up to raise; [] if none.
- watchOutFor: one or two sentences on what is stuck, overdue, or neglected; null if nothing.
- smallWin: one sentence on recent progress, taken from completed_tasks or project status; null if nothing.
- Use only names and facts from the data.
- Write watchOutFor and smallWin directly to {{USER}} in second person ("you").`;

const WEEKLY_DIGEST_PROMPT = `Write a weekly review and week-ahead plan for {{USER}}. {{USER_CONTEXT}} The digest runs Sunday night: review the week that just ended, then plan the next one.

Today is {{DATE}} ({{DAY_OF_WEEK}}).

<data>
{{CONTEXT}}
{{COMPLETED_TASKS}}
</data>

# Output
Use exactly these sections, in this order. Omit a section, heading included, when its data is empty. Use only what is in <data>; never invent meetings, projects, tasks, or review items.

# Week in Review
## Quick Stats
This week's captures (total and by category) and tasks completed, compared with WEEKLY TREND: direction, and any figure well above or below the prior-week average. Weeks marked "not recorded" are missing data, not zero.
## What Moved Forward
Projects with a recent Last Touched date, and items from COMPLETED TASKS LAST WEEK.
## Open Loops (needs attention)
Blocked, stalled, or waiting items from ACTIVE PROJECTS STATUS and ACTIVE ADMIN TASKS. Flag projects and admin tasks last touched over a week ago (use Created for admin tasks with no Last Touched).
## Needs Review
Each NEEDS REVIEW item with a one-line reason it is ambiguous.
## Week Ahead: Meetings to Prep For
From UPCOMING MEETINGS THIS WEEK, only meetings likely to need prep (external, presentations, 1:1s with an open agenda item, or tied to an active project or admin task), each with a one-line prep suggestion. Skip routine meetings.
## Patterns I Notice
One observation about themes or where energy is going, drawn from ITEMS CAPTURED LAST WEEK and WEEKLY TREND (for example a category growing or shrinking, or captures outpacing completions). Cite only trends the data supports; with no prior weeks, don't claim any.
## Suggested Focus for Next Week
Three numbered, concrete actions, highest priority first, each grounded in a project, admin task, or meeting from the data.

# Style
Analytical, concise, and direct; say plainly when something looks stuck. Use bullets, not tables (the output is posted to Slack). Emojis sparingly.
Write directly to {{USER}} in second person ("you") rather than referring to them in the third person.`;

const TASK_COMPLETION_MATCH_PROMPT = `Match completed Google Tasks to open inbox items. A match means both refer to the same action, project, or topic, even if worded differently.

<completed_tasks>
{{TASKS}}
</completed_tasks>

<open_inbox_items>
{{INBOX_ITEMS}}
</open_inbox_items>

Return only a JSON object with no markdown:
{"matches": [{"inboxItemId": "<ID from the inbox item>", "inboxDestinationName": "<its Name>", "matchedTaskTitle": "<completed task title>", "confidence": 0.0}]}

- Include only matches with confidence >= 0.7.
- Each inbox item matches at most one task.
- If nothing matches, return {"matches": []}.`;

const titleList = (tasks) => tasks.map(t => `- ${t.title}`).join('\n');

const buildCategorizationPrompt = (text, now) => {
  const { date, dayOfWeek } = getDateContext(now);
  return render(CATEGORIZATION_PROMPT, { INPUT: text, TODAY: date, DAY_OF_WEEK: dayOfWeek });
};

const buildReclassificationPrompt = (text, category, status, now) => {
  const { date, dayOfWeek } = getDateContext(now);
  return render(RECLASSIFICATION_PROMPT, {
    CATEGORY: category,
    TEXT: text,
    STATUS: status || 'Active',
    TODAY: date,
    DAY_OF_WEEK: dayOfWeek
  });
};

const buildDailyDigestPrompt = (context, existingTasks = [], completedTasks = [], now, userName) => {
  const { date, dayOfWeek } = getDateContext(now);
  const existing = existingTasks.length
    ? `\n<existing_tasks>\n${titleList(existingTasks)}\n</existing_tasks>\n`
    : '';
  const completed = completedTasks.length
    ? `\n<completed_tasks>\n${titleList(completedTasks)}\n</completed_tasks>\n`
    : '';
  return render(DAILY_DIGEST_PROMPT, {
    CONTEXT: context,
    DATE: date,
    DAY_OF_WEEK: dayOfWeek,
    EXISTING_TASKS: existing,
    COMPLETED_TASKS: completed,
    ...userVars(userName)
  });
};

const buildWeeklyDigestPrompt = (context, completedTasks = [], now, userName) => {
  const { date, dayOfWeek } = getDateContext(now);
  const completed = completedTasks.length
    ? `\n## COMPLETED TASKS LAST WEEK\n${titleList(completedTasks)}`
    : '';
  return render(WEEKLY_DIGEST_PROMPT, {
    CONTEXT: context,
    DATE: date,
    DAY_OF_WEEK: dayOfWeek,
    COMPLETED_TASKS: completed,
    ...userVars(userName)
  });
};

const buildTaskMatchPrompt = (tasksText, itemsText) =>
  render(TASK_COMPLETION_MATCH_PROMPT, { TASKS: tasksText, INBOX_ITEMS: itemsText });

module.exports = {
  getDateContext,
  render,
  buildCategorizationPrompt,
  buildReclassificationPrompt,
  buildDailyDigestPrompt,
  buildWeeklyDigestPrompt,
  buildTaskMatchPrompt
};
