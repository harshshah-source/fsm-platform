import { describe, expect, it } from '@jest/globals';
import { formatCategoryLabel, voucherStatusLabel, voucherStatusSemantic } from './voucherDisplay';

describe('formatCategoryLabel', () => {
  it('title-cases a category', () => {
    expect(formatCategoryLabel('ACCOMMODATION')).toBe('Accommodation');
    expect(formatCategoryLabel('TRAVEL')).toBe('Travel');
  });
});

describe('voucherStatusLabel / voucherStatusSemantic', () => {
  it('renders all 7 statuses with a label and a semantic status', () => {
    const statuses = ['DRAFT', 'SUBMITTED', 'ZONAL_MANAGER_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_CLARIFICATION', 'PAID'] as const;
    for (const status of statuses) {
      expect(voucherStatusLabel(status)).toEqual(expect.any(String));
      expect(voucherStatusSemantic(status)).toEqual(expect.any(String));
    }
    expect(voucherStatusLabel('ZONAL_MANAGER_REVIEW')).toBe('Manager Review');
    expect(voucherStatusSemantic('APPROVED')).toBe('success');
    expect(voucherStatusSemantic('REJECTED')).toBe('critical');
  });
});
