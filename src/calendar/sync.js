const { google } = require('googleapis');
const ICAL = require('ical.js');
const IcalExpander = require('ical-expander');
const { authorize } = require('./events');
const { getCalendarConfig } = require('../config');
const { fixTimeZone } = require('./timeUtility');

const fetchText = async (url, options) => {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }

  const { default: fetch } = await import('node-fetch');
  return fetch(url, options);
};

// Outlook uses Windows zone names (e.g. "India Standard Time") that ical.js doesn't know, so such events
// parse as floating. A floating UNTIL comparison then drops valid final occurrences of a series.
// Registering the feed's own VTIMEZONE definitions makes them resolve to real offsets.
const registerFeedTimezones = (ics) => {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(vtimezone);
    if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz);
  }
};

const getIcalEvents = (ics, startDateTime, endDateTime) => {
  const normalizedIcs = ics.trimStart();
  if (!normalizedIcs.startsWith('BEGIN:VCALENDAR') || !normalizedIcs.includes('END:VCALENDAR')) {
    throw new Error('ICS feed did not return a valid VCALENDAR document');
  }

  try {
    registerFeedTimezones(normalizedIcs);
    const icalExpander = new IcalExpander({ ics: normalizedIcs, maxIterations: 100 });
    return { ...icalExpander.between(startDateTime, endDateTime), ruleIndex: buildRuleIndex(icalExpander) };
  } catch (err) {
    throw new Error(`Unable to parse ICS feed: ${err.message}`);
  }
};

const downloadIcs = async (url) => {
  const response = await fetchText(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      'Accept': 'text/calendar,text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`ICS feed request failed with HTTP ${response.status}`);
  }

  return response.text();
};

const COLOR_ID = 8;

// Outlook puts the Teams join URL in the ICS DESCRIPTION (LOCATION is only the text "Microsoft Teams Meeting").
// Two URL forms exist (/l/meetup-join/ and /meet/), and either may be wrapped by Outlook Safelinks.
const URL_RE = /https?:\/\/[^\s<>"\\]+/g;
const TEAMS_JOIN_RE = /^https:\/\/teams\.microsoft\.com\/(l\/meetup-join|meet)\//i;

const unwrapSafelink = (url) => {
  try {
    const u = new URL(url);
    return /\.safelinks\.protection\.outlook\.com$/i.test(u.hostname) ? (u.searchParams.get('url') || url) : url;
  } catch {
    return url;
  }
};

const extractTeamsLink = (description) =>
  (description || '').match(URL_RE)?.map(unwrapSafelink).find(url => TEAMS_JOIN_RE.test(url));

const TEAMS_LINK_PREFIX = 'Join Microsoft Teams meeting: ';
// Outlook's Teams block runs from a "Microsoft Teams meeting" / "Microsoft Teams Need help?" heading
// (usually preceded by a divider line) through the dial-in details, organizer options and privacy footer
const TEAMS_BLOCK_RE = /(?:^(?:_{60,}|-{4,})[ \t]*\n)?^Microsoft Teams (?:meeting|Need help\?)[\s\S]*?^(?:Phone conference ID|For organizers):.*(?:\n(?:For organi[sz]ers:.*|\[[^\]\n]*\]|Privacy and security.*|_{60,})[ \t]*)*/gm;
const OUTLOOK_HEADER_RE = /^(From|When|Subject|Location):.*$/gm;
const MAX_DESCRIPTION_LENGTH = 8000; // Google Calendar caps descriptions at ~8192 characters

// The organizer's own text: the invite without the Teams join/dial-in block or Outlook header,
// with Safelinks unwrapped.
const extractDetails = (description) =>
  (description || '')
    .replace(TEAMS_BLOCK_RE, '')
    .replace(OUTLOOK_HEADER_RE, '')
    .replace(URL_RE, unwrapSafelink)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/(?:\n[-_]{4,})+$/, ''); // dividers left dangling once the Teams block is gone

const DAY_NAMES = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const ORDINALS = { '1': '1st', '2': '2nd', '3': '3rd', '4': '4th', '5': '5th', '-1': 'last' };
const UNITS = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

// "every week on Mon", "every 2 weeks on Tue, Thu", "every weekday", "every month on the 3rd Mon"
const describeRule = (rule) => {
  const { freq, interval = 1, parts } = rule;
  const days = (parts.BYDAY || []).map(d => {
    const [, ordinal, day] = String(d).match(/^([+-]?\d+)?([A-Z]{2})$/) || [];
    return { ordinal: ordinal && ORDINALS[String(parseInt(ordinal))], name: DAY_NAMES[day] };
  }).filter(d => d.name);

  if (freq === 'WEEKLY' && interval === 1 && days.length === 5 && !days.some(d => ['Sat', 'Sun'].includes(d.name))) {
    return 'every weekday';
  }
  if (!UNITS[freq]) return '';
  const base = interval === 1 ? `every ${UNITS[freq]}` : `every ${interval} ${UNITS[freq]}s`;
  if (!days.length) return base;
  if (freq === 'MONTHLY' && days[0].ordinal) return `${base} on the ${days[0].ordinal} ${days[0].name}`;
  return `${base} on ${days.map(d => d.name).join(', ')}`;
};

