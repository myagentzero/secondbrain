# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Second Brain is an AI-powered productivity system that captures thoughts from Slack, categorizes them with Claude, and stores them in Notion databases. It also syncs events from Outlook/Google calendars and generates daily/weekly digests.

## Setup and Configuration

### Initial Setup
1. Copy `credentials.template.json` to `credentials.json`
2. Configure all required credentials (see Prerequisites section in README)

### Required Credentials
- **Slack**: Bot Token (`xoxb-...`) and App Token (`xapp-...`) for Socket Mode
- **Notion**: Integration token and database IDs (5 databases needed)
- **Google**: OAuth credentials for Calendar & Tasks APIs
- **Anthropic**: API key for Claude categorization

### First Run
```bash
npm install
npm run brain
```
On first run with Google APIs, follow the OAuth flow to authorize.

## Common Commands

```bash
npm run brain      # Run main service (Slack bot + scheduler)
npm run daily      # Run daily digest manually
npm run weekly     # Run weekly digest manually
npm run maintenance # Run daily maintenance tasks
npm run maintenance cleanup # Run weekly orphan cleanup
npm run sync -- 1  # Sync calendar 1 day ahead
```

## Architecture

```
src/
├── index.js              # Main entry point (starts Slack bot + scheduler)
├── config.js             # Load credentials from credentials.json
├── scheduler.js          # node-cron task scheduler
├── slack/
│   ├── client.js         # Slack Bolt setup (Socket Mode)
│   └── handlers.js       # Message handlers (capture, fix, update)
├── notion/
│   ├── client.js         # Notion API client
│   └── databases.js      # CRUD operations for 5 databases
├── llm/
│   └── client.js         # LLM abstraction (LiteLLM + Anthropic fallback)
├── claude/
│   └── categorize.js     # Categorization logic and digest prompts
├── calendar/
│   ├── events.js         # Google Calendar event creation
│   ├── sync.js           # Calendar sync from Outlook/shared calendars
│   └── timeUtility.js    # Timezone conversion utilities
├── tasks/
│   └── tasks.js          # Google Tasks CRUD
└── digests/
    ├── daily.js          # Daily digest logic
    ├── weekly.js         # Weekly digest logic
    └── maintenance.js    # Cleanup and maintenance tasks
```

## Core Components

**src/slack/handlers.js** - Message handlers for:
- Capturing messages from `#secondbrain` channel
- Categorizing with Claude AI (people/projects/ideas/admin, confidence > 0.6)
- "fix:" replies for re-categorization
- "update:" replies for status changes

**src/notion/databases.js** - Manages:
- Inbox Log (audit trail of all captures)
- People, Projects, Ideas, Admin databases
- CRUD operations and field updates

**src/digests/daily.js** - Daily digest at 5am (weekdays only):
- Shows existing incomplete Google Tasks
- Generates Top 3 Actions with Claude
- Creates Google Tasks for suggestions
- Posts to Slack

**src/digests/weekly.js** - Weekly digest at 5pm Sunday:
- Analyzes completed tasks from the week
- Generates progress analysis and next week focus
- Cleans up old completed tasks (>7 days)

**src/digests/maintenance.js** - Maintenance tasks:
- **Daily**: Matches completed Google Tasks to open inbox items and auto-closes them
- **Weekly**: Orphan cleanup — archives records from People/Ideas/Projects/Admin tables that aren't referenced in Inbox Log

**src/calendar/sync.js** - Calendar sync logic:
- Fetches events from shared Google calendars
- Downloads and parses Outlook ICS feeds
- Deduplicates by title and start time
- Inserts with color coding (COLOR_ID = 8)
- Marks canceled events with "Canceled: " prefix
- Rate limited (1500ms between API calls)

**src/calendar/timeUtility.js** - Timezone utilities:
- Converts Windows to IANA timezone format
- Handles "floating" timezone events (MST offset)
- Defaults to America/Phoenix

## Scheduler

The scheduler (node-cron) manages these tasks in America/Phoenix timezone:

- **4:30 AM (every day)**: Daily maintenance (task cleanup)
- **5:00 AM (Mon-Fri)**: Daily digest generation
- **5:00 PM (Sundays)**: Weekly orphan cleanup + weekly digest generation
- **7am-3pm (weekdays, hourly)**: Calendar sync (1 day ahead)
- **4pm (Mon-Thu)**: Calendar sync (2 days ahead)
- **4pm (Fridays)**: Calendar sync (4 days ahead, covers weekend)

## Notion Database Schema

All databases have "Last Touched" date field and are linked from Inbox Log.

- **Inbox Log**: Original Text, Filed-To, Destination Name, Confidence, Status, Slack Thread TS, Created
- **People**: Name, Context, Follow-ups, Tags
- **Projects**: Name, Status (Active/Waiting/Blocked/Done), Next Action, Notes, Tags
- **Ideas**: Name, One-Liner, Notes, Tags
- **Admin**: Name, Status (Active/Done), Notes, Due Date

## Important Notes

- Token files (`token.json`, `credentials.json`) are gitignored for security
- Slack bot uses Socket Mode (xapp token) for reliable connection
- LLM client falls back to Anthropic SDK if primary provider fails
- All scheduled tasks use America/Phoenix timezone
- Confidence threshold for categorization is 0.6 (60%)
- Events synced with COLOR_ID = 8 for visual identification
- Weekly orphan cleanup ensures referential integrity: records are archived if not linked from Inbox Log