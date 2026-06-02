/**
 * Shared US service-address normalization + completeness heuristics.
 * Mirrors the inline implementation in server.js (normalizeAddressInput / analyzeUsServiceAddressCompleteness /
 * mergeIncrementalServiceAddress, defined after collapseSpacedDigits). When completeness rules change here,
 * update that block too so npm run test:address matches production without loading Express/Twilio.
 */

function cleanSpeechText(input) {
  if (!input) return "";
  return String(input).trim().replace(/\s+/g, " ");
}

function cleanForSpeech(input) {
  if (!input) return "";
  return cleanSpeechText(input)
    .replace(/\bperiod\b/gi, "")
    .replace(/\s+\.\s*/g, " ")
    .trim();
}

function normalizedText(text) {
  return cleanForSpeech(text || "").toLowerCase();
}

function containsAny(text, phrases) {
  return phrases.some((p) => text.includes(p));
}

function collapseSpacedDigits(value) {
  let output = value;
  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(/\b(?:\d\s+){1,9}\d\b/g, (match) => match.replace(/\s+/g, ""));
  }
  return output;
}

function stripThousandsCommasInNumbers(value) {
  let output = String(value || "");
  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  }
  return output;
}

function stripDispatchConversationalLead(text) {
  let s = cleanForSpeech(text || "");
  for (let guard = 0; guard < 8; guard++) {
    const next = s
      .replace(/^(?:yes|yeah|yep|yup|sure|okay|ok|no|nope|nah)\b[,\s-]*/i, "")
      .replace(/^(?:and|so|well|uh|um|umm|like|right|alright)\b[,\s-]*/i, "")
      .replace(/^(?:i live at|i'?m at|im at|we'?re at|were at|i am at|we are at)\b[,\s]*/i, "")
      .replace(/^(?:my (?:service )?address is|(?:the )?(?:service )?address is|(?:the )?address is|address is)\b[,\s]*/i, "")
      .replace(/^(?:it'?s|it is|its|located at|living at|live at)\b[,\s]*/i, "")
      .replace(/^(?:for reference|what i'?ve noted|what i have noted|service address is|noted)\b[,\s:-]*/i, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function dispatchLineHasStreetNumber(safe) {
  const trimmed = String(safe || "").trim();
  if (!trimmed) return false;
  if (/^\s*\d{1,6}[A-Za-z\-#]?\s+\S/.test(trimmed)) return true;
  if (/\b(p\.?\s*o\.?\s*box|post office box)\b/i.test(trimmed)) return true;
  const firstComma = trimmed.split(",")[0].trim();
  if (/^\d{1,6}[A-Za-z\-#]?\s+\S/.test(firstComma)) return true;
  if (/\b\d{1,6}[A-Za-z\-#]?\s+[A-Za-z]/.test(trimmed)) return true;
  return false;
}

function normalizeAddressInput(input) {
  if (!input) return "";
  let value = cleanForSpeech(input)
    .replace(/\bcomma\b/gi, "")
    .replace(/\bdot\b/gi, "")
    .replace(/[.,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = stripThousandsCommasInNumbers(value);
  value = collapseSpacedDigits(value);
  value = value.replace(/^(\d{1,6})\s+\1(\b.*)$/i, "$1$2");
  value = value.replace(/\s{2,}/g, " ").trim();
  return value;
}

function extractBestDispatchAddressCandidate(raw) {
  const normalized = normalizeAddressInput(raw || "");
  let candidate = stripDispatchConversationalLead(normalized);
  if (!candidate) return normalized;

  let chk = analyzeUsServiceAddressCompleteness(candidate);
  if (chk.ok) return chk.working;

  for (const m of candidate.matchAll(/\b(\d{1,6}\s+[A-Za-z][A-Za-z0-9'\-\s]*)/g)) {
    const tail = candidate.slice(m.index).trim();
    const zipCut = tail.match(/^(.+?\b\d{5}(?:-\d{4})?)\b/);
    const tryLine = zipCut ? zipCut[1].trim() : tail;
    chk = analyzeUsServiceAddressCompleteness(tryLine);
    if (chk.ok) return chk.working;
  }

  return candidate;
}

const US_STATE_ABBREV = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY",
]);

const US_STATE_FULL_SNIPPETS = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
  "district of columbia","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota",
  "mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico",
  "new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island",
  "south carolina","south dakota","tennessee","texas","utah","vermont","virginia","washington",
  "washington dc","washington d c","west virginia","wisconsin","wyoming",
];

function abbreviationIsStreetSuffix(abbrUpper) {
  return ["ST","DR","RD","LN","AVE","BLVD","CT","PL","HWY","PKWY"].includes(abbrUpper);
}

function analyzeUsServiceAddressCompleteness(raw) {
  const working = normalizeAddressInput(raw || "");
  const missing = [];
  const safe = working;
  if (!safe || safe.length < 6) {
    return { ok: false, missing: ["street", "city", "state", "zip"], working };
  }

  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(safe);
  const nt = normalizedText(safe);

  let hasStreet = dispatchLineHasStreetNumber(safe.trim());

  let hasStateAbbrev = false;
  const anchored = safe.trim();
  for (const abbr of US_STATE_ABBREV) {
    if (abbreviationIsStreetSuffix(abbr)) continue;
    const re = new RegExp(`(?:^|[,\\s])${abbr}(?:\\s|,|$|\\s{1,12}\\d{5})`, "i");
    if (re.test(anchored)) {
      hasStateAbbrev = true;
      break;
    }
  }

  const hasFullState = containsAny(nt, US_STATE_FULL_SNIPPETS);
  const hasState = hasStateAbbrev || hasFullState;

  const commaParts = safe.split(",").map((p) => cleanForSpeech(p)).filter(Boolean);

  let hasCity = false;
  if (commaParts.length >= 3) {
    const inner = commaParts.slice(1, -1);
    const last = commaParts[commaParts.length - 1];
    const prev = commaParts[commaParts.length - 2];
    hasCity =
      inner.some((p) => cleanForSpeech(p).replace(/^apt\.?\s*/i, "").replace(/^unit\s*/i, "").length >= 2) ||
      (/\d{5}/.test(last) && cleanForSpeech(prev).length >= 3);
  } else if (commaParts.length === 2) {
    const tail = commaParts[1].trim();
    const fused = /^(.+?)\s+([A-Z]{2})\s+(\d{5})(?:-(\d{4}))?\s*$/i.exec(tail);
    if (fused) {
      const cityCand = cleanForSpeech(fused[1]);
      if (!(cityCand.length === 2 && US_STATE_ABBREV.has(cityCand.toUpperCase())))
        hasCity = cityCand.length >= 2;
    } else if (/\b\d{5}\b/.test(tail) && containsAny(normalizedText(tail), US_STATE_FULL_SNIPPETS)) {
      const withoutZipState = tail.replace(/\b\d{5}(?:-\d{4})?\b\s*$/i, "").trim();
      hasCity = withoutZipState.replace(/\s+/g, "").length >= 2;
    } else {
      const stripped = tail.replace(/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b\s*$/i, "").trim();
      hasCity = stripped.length >= 3;
    }
  } else if (commaParts.length === 1) {
    const oneLine =
      /^(.+?\d.+?)\s+([a-z\s'.-]+(?:\s+[a-z\s'.-]+){0,3})\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/i.exec(safe.trim());
    if (oneLine) {
      const cityChunk = cleanForSpeech(oneLine[2]);
      hasCity =
        cityChunk.length >= 2 &&
        !US_STATE_FULL_SNIPPETS.some((snip) => snip.replace(/\s+/g, "") === cityChunk.replace(/\s+/g, ""));
    }
  }

  if (!hasStreet) missing.push("street");
  if (!hasCity) missing.push("city");
  if (!hasState) missing.push("state");
  if (!hasZip) missing.push("zip");

  const ok = hasStreet && hasCity && hasState && hasZip;
  return { ok, missing: ok ? [] : missing, working };
}

function mergeIncrementalServiceAddress(previousRaw, utteranceRaw) {
  const a = extractBestDispatchAddressCandidate(previousRaw || "");
  const b = extractBestDispatchAddressCandidate(utteranceRaw || "");
  if (!b) return a;
  if (!a) return b;
  if (normalizedText(a) === normalizedText(b)) return a;

  const bAlone = analyzeUsServiceAddressCompleteness(b);
  if (bAlone.ok) return bAlone.working;

  const aAlone = analyzeUsServiceAddressCompleteness(a);
  if (aAlone.ok) return aAlone.working;

  const combos = [
    normalizeAddressInput(`${a}, ${b}`),
    normalizeAddressInput(`${b}, ${a}`),
    normalizeAddressInput(`${a} ${b}`),
    normalizeAddressInput(`${b} ${a}`),
  ];
  for (const c of combos) {
    const extracted = extractBestDispatchAddressCandidate(c);
    const chk = analyzeUsServiceAddressCompleteness(extracted);
    if (chk.ok) return chk.working;
  }
  return extractBestDispatchAddressCandidate(normalizeAddressInput(`${a}, ${b}`));
}

module.exports = {
  normalizeAddressInput,
  analyzeUsServiceAddressCompleteness,
  mergeIncrementalServiceAddress,
  extractBestDispatchAddressCandidate,
};