// Edited occurrences (RECURRENCE-ID) carry no RRULE, so the pattern comes from the series' master event
const buildRuleIndex = (expander) => {
  const index = new Map();
  for (const event of expander.events) {
    const rule = event.component.getFirstPropertyValue('rrule');
    if (rule) index.set(event.uid, describeRule(rule));
  }
  return index;
};

// "Occurs every week on Mon" from the ICS event (ical.js Event). Recurrence exceptions are edited
// occurrences of a series, so they count as recurring too.
const buildRecurrence = (item, ruleIndex) => {
  if (!item || !(item.isRecurring() || item.isRecurrenceException())) return '';
  const pattern = ruleIndex?.get(item.uid);
  return pattern ? `Occurs ${pattern}` : 'Occurs as part of a recurring series';
};

// Teams link, then recurrence line, then any additional details from the Outlook invite
const buildDescription = (description, item, ruleIndex) => {
  const link = extractTeamsLink(description);
  const details = extractDetails(description);
  const recurrence = buildRecurrence(item, ruleIndex);
  const text = [link && TEAMS_LINK_PREFIX + link, recurrence, details].filter(Boolean).join('\n\n');
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) + '…' : text;
};

// List every event in the range, following pagination (the API returns one page at a time)
const listAllEvents = async (calendar, calendarId, startDateTime, endDateTime) => {
  const items = [];
  let pageToken;

  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: startDateTime.toISOString(),
      timeMax: endDateTime.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken
    });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
};

// Two events are the same occurrence when title and start instant match. Matching on
// title alone would treat each day of a recurring meeting as a duplicate of the first.
const startTime = (event) => new Date(event.start?.dateTime || event.start?.date).getTime();
const isSameEvent = (a, b) => a.summary == b.summary && startTime(a) === startTime(b);

