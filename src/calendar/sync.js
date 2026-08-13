const { google } = require('googleapis');
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

const getIcalEvents = (ics, startDateTime, endDateTime) => {
  const normalizedIcs = ics.trimStart();
  if (!normalizedIcs.startsWith('BEGIN:VCALENDAR') || !normalizedIcs.includes('END:VCALENDAR')) {
    throw new Error('ICS feed did not return a valid VCALENDAR document');
  }

  try {
    const icalExpander = new IcalExpander({ ics: normalizedIcs, maxIterations: 100 });
    return icalExpander.between(startDateTime, endDateTime);
  } catch (err) {
    throw new Error(`Unable to parse ICS feed: ${err.message}`);
  }
};

const downloadIcs = async (url) => {
  const response = await fetchText(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept': 'text/calendar,text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`ICS feed request failed with HTTP ${response.status}`);
  }

  return response.text();
};

const COLOR_ID = 8;

const getSharedCalendarEvents = async (calendar, calendarId, startDateTime, endDateTime) => {
  if (!calendarId) return [];

  const res = await calendar.events.list({
    calendarId,
    timeMin: startDateTime.toISOString(),
    timeMax: endDateTime.toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items.map(e => ({
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
    location: e.location
  }));

  const mappedOccurrences = events.occurrences.map(o => ({
    start: fixTimeZone(o.startDate),
    end: fixTimeZone(o.endDate),
    summary: o.item.summary,
    location: o.item.location
  }));

  const allEvents = [].concat(mappedEvents, mappedOccurrences, sharedCalEvents);

  const skipEvents = config.skipEvents || [];
  const filteredEvents = allEvents.filter(event =>
    !event.summary.startsWith('Canceled') &&
    !skipEvents.some(item => event.summary.toLowerCase().includes(item.toLowerCase()))
  );

  const uniqueEvents = filteredEvents.filter((event, index, self) =>
    index === self.findIndex(item =>
      item.summary == event.summary && item.start.dateTime == event.start.dateTime
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
    colorId: COLOR_ID
  }));

  const mappedOccurrences = events.occurrences.map(o => ({
    start: fixTimeZone(o.startDate),
    end: fixTimeZone(o.endDate),
    summary: o.item.summary,
    location: o.item.location,
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
      item.summary == event.summary && item.start.dateTime == event.start.dateTime
    )
  );

  console.log(`${uniqueEvents.length} events found...`);

  // Get existing primary calendar events
  const primaryRes = await calendar.events.list({
    calendarId: 'primary',
    timeMin: startDateTime.toISOString(),
    timeMax: endDateTime.toISOString(),
    maxResults: 30,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const primaryEvents = primaryRes.data.items;

  // Cancel events no longer in source
  for (const event of primaryEvents) {
    if (event.summary.startsWith('Canceled')) continue;
    if (event.colorId != COLOR_ID) continue;
    if (uniqueEvents.filter(uEvent => uEvent.summary == event.summary).length) continue;

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
    if (config.skipEvents.filter(item => event.summary.toLowerCase().includes(item.toLowerCase())).length) continue;
    if (primaryEvents.filter(pEvent => pEvent.summary == event.summary).length) continue;
    if (event.summary.startsWith('Canceled')) continue;

    const syncEvent = {
      calendarId: 'primary',
      resource: {
        end: event.end,
        start: event.start,
        summary: event.summary,
        colorId: event.colorId,
        location: event.location || config.location
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

module.exports = { runCalendarSync, getUpcomingEvents };
