/**
 * @fileoverview Detects Claude's own session-limit error message (e.g.
 * "You've hit your session limit · resets 7:20pm (Australia/Darwin)") in a
 * turn's error text and resolves the reset time it names to a concrete
 * instant, for chat.autoContinue (see runAgentsParallel's catch block in
 * ws/handler.js). No date library in this project — the zoned-time math
 * below is the standard Intl.DateTimeFormat round-trip trick: format a UTC
 * guess in the target IANA zone, measure how far off it reads, and correct
 * by the difference (twice, since the offset itself can change right at a
 * DST boundary the guess lands near).
 */

/**
 * Matches "resets <h>[:mm]<am|pm> (<IANA timezone>)" anywhere in the
 * message — deliberately not anchored to the exact "You've hit your session
 * limit" wording in front of it, since that prefix isn't this app's own
 * string (it comes straight from the `claude` CLI's own error text) and
 * isn't worth coupling to verbatim.
 */
const RESET_PATTERN = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i;

/**
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number }} the calendar date
 *   `instant` falls on when viewed in `timeZone`.
 */
function zonedDateParts(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {number} `timeZone`'s offset from UTC, in ms, as observed at `instant`.
 */
function zoneOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  // hourCycle 'h23' can still render midnight as "24" in some ICU builds.
  const hour = Number(parts.hour) % 24;
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return asUTC - instant.getTime();
}

/**
 * Converts a wall-clock date+time as observed in `timeZone` to the UTC
 * instant it corresponds to.
 * @param {number} year
 * @param {number} month - 1-indexed
 * @param {number} day
 * @param {number} hour - 0-23
 * @param {number} minute
 * @param {string} timeZone
 * @returns {Date}
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-measure at the corrected instant in case it crossed a DST boundary
  // the first guess hadn't — one refinement is enough given offsets only
  // ever change by whole hours (or half/quarter-hours), far more than a
  // second pass could miss.
  instant = guess - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * Finds a Claude session-limit reset time in `message` and resolves it to
 * the next matching instant after `now` (today's occurrence of that
 * wall-clock time in the named zone, or tomorrow's if today's has already
 * passed).
 * @param {string} message
 * @param {Date} [now]
 * @returns {Date | null} null if the message doesn't mention a reset time,
 *   or names a timezone Intl doesn't recognize.
 */
export function parseSessionLimitReset(message, now = new Date()) {
  const match = RESET_PATTERN.exec(message);
  if (!match) return null;
  const [, hourStr, minuteStr, meridiem, timeZone] = match;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    return null;
  }

  let hour = Number(hourStr) % 12;
  if (meridiem.toLowerCase() === 'pm') hour += 12;
  const minute = minuteStr ? Number(minuteStr) : 0;

  const today = zonedDateParts(now, timeZone);
  let reset = zonedWallTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (reset.getTime() <= now.getTime()) {
    const tomorrow = zonedDateParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
    reset = zonedWallTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timeZone);
  }
  return reset;
}
