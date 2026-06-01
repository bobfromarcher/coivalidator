import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCOI } from '../validate-coi.js';

const requirements = {
  gl_per_occurrence: 1000000,
  gl_aggregate: 2000000,
  wc_statutory: true,
  auto_combined: 500000,
  additional_insured: true,
  waiver_of_subrogation: true,
  '30_day_cancellation': true,
};

describe('validateCOI', () => {
  it('returns full score for a fully compliant COI', () => {
    const text = `
CERTIFICATE OF INSURANCE
PRODUCER: ABC Insurance Brokers, Inc.
INSURED: Apex Contracting Services LLC

COVERAGES:
1. GENERAL LIABILITY - Policy: GL-2024-88432
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: $1,000,000 Each Occurrence / $2,000,000 General Aggregate
   ADDITIONAL INSURED: YES

2. WORKERS COMPENSATION - Policy: WC-2024-22987
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: Statutory / $500,000 Employer's Liability
   WAIVER OF SUBROGATION: INCLUDED

3. AUTOMOBILE LIABILITY - Policy: AL-2024-55412
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: $500,000 Combined Single Limit

NOTICE OF CANCELLATION: 30 DAYS written notice
`;
    const result = validateCOI(text, requirements);
    assert.equal(result.validation.score, 100);
    assert.deepEqual(result.validation.gaps, []);
    assert.equal(result.validation.additional_insured, true);
    assert.equal(result.validation.waiver_of_subrogation, true);
    assert.equal(result.validation.requirements_met['30_day_cancellation'], true);
  });

  it('detects missing additional insured and low GL aggregate', () => {
    const text = `
CERTIFICATE OF INSURANCE
PRODUCER: ABC Insurance Brokers, Inc.
INSURED: Apex Contracting Services LLC

COVERAGES:
1. GENERAL LIABILITY - Policy: GL-2024-88432
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: $500,000 Each Occurrence / $1,000,000 General Aggregate
   ADDITIONAL INSURED: NOT LISTED

2. WORKERS COMPENSATION - Policy: WC-2024-22987
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: Statutory / $500,000 Employer's Liability
   WAIVER OF SUBROGATION: NOT INCLUDED

3. AUTOMOBILE LIABILITY - Policy: AL-2024-55412
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: $250,000 Combined Single Limit

NOTICE OF CANCELLATION: 30 DAYS written notice
`;
    const result = validateCOI(text, requirements);
    assert.ok(result.validation.score < 100);
    const gaps = result.validation.gaps;
    assert.ok(gaps.some(g => g.includes('Additional insured')));
    assert.ok(gaps.some(g => g.includes('GL aggregate')));
    assert.ok(gaps.some(g => g.includes('Auto combined')));
    assert.ok(gaps.some(g => g.includes('waiver of subrogation')));
    assert.equal(result.validation.requirements_met['30_day_cancellation'], true);
  });

  it('handles empty text gracefully', () => {
    const result = validateCOI('', requirements);
    assert.equal(result.validation.score, 0);
    assert.ok(result.validation.gaps.length > 0);
    assert.equal(result.validation.policies.length, 0);
  });

  it('extracts policies correctly', () => {
    const text = `
CERTIFICATE OF INSURANCE
PRODUCER: ABC Insurance Brokers, Inc.
INSURED: Apex Contracting Services LLC

COVERAGES:
1. GENERAL LIABILITY - Policy: GL-2024-88432
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: $1,000,000 Each Occurrence / $2,000,000 General Aggregate
   ADDITIONAL INSURED: YES

2. WORKERS COMPENSATION - Policy: WC-2024-22987
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: Statutory / $500,000 Employer's Liability
   WAIVER OF SUBROGATION: INCLUDED

3. AUTOMOBILE LIABILITY - Policy: AL-2024-55412
   Effective: 01/15/2025  Expiration: 01/15/2026
   Limits: $500,000 Combined Single Limit

NOTICE OF CANCELLATION: 30 DAYS written notice
`;
    const result = validateCOI(text, requirements);
    const policies = result.validation.policies;
    assert.equal(policies.length, 3);
    assert.equal(policies[0].type, 'GL');
    assert.equal(policies[0].policy_number, 'GL-2024-88432');
    assert.equal(policies[0].limits.per_occurrence, 1000000);
    assert.equal(policies[0].limits.aggregate, 2000000);
    assert.equal(policies[0].additional_insured, true);
    assert.equal(policies[1].type, 'WC');
    assert.equal(policies[1].limits.statutory, true);
    assert.equal(policies[1].waiver_of_subrogation, true);
    assert.equal(policies[2].type, 'Auto');
    assert.equal(policies[2].limits.combined, 500000);
  });
});
