import {
  AGING_THRESHOLD_OPTIONS,
  ASSIGNED_UNTOUCHED_AGING_KEY,
  DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS,
  coerceStoredAgingThreshold,
  parseAgingThresholdHours,
  readAgingThresholdHours,
} from '../src/settings/aging-threshold';
import { SE_ASSIGNMENT_THRESHOLD_KEY } from '../src/settings/assignment-threshold';
import { SETTINGS_DEFAULTS, SETTING_VALIDATORS } from '../src/settings/settings.service';

/**
 * #295 — the dispatch board's aging dial: how long an assignment may sit untouched before the card
 * turns yellow.
 *
 * A **third** threshold, and the tests below exist mostly to keep it from being folded into either of
 * the two it resembles. `inactivity_threshold_hours` is a measurement definition that sets
 * `is_inactive` and the Fleet-Uptime denominator; `se_assignment_threshold_hours` decides when device
 * silence becomes an SE's problem. Neither one measures what this one measures — time since the work
 * became somebody's — and reusing either would have made the board's colour a restatement of a number
 * that had already stopped moving.
 */
describe('#295 — assigned_untouched_aging_hours', () => {
  it('is its own key, distinct from the two thresholds it is easily confused with', () => {
    expect(ASSIGNED_UNTOUCHED_AGING_KEY).toBe('assigned_untouched_aging_hours');
    expect(ASSIGNED_UNTOUCHED_AGING_KEY).not.toBe(SE_ASSIGNMENT_THRESHOLD_KEY);
    expect(ASSIGNED_UNTOUCHED_AGING_KEY).not.toBe('inactivity_threshold_hours');
  });

  it('is registered in the settings registry, so a fresh install has it seeded', () => {
    expect(SETTINGS_DEFAULTS[ASSIGNED_UNTOUCHED_AGING_KEY]?.value).toBe(
      DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS,
    );
    // The description is what an operator reads in the settings screen before moving it; it has to
    // name the clock, or the next person will move the wrong dial.
    expect(SETTINGS_DEFAULTS[ASSIGNED_UNTOUCHED_AGING_KEY]?.description).toMatch(/assign/i);
  });

  it('is validated on write, and reports what it would have accepted', () => {
    const validator = SETTING_VALIDATORS[ASSIGNED_UNTOUCHED_AGING_KEY];
    expect(validator).toBeDefined();
    expect(validator.allowed).toEqual(AGING_THRESHOLD_OPTIONS);
    expect(validator.validate(8)).toEqual({ ok: true, value: 8 });
    expect(validator.validate('8')).toEqual({ ok: true, value: 8 });
    expect(validator.validate(7)).toEqual({ ok: false });
  });

  describe('parseAgingThresholdHours', () => {
    it('accepts a value on the ladder, from a number or a form body’s string', () => {
      expect(parseAgingThresholdHours(4)).toEqual({ ok: true, hours: 4 });
      expect(parseAgingThresholdHours('12')).toEqual({ ok: true, hours: 12 });
    });

    it('refuses anything that is not a number, and says which', () => {
      expect(parseAgingThresholdHours('soon')).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
      expect(parseAgingThresholdHours(null)).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
      expect(parseAgingThresholdHours(Number.NaN)).toEqual({ ok: false, reason: 'NOT_A_NUMBER' });
    });

    it('refuses a number off the ladder — zero and negatives included', () => {
      expect(parseAgingThresholdHours(0)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
      expect(parseAgingThresholdHours(-4)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
      expect(parseAgingThresholdHours(3.5)).toEqual({ ok: false, reason: 'NOT_AN_ALLOWED_OPTION' });
    });
  });

  /** A row holding something the ladder no longer admits must not gate the whole board. */
  it('coerces a stored value defensively rather than propagating nonsense', () => {
    expect(coerceStoredAgingThreshold(8)).toBe(8);
    expect(coerceStoredAgingThreshold('nonsense')).toBe(DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS);
    expect(coerceStoredAgingThreshold(null)).toBe(DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS);
  });

  describe('readAgingThresholdHours', () => {
    const reader = (value: unknown) => ({
      systemSetting: { findUnique: async () => (value === undefined ? null : { value: value as never }) },
    });

    it('returns the stored value', async () => {
      await expect(readAgingThresholdHours(reader(12))).resolves.toBe(12);
    });

    it('returns the default when the key has never been written', async () => {
      await expect(readAgingThresholdHours(reader(undefined))).resolves.toBe(
        DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS,
      );
    });

    it('returns the default when the stored value is off the ladder', async () => {
      await expect(readAgingThresholdHours(reader(999))).resolves.toBe(
        DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS,
      );
    });
  });
});
