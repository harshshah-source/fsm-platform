import { describe, expect, it } from '@jest/globals';
import { formatSlaBucketLabel, slaBucketToStatus, workStateLabel } from './ticketDisplay';

describe('slaBucketToStatus', () => {
  it('maps the four lower bands (WARNING/EARLY_RISK/RISK) to warning', () => {
    expect(slaBucketToStatus('WARNING')).toBe('warning');
    expect(slaBucketToStatus('EARLY_RISK')).toBe('warning');
    expect(slaBucketToStatus('RISK')).toBe('warning');
  });

  it('maps the four higher bands (CRITICAL and up) to critical', () => {
    expect(slaBucketToStatus('CRITICAL')).toBe('critical');
    expect(slaBucketToStatus('HIGH_CRITICAL')).toBe('critical');
    expect(slaBucketToStatus('SEVERE')).toBe('critical');
    expect(slaBucketToStatus('VERY_SEVERE')).toBe('critical');
    expect(slaBucketToStatus('LONG_PENDING')).toBe('critical');
  });

  it('maps null (the 0-4h ACTIVE band, which is never queued) to neutral', () => {
    expect(slaBucketToStatus(null)).toBe('neutral');
  });

  it('maps an unrecognized value to neutral rather than throwing', () => {
    expect(slaBucketToStatus('SOMETHING_NEW')).toBe('neutral');
  });
});

describe('formatSlaBucketLabel', () => {
  it('title-cases a SCREAMING_SNAKE_CASE bucket', () => {
    expect(formatSlaBucketLabel('HIGH_CRITICAL')).toBe('High Critical');
    expect(formatSlaBucketLabel('WARNING')).toBe('Warning');
  });

  it('renders null as a neutral label, not "null"', () => {
    expect(formatSlaBucketLabel(null)).toBe('Active');
  });
});

describe('workStateLabel', () => {
  it('maps each of the four contract values to its display label', () => {
    expect(workStateLabel('VISIT_NOW')).toBe('Visit Now');
    expect(workStateLabel('PLAN')).toBe('Plan');
    expect(workStateLabel('IN_WORK')).toBe('In Work');
    expect(workStateLabel('VERIFY')).toBe('Verify');
  });
});
