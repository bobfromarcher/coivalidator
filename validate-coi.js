/**
 * Parse a Certificate of Insurance text and validate it against requirements.
 * Returns an object matching the API response shape.
 */
export function validateCOI(text, requirements = {}) {
  const policies = parsePolicies(text);
  const additionalInsured = policies.some(p => p.additional_insured === true);
  const waiverOfSubrogation = policies.some(p => p.waiver_of_subrogation === true);
  const cancellation30Day = has30DayCancellation(text);

  const glPolicy = policies.find(p => p.type === 'GL');
  const wcPolicy = policies.find(p => p.type === 'WC');
  const autoPolicy = policies.find(p => p.type === 'Auto');

  const reqsMet = {
    gl_per_occurrence: glPolicy ? (glPolicy.limits?.per_occurrence ?? 0) >= (requirements.gl_per_occurrence ?? 0) : false,
    gl_aggregate: glPolicy ? (glPolicy.limits?.aggregate ?? 0) >= (requirements.gl_aggregate ?? 0) : false,
    wc_statutory: wcPolicy ? wcPolicy.limits?.statutory === true : false,
    auto_combined: autoPolicy ? (autoPolicy.limits?.combined ?? 0) >= (requirements.auto_combined ?? 0) : false,
    additional_insured: additionalInsured,
    waiver_of_subrogation: waiverOfSubrogation,
    '30_day_cancellation': cancellation30Day,
  };

  const totalReqs = Object.keys(reqsMet).length;
  const metCount = Object.values(reqsMet).filter(Boolean).length;
  const score = totalReqs > 0 ? Math.round((metCount / totalReqs) * 100) : 0;

  const gaps = [];
  if (!reqsMet.gl_per_occurrence) gaps.push(`GL per-occurrence below $${(requirements.gl_per_occurrence ?? 0).toLocaleString()} (found $${glPolicy?.limits?.per_occurrence?.toLocaleString() ?? '0'})`);
  if (!reqsMet.gl_aggregate) gaps.push(`GL aggregate below $${(requirements.gl_aggregate ?? 0).toLocaleString()} (found $${glPolicy?.limits?.aggregate?.toLocaleString() ?? '0'})`);
  if (!reqsMet.wc_statutory) gaps.push('Workers Compensation statutory coverage not found');
  if (!reqsMet.auto_combined) gaps.push(`Auto combined single limit below $${(requirements.auto_combined ?? 0).toLocaleString()} (found $${autoPolicy?.limits?.combined?.toLocaleString() ?? '0'})`);
  if (!reqsMet.additional_insured) gaps.push('Additional insured not listed');
  if (!reqsMet.waiver_of_subrogation) gaps.push('No waiver of subrogation');
  if (!reqsMet['30_day_cancellation']) gaps.push('30-day cancellation notice not found');

  const now = new Date();
  let expiresInDays = null;
  for (const p of policies) {
    if (p.expiration) {
      const exp = new Date(p.expiration);
      const diff = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
      if (expiresInDays === null || diff < expiresInDays) {
        expiresInDays = diff;
      }
    }
  }

  return {
    validation: {
      score,
      gaps,
      requirements_met: reqsMet,
      policies,
      additional_insured: additionalInsured,
      waiver_of_subrogation: waiverOfSubrogation,
      expires_in_days: expiresInDays,
    },
    analysis: {
      overall_score: score,
      summary: gaps.length ? `Found ${gaps.length} compliance gap(s).` : 'All requirements met.',
    },
    usage: { used: 0, limit: 0 },
  };
}

function parsePolicies(text) {
  const policies = [];
  const lines = text.split('\n');
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const coverageMatch = line.match(/^(\d+)\.\s+(.+?)\s*-\s*Policy:\s*(.+)/i);
    if (coverageMatch) {
      if (current) policies.push(current);
      const typeStr = coverageMatch[2].toUpperCase();
      let type = 'Other';
      if (typeStr.includes('GENERAL LIABILITY')) type = 'GL';
      else if (typeStr.includes('WORKERS COMPENSATION')) type = 'WC';
      else if (typeStr.includes('AUTOMOBILE LIABILITY')) type = 'Auto';
      else if (typeStr.includes('UMBRELLA') || typeStr.includes('EXCESS')) type = 'Umbrella';

      current = {
        type,
        policy_number: coverageMatch[3].trim(),
        effective: null,
        expiration: null,
        limits: {},
        additional_insured: null,
        waiver_of_subrogation: null,
      };
      continue;
    }

    if (!current) {
      // umbrella not included line
      const umbrellaMatch = line.match(/UMBRELLA\/EXCESS LIABILITY:\s*(.+)/i);
      if (umbrellaMatch) {
        const status = umbrellaMatch[1].trim().toUpperCase();
        if (status.includes('NOT INCLUDED')) {
          policies.push({ type: 'Umbrella', policy_number: null, effective: null, expiration: null, limits: {}, additional_insured: null, waiver_of_subrogation: null });
        }
      }
      continue;
    }

    const effMatch = line.match(/Effective:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (effMatch) {
      current.effective = effMatch[1];
    }

    const expMatch = line.match(/Expiration:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (expMatch) {
      current.expiration = expMatch[1];
    }

    const limitsMatch = line.match(/Limits:\s*(.+)/i);
    if (limitsMatch) {
      current.limits = parseLimits(limitsMatch[1]);
    }

    const aiMatch = line.match(/ADDITIONAL INSURED:\s*(.+)/i);
    if (aiMatch) {
      const val = aiMatch[1].trim().toUpperCase();
      current.additional_insured = val.includes('YES') || val.includes('LISTED') || val.includes('INCLUDED');
    }

    const wosMatch = line.match(/WAIVER OF SUBROGATION:\s*(.+)/i);
    if (wosMatch) {
      const val = wosMatch[1].trim().toUpperCase();
      current.waiver_of_subrogation = val.includes('YES') || val.includes('INCLUDED');
    }
  }

  if (current) policies.push(current);
  return policies;
}

function parseLimits(limitStr) {
  const result = {};

  const perOccurrenceMatch = limitStr.match(/\$([\d,]+)\s*Each\s*Occurrence/i);
  if (perOccurrenceMatch) {
    result.per_occurrence = parseInt(perOccurrenceMatch[1].replace(/,/g, ''), 10);
  }

  const aggregateMatch = limitStr.match(/\$([\d,]+)\s*(General\s*)?Aggregate/i);
  if (aggregateMatch) {
    result.aggregate = parseInt(aggregateMatch[1].replace(/,/g, ''), 10);
  }

  const combinedMatch = limitStr.match(/\$([\d,]+)\s*Combined\s*Single\s*Limit/i);
  if (combinedMatch) {
    result.combined = parseInt(combinedMatch[1].replace(/,/g, ''), 10);
  }

  const employerMatch = limitStr.match(/\$([\d,]+)\s*Employer'?s?\s*Liability/i);
  if (employerMatch) {
    result.employer = parseInt(employerMatch[1].replace(/,/g, ''), 10);
  }

  if (/statutory/i.test(limitStr)) {
    result.statutory = true;
  }

  return result;
}

function has30DayCancellation(text) {
  return /30[\s-]*day/i.test(text) || /30[\s-]*days/i.test(text);
}