const getSharedCalendarEvents = async (calendar, calendarId, startDateTime, endDateTime) => {
  if (!calendarId) return [];

  const items = await listAllEvents(calendar, calendarId, startDateTime, endDateTime);

  return items.map(e => ({
    start: e.start,
    end: e.end,
    summary: e.summary,
    colorId: COLOR_ID,
  }));
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Read-only fetch of upcoming meetings (Outlook ICS + shared calendar) for the next N days.
// Unlike runCalendarSync, this does not touch the primary Google Calendar.
const getUpcomingEvents = async (days) => {
  const config = getCalendarConfig();
  if (!config) {
    console.log('No calendar config found');
    return [];
  }

  const auth = await authorize();
  const calendar = google.calendar({ version: 'v3', auth });

  const startDateTime = new Date();
  const endDateTime = new Date();
  endDateTime.setDate(endDateTime.getDate() + days);
  endDateTime.setHours(23, 59, 0, 0);

  const sharedCalEvents = await getSharedCalendarEvents(
    calendar, config.sharedCalendarId, startDateTime, endDateTime
  );

  const ics = await downloadIcs(config.icsCalendarUrl);
  const events = getIcalEvents(ics, startDateTime, endDateTime);

  const mappedEvents = events.events.map(e => ({
    start: fixTimeZone(e.startDate),
    end: fixTimeZone(e.endDate),
    summary: e.summary,
    location: e.location,
    teamsLink: extractTeamsLink(e.description),
    description: buildDescription(e.description, e, events.ruleIndex)
  }));

  const mappedOccurrences = events.occurrences.map(o => ({
    start: fixTimeZone(o.startDate),
    end: fixTimeZone(o.endDate),
    summary: o.item.summary,
    location: o.item.location,
    teamsLink: extractTeamsLink(o.item.description),
    description: buildDescription(o.item.description, o.item, events.ruleIndex)
  }));

  const allEvents = [].concat(mappedEvents, mappedOccurrences, sharedCalEvents);

  const skipEvents = config.skipEvents || [];
  const filteredEvents = allEvents.filter(event =>
    !(event.summary || '').startsWith('Canceled') &&
    !skipEvents.some(item => (event.summary || '').toLowerCase().includes(item.toLowerCase()))
  );

  const uniqueEvents = filteredEvents.filter((event, index, self) =>
    index === self.findIndex(item =>
      isSameEvent(item, event)
    )
  );

  uniqueEvents.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

  return uniqueEvents;
};

const runCalendarSync = async (syncDays) => {
  const config = getCalendarConfig();
  if (!config) {
    console.log('No calendar config found');
    return;
  }

  const auth = await authorize();
  const calendar = google.calendar({ version: 'v3', auth });

  const startDateTime = new Date();
  startDateTime.setHours(5, 0, 0, 0); // MST Offset
  const endDateTime = new Date();
  endDateTime.setDate(endDateTime.getDate() + syncDays);
  endDateTime.setHours(23, 59, 0, 0);

  // Fetch shared calendar events
  const sharedCalEvents = await getSharedCalendarEvents(
    calendar, config.sharedCalendarId, startDateTime, endDateTime
  );

  // Download and parse ICS file
  console.log('Downloading ics file...');
  const ics = await downloadIcs(config.icsCalendarUrl);
  const events = getIcalEvents(ics, startDateTime, endDateTime);

  const mappedEvents = events.events.map(e => ({
    start: fixTimeZone(e.startDate),
    end: fixTimeZone(e.endDate),
    summary: e.summary,
    location: e.location,
    teamsLink: extractTeamsLink(e.description),
    description: buildDescription(e.description, e, events.ruleIndex),
    colorId: COLOR_ID
  }));

  const mappedOccurrences = events.occurrences.map(o => ({
    start: fixTimeZone(o.startDate),
    end: fixTimeZone(o.endDate),
    summary: o.item.summary,
    location: o.item.location,
    teamsLink: extractTeamsLink(o.item.description),
    description: buildDescription(o.item.description, o.item, events.ruleIndex),
    colorId: COLOR_ID
  }));

  const allEvents = [].concat(mappedEvents, mappedOccurrences, sharedCalEvents);

  startDateTime.setHours(0, 0, 0, 0); // MST Offset
  endDateTime.setHours(7, 0, 0, 0); // MST Offset

  // Limit events to date range
  const limitEvents = allEvents.filter(event => {
    const startDate = new Date(event.start.dateTime).getTime();
    return startDate > startDateTime.getTime() && startDate < endDateTime.getTime();
  });

  // Dedupe events
  const uniqueEvents = limitEvents.filter((event, index, self) =>
    index === self.findIndex(item =>
      isSameEvent(item, event)
    )
  );

  console.log(`${uniqueEvents.length} events found...`);

  // Get existing primary calendar events
  const primaryEvents = await listAllEvents(calendar, 'primary', startDateTime, endDateTime);

  // Cancel events no longer in source
  for (const event of primaryEvents) {
    if ((event.summary || '').startsWith('Canceled')) continue;
    if (event.colorId != COLOR_ID) continue;
    if (uniqueEvents.some(uEvent => isSameEvent(uEvent, event))) continue;

    const syncEvent = {
      calendarId: 'primary',
      eventId: event.id,
      resource: {
        end: event.end,
        start: event.start,
        summary: 'Canceled: ' + event.summary,
        colorId: event.colorId,
        location: event.location || config.location
      }
    };

    try {
      await calendar.events.update(syncEvent);
      console.log('Event updated');
    } catch (err) {
      console.log('The API returned an error: ' + err, JSON.stringify(syncEvent));
    }
    await sleep(1500);
  }

  // Insert new events
  for (const event of uniqueEvents) {
    if ((config.skipEvents || []).filter(item => (event.summary || '').toLowerCase().includes(item.toLowerCase())).length) continue;
    if (primaryEvents.some(pEvent => isSameEvent(pEvent, event))) continue;
    if ((event.summary || '').startsWith('Canceled')) continue;

    const syncEvent = {
      calendarId: 'primary',
      resource: {
        end: event.end,
        start: event.start,
        summary: event.summary,
        colorId: event.colorId,
        location: event.location || config.location,
        ...(event.description && { description: event.description })
      }
    };

    try {
      await calendar.events.insert(syncEvent);
      console.log('Event created');
    } catch (err) {
      console.log('The API returned an error: ' + err, JSON.stringify(syncEvent));
    }
    await sleep(1500);
  }

  console.log('Calendar sync complete');
};

// Standalone execution
if (require.main === module) {
  const syncDays = process.argv[2] ? parseInt(process.argv[2]) : null;
  const MAX_SYNC_DAYS = 4;

  if (!syncDays || isNaN(syncDays)) {
    console.log('Usage: node src/calendar/sync.js <syncDays>');
    console.log('Example: node src/calendar/sync.js 4');
    process.exit(1);
  }

  if (syncDays > MAX_SYNC_DAYS) {
    console.log(`Maximum sync days is ${MAX_SYNC_DAYS}. Limiting to ${MAX_SYNC_DAYS} days.`);
    runCalendarSync(MAX_SYNC_DAYS).catch(err => {
      console.error('Calendar sync failed:', err);
      process.exit(1);
    });
  } else {
    runCalendarSync(syncDays).catch(err => {
      console.error('Calendar sync failed:', err);
      process.exit(1);
    });
  }
}

module.exports = { runCalendarSync, getUpcomingEvents, listAllEvents, isSameEvent, extractTeamsLink, buildDescription };
