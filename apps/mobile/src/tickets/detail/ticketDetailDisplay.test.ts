import { describe, expect, it } from '@jest/globals';
import { formatInactiveDuration } from './ticketDetailDisplay';

describe('formatInactiveDuration', () => {
  const now = new Date('2026-05-11T16:15:00Z');

  it('returns null when there is no timestamp', () => {
    expect(formatInactiveDuration(null, now)).toBeNull();
  });

  it('formats minutes only under an hour', () => {
    expect(formatInactiveDuration('2026-05-11T16:05:00Z', now)).toBe('10m');
  });

  it('formats hours + minutes under a day', () => {
    expect(formatInactiveDuration('2026-05-11T10:45:00Z', now)).toBe('5h 30m');
  });

  it('formats whole hours with no remainder minutes', () => {
    expect(formatInactiveDuration('2026-05-10T20:15:00Z', now)).toBe('20h');
  });

  it('formats days + hours at a day or more', () => {
    expect(formatInactiveDuration('2026-05-08T10:15:00Z', now)).toBe('3d 6h');
  });
});
