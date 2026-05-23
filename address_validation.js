"use strict";

const STATE_ABBREVIATIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
  "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
]);

const STATE_NAME_TO_ABBREVIATION = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY"
};

const STATE_NAMES_LONGEST = Object.keys(STATE_NAME_TO_ABBREVIATION).sort((a, b) => b.length - a.length);

const STREET_TYPE_RE = /\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|circle|cir|way|highway|hwy|parkway|pkwy|route|place|pl|terrace|ter|trail|trl|loop)\b/i;
const PO_BOX_RE = /\b(?:p\.?\s*o\.?\s*box|po\s*box|pobox)\s+\d+/i;

function cleanSpeechText(input) {
  if (!input) return "";
  return String(input).trim().replace(/\s+/g, " ");
}

function cleanForAddress(input) {
  if (!input) return "";
  return cleanSpeechText(input)
    .replace(/\bperiod\b/gi, "")
    .replace(/\s+\.\s*/g, " ")
    .trim();
}

function collapseSpacedDigits(value) {
  let output = String(value || "");
  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(/\b(?:\d\s+){1,9}\d\b/g, (match) => match.replace(/\s+/g, ""));
  }
  return output;
}

function normalizeAddressInput(input) {
  if (!input) return "";
  let value = cleanForAddress(input)
    .replace(/[;|]+/g, ",")
    .replace(/\bcomma\b/gi, ",")
    .replace(/\bdot\b/gi, "")
    .replace(/\b(?:the\s+)?(?:service|project|dispatch)\s+address\s+(?:is|at)\b/gi, "")
    .replace(/\b(?:my\s+)?address\s+(?:is|at)\b/gi, "")
    .replace(/\b(?:it(?:'| i)?s|it is)\s+at\b/gi, "")
    .replace(/\b(?:it(?:'| i)?s|it is|i meant|correction|corrected address)\b/gi, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,+/g, ",")
    .replace(/^[,\s]+|[,\s.]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = collapseSpacedDigits(value);
  value = value.replace(/^(\d{1,6})\s+\1(\b.*)$/i, "$1$2");
  value = value.replace(/\s+\bin\s+([A-Za-z][A-Za-z'. -]+,\s*(?:[A-Z]{2}|[A-Za-z ]+)\s+\d{5}(?:-\d{4})?)$/i, ", $1");
  value = value.replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
  return value;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statePatternSource() {
  const names = STATE_NAMES_LONGEST.map(escapeRe);
  const abbrs = Array.from(STATE_ABBREVIATIONS).map(escapeRe);
  return `(?:${names.join("|")}|${abbrs.join("|")})`;
}

const STATE_SOURCE = statePatternSource();
const ZIP_AT_END_RE = /\b\d{5}(?:-\d{4})?\s*$/;
const STATE_ZIP_AT_END_RE = new RegExp(`(?:^|[\\s,])(${STATE_SOURCE})\\s+(\\d{5}(?:-\\d{4})?)\\s*$`, "i");
const STATE_AT_END_RE = new RegExp(`(?:^|[\\s,])(${STATE_SOURCE})\\s*$`, "i");

function normalizeState(value) {
  const s = cleanSpeechText(value || "").toLowerCase();
  if (!s) return "";
  if (s.length === 2 && STATE_ABBREVIATIONS.has(s.toUpperCase())) return s.toUpperCase();
  return STATE_NAME_TO_ABBREVIATION[s] || "";
}

function hasStreet(value) {
  const v = normalizeAddressInput(value);
  return PO_BOX_RE.test(v) || /^\d{1,6}[A-Za-z#-]?\s+\S+/.test(v);
}

function splitTailStateZip(value) {
  const normalized = normalizeAddressInput(value);
  let body = normalized;
  let state = "";
  let zip = "";

  const stateZip = normalized.match(STATE_ZIP_AT_END_RE);
  if (stateZip) {
    state = normalizeState(stateZip[1]);
    zip = stateZip[2];
    body = normalized.slice(0, stateZip.index).replace(/[,\s]+$/g, "").trim();
    return { body, state, zip };
  }

  const zipOnly = normalized.match(ZIP_AT_END_RE);
  if (zipOnly) {
    zip = zipOnly[0].trim();
    body = normalized.slice(0, zipOnly.index).replace(/[,\s]+$/g, "").trim();
  }

  const stateOnly = body.match(STATE_AT_END_RE);
  if (stateOnly) {
    state = normalizeState(stateOnly[1]);
    body = body.slice(0, stateOnly.index).replace(/[,\s]+$/g, "").trim();
  }

  return { body, state, zip };
}

function splitStreetAndCity(body, hasStateOrZip) {
  const normalized = normalizeAddressInput(body);
  if (!normalized) return { street: "", city: "" };

  const parts = normalized.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      street: parts[0],
      city: parts.slice(1).join(", ")
    };
  }

  if (PO_BOX_RE.test(normalized)) {
    const po = normalized.match(PO_BOX_RE);
    const end = po ? po.index + po[0].length : 0;
    return {
      street: normalized.slice(0, end).trim(),
      city: normalized.slice(end).trim()
    };
  }

  const streetType = normalized.match(STREET_TYPE_RE);
  if (streetType && streetType.index != null) {
    const end = streetType.index + streetType[0].length;
    const aptTail = normalized.slice(end).match(/^\s+(?:apt|apartment|unit|suite|ste|#)\s+[A-Za-z0-9-]+/i);
    const streetEnd = aptTail ? end + aptTail[0].length : end;
    return {
      street: normalized.slice(0, streetEnd).trim(),
      city: normalized.slice(streetEnd).trim()
    };
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (hasStateOrZip && /^\d{1,6}[A-Za-z#-]?$/.test(tokens[0] || "") && tokens.length >= 3) {
    return {
      street: tokens.slice(0, 2).join(" "),
      city: tokens.slice(2).join(" ")
    };
  }

  return { street: normalized, city: "" };
}

function analyzeUsServiceAddressCompleteness(input) {
  const normalized = normalizeAddressInput(input);
  const missing = [];
  const tail = splitTailStateZip(normalized);
  const streetCity = splitStreetAndCity(tail.body, Boolean(tail.state || tail.zip));

  const streetOk = hasStreet(streetCity.street);
  const cityOk = Boolean(streetCity.city && /[A-Za-z]/.test(streetCity.city));
  const stateOk = Boolean(tail.state);
  const zipOk = /^\d{5}(?:-\d{4})?$/.test(tail.zip);

  if (!streetOk) missing.push("street");
  if (!cityOk) missing.push("city");
  if (!stateOk) missing.push("state");
  if (!zipOk) missing.push("zip");

  return {
    ok: missing.length === 0,
    missing,
    normalized,
    parts: {
      street: streetOk ? streetCity.street : "",
      city: cityOk ? streetCity.city : "",
      state: tail.state,
      zip: zipOk ? tail.zip : ""
    }
  };
}

function tailForAddress(value) {
  const tail = splitTailStateZip(value);
  const streetCity = splitStreetAndCity(tail.body, Boolean(tail.state || tail.zip));
  const pieces = [];
  if (streetCity.city) pieces.push(streetCity.city);
  if (tail.state || tail.zip) pieces.push(`${tail.state || ""}${tail.state && tail.zip ? " " : ""}${tail.zip || ""}`.trim());
  return pieces.join(", ");
}

function mergeIncrementalServiceAddress(existing, incoming) {
  const prev = normalizeAddressInput(existing);
  const next = normalizeAddressInput(incoming);
  if (!prev) return next;
  if (!next) return prev;

  const prevAnalysis = analyzeUsServiceAddressCompleteness(prev);
  const nextAnalysis = analyzeUsServiceAddressCompleteness(next);
  const nextHasStreet = hasStreet(next);
  const nextHasTail = Boolean(nextAnalysis.parts.city || nextAnalysis.parts.state || nextAnalysis.parts.zip);

  if (nextAnalysis.ok) return next;

  if (nextHasStreet) {
    const prevTail = tailForAddress(prev);
    if (prevAnalysis.parts.state || prevAnalysis.parts.zip || prevAnalysis.parts.city) {
      return normalizeAddressInput(prevTail ? `${next}, ${prevTail}` : next);
    }
    return next;
  }

  const prevLower = prev.toLowerCase();
  const nextLower = next.toLowerCase();
  if (prevLower.includes(nextLower)) return prev;

  if (nextHasTail || !prevLower.endsWith(nextLower)) {
    return normalizeAddressInput(`${prev}, ${next}`);
  }

  return prev;
}

module.exports = {
  normalizeAddressInput,
  analyzeUsServiceAddressCompleteness,
  mergeIncrementalServiceAddress
};
