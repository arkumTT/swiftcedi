'use strict';

const { createHash } = require('crypto');

/**
 * STUB credit bureau client (Module 2). There is no live bureau contract
 * yet — per the module spec, this is "stubbed as an interface" so
 * customerService.js has something real to call and store a response
 * against. Replace `lookup()`'s body with a real HTTP call to whichever
 * bureau SwiftCedi contracts with; keep the function signature the same
 * so customerService.js doesn't need to change. DO NOT treat this stub's
 * output as a real credit signal — it is a deterministic, clearly-labeled
 * fake derived from the input, not a lookup against any real bureau.
 */
function lookup({ ghanaCardNo, businessRegistrationNo, fullName }) {
  const seed = ghanaCardNo || businessRegistrationNo || fullName || '';
  const digest = createHash('sha256').update(seed).digest();
  // Deterministic pseudo-score in a plausible 300-850 range, purely so the
  // stub returns *something* shaped like a bureau response.
  const score = 300 + (digest.readUInt16BE(0) % 551);
  const riskBand = score >= 700 ? 'low' : score >= 550 ? 'medium' : 'high';

  return {
    stub: true,
    provider: 'none (stub — no live bureau contract configured)',
    score,
    riskBand,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { lookup };
