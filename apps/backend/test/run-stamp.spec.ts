import { describe, expect, it } from 'vitest';
import { buildStampFields } from '../src/build-info/run-stamp';
import { getBuildInfo } from '../src/build-info/build-info';

describe('buildStampFields', () => {
  it('carries the build-info version (as bigint) and fingerprint', () => {
    const info = getBuildInfo();
    expect(buildStampFields()).toEqual({
      buildVersion: BigInt(info.version),
      buildFingerprint: info.fingerprint,
    });
  });
});
