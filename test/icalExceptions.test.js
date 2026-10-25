const test = require('node:test');
const assert = require('node:assert');
const { getIcalEvents } = require('../src/calendar/sync');

const vevent = (uid, summary, extra = '') => `BEGIN:VEVENT
UID:${uid}
SUMMARY:${summary}
DTSTART:20261019T170000Z
DTEND:20261019T173000Z
${extra}END:VEVENT
`;

// Two weekly Monday 10:00 series; only "Launch Hub" has an edited 10/26 occurrence
const ics = `BEGIN:VCALENDAR
VERSION:2.0
${vevent('catalog', 'Catalog Weekly', 'RRULE:FREQ=WEEKLY;BYDAY=MO\n')}${vevent('launch', 'Launch Hub', 'RRULE:FREQ=WEEKLY;BYDAY=MO\n')}BEGIN:VEVENT
UID:launch
RECURRENCE-ID:20261026T170000Z
SUMMARY:Launch Hub
DTSTART:20261026T170000Z
DTEND:20261026T174500Z
END:VEVENT
END:VCALENDAR`;

test('an edited occurrence of one series does not replace another series at the same time', () => {
  const { events, occurrences } = getIcalEvents(ics, new Date('2026-10-26T00:00:00Z'), new Date('2026-10-27T00:00:00Z'));
  const titles = [...events.map(e => e.summary), ...occurrences.map(o => o.item.summary)].sort();
  assert.deepStrictEqual(titles, ['Catalog Weekly', 'Launch Hub']);
});
