# Second Brain

A self-hosted productivity system that captures thoughts from Slack, categorizes them with AI, and stores them in Notion databases.

## Features

- **Capture**: Listen for messages in `#secondbrain` Slack channel
- **Categorize**: Claude Haiku classifies into people/projects/ideas/admin (confidence > 0.6)
- **Store**: Create entries in appropriate Notion database + Inbox Log audit trail
- **Correct**: Handle "fix:" and "update:" replies to re-categorize or change status
- **Digest**: Daily (5am) and weekly (Sunday 5pm) summaries with Google Tasks integration
- **Deliver**: Post to Slack channels AND create Google Task events

## Stack

| Layer | Tool | Cost |
|-------|------|------|
| Capture | Slack `#secondbrain` channel | Free |
| Automation | Node.js on Raspberry Pi | $0 |
| Storage | Notion (5 databases) | Free |
| AI | Claude API (Haiku) | ~$1-2/month |
| Delivery | Slack + Google Tasks | Free |

## Setup

### Prerequisites

1. Slack workspace with bot permissions
2. Notion integration with database access
3. Anthropic API key
4. Google Cloud project with Calendar/Task API enabled

### Configuration

1. Copy `credentials.template.json` to `credentials.json`
2. Fill in all required credentials (see sections below)

### Google API Setup

1. Visit https://console.cloud.google.com/
2. Create a new project
3. Enable Google Calendar API
4. Create OAuth 2.0 credentials
5. Download credentials and add to `credentials.json` under `installed`

### Slack App Setup

1. Go to https://api.slack.com/apps and create new app
2. Enable Socket Mode (Settings > Socket Mode > Enable)
3. Add Bot Token Scopes: `channels:history`, `channels:read`, `chat:write`
4. Install to workspace
5. Copy Bot Token (`xoxb-...`) and App Token (`xapp-...`) to `credentials.json`

### Notion Setup

1. Go to https://www.notion.so/my-integrations
2. Create new integration with read/write access
3. Create 5 databases: Inbox Log, Admin, Ideas, Projects, People
4. Share each database with the integration
5. Copy integration token and database IDs to `credentials.json`

### Anthropic Setup

1. Go to https://console.anthropic.com/
2. Create an API key
3. Copy to `credentials.json` under `anthropic.apiKey`

## Running

```bash
# Install dependencies
npm install

# Run Second Brain service (Slack bot + scheduler)
npm run brain

# CLI for calendar and tasks (Google Workspace integration)
npm run gws-calendar -- agenda                              # Show today's agenda
npm run gws-calendar -- agenda --days 3                     # Show next 3 days
npm run gws-calendar -- add-event "Title" "2026-05-11 09:00" "2026-05-11 10:00"
npm run gws-calendar -- tasks                               # List open tasks
npm run gws-calendar -- complete <taskId>                   # Mark task as complete
npm run gws-calendar -- sync 1                              # Sync calendar 1 day ahead

# Run calendar sync manually (max 4 days)
npm run sync -- 1    # sync 1 day ahead
npm run sync -- 4    # sync 4 days (weekend coverage, maximum allowed)

# Run digests manually for testing
npm run daily
npm run weekly

# Run maintenance tasks manually
npm run maintenance
```

## Systemd Service (Raspberry Pi)

```bash
# Copy service file
sudo cp secondbrain.service /etc/systemd/system/

# Enable and start
sudo systemctl enable secondbrain
sudo systemctl start secondbrain

# View logs
journalctl -u secondbrain -f

# Restart after changes
sudo systemctl restart secondbrain
```

## Usage

### Capturing Items

Send a message to `#secondbrain`:
```
Met with Sarah from marketing, she mentioned the Q2 budget review is coming up
```

The bot will:
1. Categorize it (e.g., "people")
2. Extract relevant fields (name, context, follow-ups)
3. Create a Notion entry
4. Reply with confirmation

### Correcting Classifications

Reply to any captured message with:
- `fix: projects` - re-categorize to a different destination
- `update: done` - change the status

### Prefixes for Better Accuracy

For clearer classification, use prefixes:
- `person: ...` for people
- `project: ...` for projects
- `idea: ...` for ideas
- `admin: ...` for tasks/errands

## Architecture

