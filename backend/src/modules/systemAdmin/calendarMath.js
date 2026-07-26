'use strict';

/**
 * Module 12: pure working-day calendar math — no database access, so
 * it's directly unit-testable the same way loanMath/savingsMath/
 * investmentMath are. `overrides` is a `Map<'YYYY-MM-DD', boolean>` built
 * from `working_calendar` rows (see calendarService.js); absent an
 * explicit override for a date, the default is the ordinary Mon-Fri
 * banking week — an operational convention, not a BOG rule, and fully
 * overridable via data (see Decisions_Log.md).
 */

function isWeekendUtc(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6; // Sunday, Saturday
}

function addDaysUtc(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** An explicit override always wins (it can mark a weekend as working, or a weekday as a holiday); absent one, weekends default to non-working. */
function isNonWorkingDay(dateStr, overrides) {
  if (overrides && overrides.has(dateStr)) return !overrides.get(dateStr);
  return isWeekendUtc(dateStr);
}

/**
 * Advances a date FORWARD (never backward, never in place) until it
 * lands on a working day. Only ever called at schedule/next-run-date
 * GENERATION time (loanService.disburseLoan/applyRestructureOnApproval,
 * standingOrderService.executeOrder) — never as a retroactive update to
 * an existing row, which is what makes "calendar changes apply going
 * forward only" (the module prompt's own rule) true by construction
 * rather than by a special-cased check.
 */
function rollForwardToWorkingDay(dateStr, overrides) {
  let d = dateStr;
  let guard = 0;
  while (isNonWorkingDay(d, overrides)) {
    d = addDaysUtc(d, 1);
    guard += 1;
    if (guard > 3650) {
      throw new Error(`rollForwardToWorkingDay: no working day found within 10 years of ${dateStr} — check working_calendar for a misconfiguration`);
    }
  }
  return d;
}

module.exports = { isWeekendUtc, addDaysUtc, isNonWorkingDay, rollForwardToWorkingDay };
