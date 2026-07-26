'use strict';

const calendarMath = require('../../src/modules/systemAdmin/calendarMath');

describe('calendarMath', () => {
  describe('isWeekendUtc', () => {
    test('flags Saturday and Sunday, not weekdays', () => {
      expect(calendarMath.isWeekendUtc('2026-02-01')).toBe(true); // Sunday
      expect(calendarMath.isWeekendUtc('2026-01-31')).toBe(true); // Saturday
      expect(calendarMath.isWeekendUtc('2026-02-02')).toBe(false); // Monday
    });
  });

  describe('isNonWorkingDay', () => {
    test('defaults to the ordinary Mon-Fri week absent any override', () => {
      expect(calendarMath.isNonWorkingDay('2026-02-01', new Map())).toBe(true); // Sunday
      expect(calendarMath.isNonWorkingDay('2026-02-02', new Map())).toBe(false); // Monday
    });

    test('an explicit override always wins, in either direction', () => {
      const overrides = new Map([
        ['2026-02-02', false], // a Monday declared a public holiday
        ['2026-02-07', true], // a Saturday declared a special working day
      ]);
      expect(calendarMath.isNonWorkingDay('2026-02-02', overrides)).toBe(true);
      expect(calendarMath.isNonWorkingDay('2026-02-07', overrides)).toBe(false);
    });
  });

  describe('rollForwardToWorkingDay', () => {
    test('leaves an already-working date untouched', () => {
      expect(calendarMath.rollForwardToWorkingDay('2026-02-02', new Map())).toBe('2026-02-02');
    });

    test('advances a Sunday to the following Monday absent any override', () => {
      expect(calendarMath.rollForwardToWorkingDay('2026-02-01', new Map())).toBe('2026-02-02');
    });

    test('skips a run of consecutive non-working days (weekend + a Monday holiday)', () => {
      const overrides = new Map([['2026-02-02', false]]);
      // Sat 01-31, Sun 02-01, Mon 02-02 (holiday) all skipped -> Tue 02-03.
      expect(calendarMath.rollForwardToWorkingDay('2026-01-31', overrides)).toBe('2026-02-03');
    });

    test('an override marking a weekend as working stops the roll immediately', () => {
      const overrides = new Map([['2026-02-01', true]]);
      expect(calendarMath.rollForwardToWorkingDay('2026-02-01', overrides)).toBe('2026-02-01');
    });
  });
});
