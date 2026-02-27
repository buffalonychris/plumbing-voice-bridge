const { buildIdempotencyKey, withIdempotency } = require('../governance/withIdempotency');
const { alertCritical, ALERT_EVENT_TYPES } = require('../monitoring/alerting');

const GOOGLE_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_BUSINESS_TIMEZONE = 'America/New_York';
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 17;
const APPOINTMENT_DURATION_MINUTES = 60;
const MIN_LEAD_TIME_MINUTES = 120;
const SEARCH_WINDOW_DAYS = 21;

function getBusinessTimezone() {
  return process.env.BUSINESS_TIMEZONE || DEFAULT_BUSINESS_TIMEZONE;
}

function assertCalendarConfigured() {
  const required = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_ID'
  ];

  const missing = required.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Missing required Google Calendar environment variable(s): ${missing.join(', ')}`);
  }
}

async function getGoogleAccessToken() {
  assertCalendarConfigured();

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });

  let response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
  } catch (error) {
    await alertCritical(ALERT_EVENT_TYPES.OAUTH_REFRESH_FAILURE, {
      callSid: 'calendar-oauth-refresh',
      source: 'calendarClient.getGoogleAccessToken',
      message: error.message,
      errorCode: error.code || 'oauth_refresh_network_error'
    });
    throw error;
  }

  if (!response.ok) {
    const raw = await response.text();
    await alertCritical(ALERT_EVENT_TYPES.OAUTH_REFRESH_FAILURE, {
      callSid: 'calendar-oauth-refresh',
      source: 'calendarClient.getGoogleAccessToken',
      message: `Google OAuth token request failed (${response.status})`,
      status: response.status,
      errorCode: 'oauth_refresh_failed',
      raw
    });
    throw new Error(`Google OAuth token request failed (${response.status}): ${raw}`);
  }

  const json = await response.json();
  if (!json.access_token) {
    await alertCritical(ALERT_EVENT_TYPES.OAUTH_REFRESH_FAILURE, {
      callSid: 'calendar-oauth-refresh',
      source: 'calendarClient.getGoogleAccessToken',
      message: 'Google OAuth token response missing access_token',
      errorCode: 'oauth_refresh_missing_token',
      responseKeys: Object.keys(json || {})
    });
    throw new Error('Google OAuth token response missing access_token');
  }

  return json.access_token;
}

async function googleCalendarRequest(path, payload) {
  const accessToken = await getGoogleAccessToken();

  const response = await fetch(`${GOOGLE_API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Google Calendar API request failed (${response.status}): ${raw}`);
  }

  return response.json();
}

function getLocalParts(dateValue, timeZone) {
  const date = new Date(dateValue);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(date);
  const lookup = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    weekday: weekdayMap[lookup.weekday]
  };
}

function buildSlotLabel(startISO, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  return formatter.format(new Date(startISO));
}

function overlaps(candidateStartMs, candidateEndMs, busyBlocks) {
  return busyBlocks.some((busy) => {
    const busyStart = Date.parse(busy.start);
    const busyEnd = Date.parse(busy.end);
    return candidateStartMs < busyEnd && busyStart < candidateEndMs;
  });
}

function roundUpToNextHalfHourMs(dateMs) {
  const d = new Date(dateMs);
  d.setUTCSeconds(0, 0);
  const minutes = d.getUTCMinutes();
  const roundedMinutes = minutes === 0 ? 0 : minutes <= 30 ? 30 : 60;
  d.setUTCMinutes(roundedMinutes);
  if (roundedMinutes === 60) {
    d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
  }
  if (d.getTime() < dateMs) {
    d.setUTCMinutes(d.getUTCMinutes() + 30);
  }
  return d.getTime();
}

async function getAvailability(windowStartISO, windowEndISO) {
  assertCalendarConfigured();

  const payload = {
    timeMin: windowStartISO,
    timeMax: windowEndISO,
    items: [{ id: process.env.GOOGLE_CALENDAR_ID }]
  };

  const result = await googleCalendarRequest('/freeBusy', payload);
  const busy = result?.calendars?.[process.env.GOOGLE_CALENDAR_ID]?.busy || [];

  return busy
    .map((entry) => ({ start: entry.start, end: entry.end }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

async function proposeSlots({ count = 3, nowISO }) {
  assertCalendarConfigured();

  const requestedCount = Math.max(1, Math.min(Number(count) || 3, 5));
  const nowMs = Date.parse(nowISO || new Date().toISOString());
  const earliestMs = nowMs + MIN_LEAD_TIME_MINUTES * 60 * 1000;
  const searchStartMs = roundUpToNextHalfHourMs(earliestMs);
  const searchEndMs = searchStartMs + SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const durationMs = APPOINTMENT_DURATION_MINUTES * 60 * 1000;
  const timeZone = getBusinessTimezone();

  const busyBlocks = await getAvailability(new Date(searchStartMs).toISOString(), new Date(searchEndMs).toISOString());
  const slots = [];

  for (let cursorMs = searchStartMs; cursorMs <= searchEndMs; cursorMs += 30 * 60 * 1000) {
    if (slots.length >= requestedCount) {
      break;
    }

    const endMs = cursorMs + durationMs;
    const startLocal = getLocalParts(cursorMs, timeZone);
    const endLocal = getLocalParts(endMs, timeZone);

    const isWeekday = startLocal.weekday >= 1 && startLocal.weekday <= 5;
    const inBusinessHours = startLocal.hour >= BUSINESS_START_HOUR
      && (startLocal.hour < BUSINESS_END_HOUR)
      && (endLocal.hour < BUSINESS_END_HOUR || (endLocal.hour === BUSINESS_END_HOUR && endLocal.minute === 0));

    if (!isWeekday || !inBusinessHours) {
      continue;
    }

    if (overlaps(cursorMs, endMs, busyBlocks)) {
      continue;
    }

    const startISO = new Date(cursorMs).toISOString();
    const endISO = new Date(endMs).toISOString();

    slots.push({
      startISO,
      endISO,
      label: buildSlotLabel(startISO, timeZone)
    });
  }

  return slots;
}

function normalizeAttendees(attendees = []) {
  return attendees
    .map((attendee) => {
      if (!attendee || typeof attendee !== 'object') {
        return null;
      }

      const email = String(attendee.email || '').trim().toLowerCase();
      const phone = String(attendee.phone || '').trim();
      if (!email && !phone) {
        return null;
      }

      return {
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {})
      };
    })
    .filter(Boolean)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function createCalendarEvent({ slotStartISO, slotEndISO, summary, description, attendees = [] }) {
  assertCalendarConfigured();

  const payload = {
    summary,
    description,
    start: {
      dateTime: slotStartISO,
      timeZone: getBusinessTimezone()
    },
    end: {
      dateTime: slotEndISO,
      timeZone: getBusinessTimezone()
    },
    attendees: attendees
      .filter((attendee) => attendee.email)
      .map((attendee) => ({ email: attendee.email }))
  };

  const response = await googleCalendarRequest(`/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`, payload);

  return {
    calendarEventId: response.id,
    htmlLink: response.htmlLink || null,
    startISO: response?.start?.dateTime || slotStartISO,
    endISO: response?.end?.dateTime || slotEndISO
  };
}

async function bookSlot({ slotStartISO, slotEndISO, summary, description, attendees, callSid }) {
  const normalizedAttendees = normalizeAttendees(attendees);

  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'calendar_book_event',
    inputs: {
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      slotStartISO,
      slotEndISO,
      summary,
      attendeePhonesOrEmails: normalizedAttendees
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'calendar_book_event' },
    fn: async () => createCalendarEvent({
      slotStartISO,
      slotEndISO,
      summary,
      description,
      attendees: normalizedAttendees
    })
  });
}

module.exports = {
  assertCalendarConfigured,
  getAvailability,
  proposeSlots,
  bookSlot,
  APPOINTMENT_DURATION_MINUTES,
  MIN_LEAD_TIME_MINUTES,
  BUSINESS_START_HOUR,
  BUSINESS_END_HOUR
};
