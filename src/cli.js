#!/usr/bin/env node
'use strict';

const { getAgenda, createCalendarEvent } = require('./calendar/events');
const { listTasks, completeTask } = require('./tasks/tasks');
const { runCalendarSync } = require('./calendar/sync');

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Phoenix is always UTC-7 (no DST)
function toPhoenixDate(isoString) {
  const d = new Date(new Date(isoString).getTime() - 7 * 60 * 60 * 1000);
  return d;
}

function formatPhoenixTime(isoString) {
  const d = toPhoenixDate(isoString);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatPhoenixDate(isoString) {
  const d = toPhoenixDate(isoString);
  return `${DAYS_OF_WEEK[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Parse "YYYY-MM-DD HH:MM" as Phoenix time (UTC-7)
function parsePhoenixTime(str) {
  const parts = str.trim().split(' ');
  if (parts.length !== 2) throw new Error(`Invalid time format "${str}" — use "YYYY-MM-DD HH:MM"`);
  return new Date(`${parts[0]}T${parts[1]}:00-07:00`);
}

function die(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

async function cmdAgenda(args) {
  let days = 1;
  const daysIdx = args.indexOf('--days');
  if (daysIdx !== -1) {
    days = parseInt(args[daysIdx + 1], 10);
    if (isNaN(days) || days < 1) die('--days must be a positive integer');
  }

  const events = await getAgenda(days);

  const label = days === 1
    ? `Agenda - ${formatPhoenixDate(new Date().toISOString())}`
    : `Agenda - Next ${days} Days`;

  console.log(`# ${label}\n`);

  if (events.length === 0) {
    console.log('No events.');
    return;
  }

  for (const ev of events) {
    if (ev.start.date) {
      console.log(`- All day | ${ev.summary}`);
    } else {
      const start = formatPhoenixTime(ev.start.dateTime);
      const end = formatPhoenixTime(ev.end.dateTime);
      console.log(`- ${start}–${end} | ${ev.summary}`);
    }
  }
}

async function cmdAddEvent(args) {
  const [title, startStr, endStr, description] = args;
  if (!title || !startStr || !endStr) {
    die('Usage: add-event <title> <"YYYY-MM-DD HH:MM"> <"YYYY-MM-DD HH:MM"> [description]');
  }

  const startTime = parsePhoenixTime(startStr);
  const endTime = parsePhoenixTime(endStr);

  await createCalendarEvent({ summary: title, description: description || '', startTime, endTime });

  const startDate = `${startStr.split(' ')[0]} ${formatPhoenixTime(startTime.toISOString())}`;
  const endDisplay = formatPhoenixTime(endTime.toISOString());

  console.log(`# Event Created\n`);
  console.log(`**${title}**`);
  console.log(`${startDate}–${endDisplay}`);
}

async function cmdTasks() {
  const tasks = await listTasks();

  console.log('# Open Tasks\n');

  if (tasks.length === 0) {
    console.log('No open tasks.');
    return;
  }

  for (const t of tasks) {
    console.log(`- [ ] ${t.title} \`${t.id}\``);
  }
}

async function cmdComplete(args) {
  const taskId = args[0];
  if (!taskId) die('Usage: complete <taskId>');

  const task = await completeTask(taskId);

  console.log('# Task Completed\n');
  console.log(`- [x] ${task.title}`);
}

async function cmdSync(args) {
  const days = args[0] ? parseInt(args[0], 10) : 1;
  if (isNaN(days) || days < 1) die('sync days must be a positive integer');

  console.log(`# Calendar Sync\n`);
  console.log(`Syncing ${days} day(s) ahead...`);
  await runCalendarSync(days);
  console.log('Done.');
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  try {
    switch (cmd) {
      case 'agenda':     await cmdAgenda(args); break;
      case 'add-event':  await cmdAddEvent(args); break;
      case 'tasks':      await cmdTasks(); break;
      case 'complete':   await cmdComplete(args); break;
      case 'sync':       await cmdSync(args); break;
      default:
        process.stderr.write([
          'Usage: npm run cli -- <command> [args]',
          '',
          'Commands:',
          '  agenda [--days N]                             Show calendar agenda (default: today)',
          '  add-event <title> <start> <end> [desc]        Create event; times as "YYYY-MM-DD HH:MM"',
          '  tasks                                         List open tasks',
          '  complete <taskId>                             Mark task as complete',
          '  sync [N]                                      Sync calendar N days ahead (default: 1)',
          ''
        ].join('\n'));
        process.exit(1);
    }
  } catch (err) {
    die(err.message || String(err));
  }
}

main();
