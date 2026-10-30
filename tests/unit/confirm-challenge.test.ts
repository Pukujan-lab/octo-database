import { describe, expect, it } from 'vitest';
import {
  acceptConfirmChallenge,
  hasConfirmChallenge,
  inConfirmWindow,
  issueConfirmChallenge,
  openConfirmWindow,
} from '../../src/auth/confirm-challenge';

describe('confirm challenge', () => {
  it('accepts the issued code once, ignoring case and surrounding space', () => {
    const principalId = `person-${Date.now()}-ok`;
    const issued = issueConfirmChallenge(principalId, 1_000);
    expect(hasConfirmChallenge(principalId, 1_000)).toBe(true);
    expect(acceptConfirmChallenge(principalId, `  ${issued.code.toLowerCase()}  `, 1_000)).toBe(true);
    expect(acceptConfirmChallenge(principalId, issued.code, 1_000)).toBe(false);
    expect(hasConfirmChallenge(principalId, 1_000)).toBe(false);
  });

  it('rejects a mistype and an expired code', () => {
    const principalId = `person-${Date.now()}-no`;
    const issued = issueConfirmChallenge(principalId, 5_000);
    expect(acceptConfirmChallenge(principalId, 'WRONG1', 5_000)).toBe(false);
    expect(hasConfirmChallenge(principalId, 5_000)).toBe(true);
    expect(acceptConfirmChallenge(principalId, issued.code, 5_000 + 10 * 60 * 1000)).toBe(false);
  });

  it('keeps a confirmation window open for two minutes, per person', () => {
    const principalId = `person-${Date.now()}-window`;
    expect(inConfirmWindow(principalId, 1_000)).toBe(false);
    openConfirmWindow(principalId, 1_000);
    expect(inConfirmWindow(principalId, 1_000 + 119_000)).toBe(true);
    expect(inConfirmWindow(`${principalId}-other`, 1_000)).toBe(false);
    expect(inConfirmWindow(principalId, 1_000 + 120_000)).toBe(false);
  });
});
