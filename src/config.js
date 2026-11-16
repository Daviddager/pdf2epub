// Shared configuration loader: defaults.json merged with an optional profile.
// The profile only overrides/adds keys; anything the profile sets wins.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = path.join(__dirname, '..', 'profiles', 'defaults.json');

function deepMerge(base, extra) {
  if (Array.isArray(extra)) return extra.slice();
  if (extra && typeof extra === 'object') {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const k of Object.keys(extra)) out[k] = deepMerge(out[k], extra[k]);
    return out;
  }
  return extra === undefined ? base : extra;
}

function loadConfig(profilePath) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS, 'utf8'));
  if (!profilePath) return defaults;
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const merged = deepMerge(defaults, profile);
  // remember which profile file supplied book rules (for provenance)
  merged.profileFile = profilePath ? path.resolve(profilePath) : null;
  return merged;
}

module.exports = { loadConfig, deepMerge };