```
src/
├── index.js              # Main entry point (starts Slack bot + scheduler)
├── cli.js                # CLI tool for manual calendar/task operations
├── config.js             # Load credentials from credentials.json
├── scheduler.js          # node-cron for scheduled tasks (America/Phoenix tz)
├── slack/
│   ├── client.js         # Slack Bolt setup (Socket Mode)
│   └── handlers.js       # Message handlers (capture, fix, update)
├── notion/
│   ├── client.js         # Notion API client
│   └── databases.js      # CRUD for all 5 databases + Inbox Log
├── llm/
│   └── client.js         # LLM abstraction (LiteLLM with Anthropic fallback)
├── claude/
│   └── categorize.js     # AI categorization + digest generation prompts
├── calendar/
│   ├── events.js         # Google Calendar event creation & agenda retrieval
│   ├── sync.js           # Calendar sync from Outlook/shared calendars
│   └── timeUtility.js    # Timezone conversion utilities
├── tasks/
│   └── tasks.js          # Google Tasks CRUD + cleanup + completion
└── digests/
    ├── daily.js          # Daily digest (5am, Mon-Fri)
    ├── weekly.js         # Weekly digest (Sunday 5pm)
    └── maintenance.js    # Cleanup tasks (4:30am daily)
```

## CLI Tool

The `gws-calendar` CLI provides quick access to calendar and task operations:

```bash
# Show your agenda
npm run gws-calendar -- agenda              # Today
npm run gws-calendar -- agenda --days 7     # Next 7 days

# Create calendar events (times in Phoenix timezone)
npm run gws-calendar -- add-event "Meeting" "2026-05-11 14:00" "2026-05-11 15:00"
npm run gws-calendar -- add-event "Lunch" "2026-05-11 12:00" "2026-05-11 13:00" "With team"

# Manage Google Tasks
npm run gws-calendar -- tasks               # List open tasks
npm run gws-calendar -- complete abc123     # Mark task as done

# Sync calendar events
npm run gws-calendar -- sync 3               # Sync 3 days ahead
```

All times are in Phoenix timezone (UTC-7, no DST).

## Google Tasks Integration

The digest system integrates with Google Tasks to provide better context:

### Daily Digest
- Shows existing incomplete tasks to avoid duplicate suggestions
- Shows recently completed tasks so the AI doesn't re-suggest finished work
- Creates Google Tasks for the Top 3 Actions

### Weekly Digest
- Includes completed tasks in the "What Moved Forward" analysis
- Cleans up completed tasks older than 7 days after digest runs

### Task Lifecycle
1. Daily digest generates Top 3 Actions and creates Google Tasks
2. User completes tasks in Google Tasks throughout the week
3. Weekly digest sees completed tasks for progress tracking
4. Old completed tasks (>7 days) are cleaned up after weekly digest

## Notion Database Schema

### Inbox Log
- Original Text (title)
- Filed-To (select)
- Destination Name (text)
- Destination URL (url)
- Notion Record ID (text)
- Confidence (number)
- Status (select)
- Slack Thread TS (text)
- Created (date)

### People
- Name (title)
- Context (text)
- Follow-ups (text)
- Tags (multi-select)
- Last Touched (date)

### Projects
- Name (title)
- Status (select: Active/Waiting/Blocked/Done)
- Next Action (text)
- Notes (text)
- Tags (multi-select)
- Last Touched (date)

### Ideas
- Name (title)
- One-Liner (text)
- Notes (text)
- Tags (multi-select)
- Last Touched (date)

### Admin
- Name (title)
- Status (select: Active/Done)
- Notes (text)
- Due Date (date)
- Created (date)

## Calendar Sync

Copy events from an Outlook or Google shared calendar to your primary Google Calendar. Managed by the scheduler with the following schedule (all times in America/Phoenix timezone):

- **Weekdays 7am-3pm** (hourly): sync 1 day ahead
- **Mon-Thu 4pm**: sync 2 days ahead
- **Friday 4pm**: sync 4 days ahead (covers the weekend)

Features:
- Fetches events from shared Google calendars and Outlook ICS feeds
- Deduplicates by event title and start time
- Marks canceled events with "Canceled: " prefix (not deleted)
- Color codes synced events (COLOR_ID = 8)
- Rate limited to 1500ms between API calls
- Timezone-aware (converts Windows to IANA format)

```bash
# Manual sync (maximum 4 days)
npm run sync -- 4
```

Note: Manual sync is limited to a maximum of 4 days. Values above 4 will be automatically capped.

## Scheduler

All scheduled tasks run in America/Phoenix timezone:

| Time | Frequency | Task | Details |
|------|-----------|------|---------|
| 4:30 AM | Every day | Maintenance | Clean up old completed tasks |
| 5:00 AM | Mon-Fri | Daily digest | Generate top 3 actions, show incomplete tasks |
| 5:00 PM | Sunday | Weekly digest | Weekly review, task cleanup |
| 7am-3pm | Weekdays | Calendar sync | Sync 1 day ahead (hourly) |
| 4:00 PM | Mon-Thu | Calendar sync | Sync 2 days ahead |
| 4:00 PM | Friday | Calendar sync | Sync 4 days ahead (weekend coverage) |
