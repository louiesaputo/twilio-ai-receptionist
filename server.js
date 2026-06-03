/*************************************************
 CONVERSATIONRELAY BASELINE V15 PASS 7 SCHEDULING + URGENCY + COMPANY PATCH
 DATE: 2026-05-10 (multi-word intro names, tech-notes decline, optional-email phrasing, intent tuning)








 PURPOSE:
 - Separate Twilio ConversationRelay baseline for latency testing
 - Keeps Make.com lead, availability, and booking webhooks
 - Uses Twilio ConversationRelay + Twilio-managed default ElevenLabs voice for lower turn latency
 - Preserves core service / emergency / quote / demo flows
 - Preserves address readback as street + city only
 - Preserves callback wording preferences where practical
 - Removes blocking webhook waits from the live conversation path where possible
 - Adds stronger opening first-name capture
 - Tightens final checkpoint close handling
 - Adds local guardrails for same-day alternate-slot requests
 - Fixes browser callback prompts in item-detail emergency branches
 - Expands outside-water emergency detection and issue summaries
 - Moves strong emergency acknowledgment ahead of name completion when the issue is already clear
 - Adds a very slight response delay so the assistant sounds like it is registering details








 IMPORTANT:
 - This is a separate test build, not an in-place upgrade of your old Gather server.
 - Requires the `ws` package:
     npm install ws








 REQUIRED ENV VARS:
 - TWILIO_ACCOUNT_SID
 - TWILIO_AUTH_TOKEN
 - PUBLIC_BASE_URL              (for the Twilio webhook + wss URL base)
 - TWILIO_API_KEY_SID           (for browser/PC calling token route)
 - TWILIO_API_KEY_SECRET        (for browser/PC calling token route)
 - TWILIO_TWIML_APP_SID         (for browser/PC calling token route)
 
 OPTIONAL ENV VARS:
 - PORT
 - MAKE_WEBHOOK_URL
 - AVAILABILITY_WEBHOOK_URL
 - BOOKING_WEBHOOK_URL
 - POST_SUBMIT_FOLLOWUP_ENABLED   (default false)
 - WEBHOOK_TIMEOUT_MS             (default 5000)
 - AVAILABILITY_TIMEOUT_MS        (default 12000)
 - SUBMISSION_TIMEOUT_MS          (default 4000)
 - CLOSE_SESSION_MIN_MS           (default 4500)
 - CLOSE_SESSION_MAX_MS           (default 12000)
 - RESPONSE_THINK_DELAY_MS       (default 140; raise if replies feel rushed)
 - INTAKE_VERTICAL               (optional: general | appliance — appliance enables conversational appliance-detail intake + softer scheduling acknowledgements)
*************************************************/








console.log(
  "🔥 BLUE CALLER CONVERSATIONRELAY V15 — ADDRESS LOGIC INLINED (no ./address_validation require) — INLINE-ADDR-v1 🔥"
);








const express = require("express");
const twilio = require("twilio");
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const {
  extractOpeningTurn,
  interpretPhoneStep,
  interpretAddressStep,
  interpretSchedulingStep
} = require("./ai_extractor");








const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());








app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });








const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = "CONVERSATIONRELAY-INLINE-ADDR-v1";
const BIND_HOST = (process.env.BIND_HOST || process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";








const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";
const AVAILABILITY_WEBHOOK_URL = process.env.AVAILABILITY_WEBHOOK_URL || "https://hook.us2.make.com/c2gnxl52lvw69122ylvb66gksudiw8jb";
const BOOKING_WEBHOOK_URL = process.env.BOOKING_WEBHOOK_URL || "https://hook.us2.make.com/fm94sa7ws2s7kynhskinnu825lr87pn4";








const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || "";
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || "";
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const POST_SUBMIT_FOLLOWUP_ENABLED = String(process.env.POST_SUBMIT_FOLLOWUP_ENABLED || "false").toLowerCase() === "true";
const AI_INTERPRETER_ENABLED = String(process.env.AI_INTERPRETER_ENABLED || "false").toLowerCase() === "true";
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
const AVAILABILITY_TIMEOUT_MS = Number(process.env.AVAILABILITY_TIMEOUT_MS || 12000);
const SUBMISSION_TIMEOUT_MS = Number(process.env.SUBMISSION_TIMEOUT_MS || 4000);
/** When true, reject webhook slots earlier than computeMinimumAllowedCallbackSpoken() and retry/override. Default false: use Make’s slot as-is (previous behavior). */
const ENFORCE_MIN_CALLBACK_LEAD = String(process.env.ENFORCE_MIN_CALLBACK_LEAD || "false").toLowerCase() === "true";
const CLOSE_SESSION_MIN_MS = Number(process.env.CLOSE_SESSION_MIN_MS || 4500);
const CLOSE_SESSION_MAX_MS = Number(process.env.CLOSE_SESSION_MAX_MS || 12000);
const PROMPT_FINALIZE_TIMEOUT_MS = Number(process.env.PROMPT_FINALIZE_TIMEOUT_MS || 900);
const PHONE_PROMPT_FINALIZE_TIMEOUT_MS = Number(process.env.PHONE_PROMPT_FINALIZE_TIMEOUT_MS || 450);
const OPENER_PROMPT_FINALIZE_TIMEOUT_MS = Number(process.env.OPENER_PROMPT_FINALIZE_TIMEOUT_MS || 950);
const FREEFORM_PROMPT_FINALIZE_TIMEOUT_MS = Number(process.env.FREEFORM_PROMPT_FINALIZE_TIMEOUT_MS || 900);
const MID_THOUGHT_EXTRA_MS = Number(process.env.MID_THOUGHT_EXTRA_MS || 180);
const GREETING_CONTINUATION_GRACE_MS = Number(process.env.GREETING_CONTINUATION_GRACE_MS || 550);
const AI_INTERPRETER_TIMEOUT_MS = Number(process.env.AI_INTERPRETER_TIMEOUT_MS || 1200);
const RESPONSE_THINK_DELAY_MS = Number(process.env.RESPONSE_THINK_DELAY_MS || 140);
const INTAKE_VERTICAL = String(process.env.INTAKE_VERTICAL || "general").trim().toLowerCase();
const IS_APPLIANCE_VERTICAL = INTAKE_VERTICAL === "appliance";

console.log("[AI OPENER CONFIG]", JSON.stringify({ AI_INTERPRETER_ENABLED, INTAKE_VERTICAL: INTAKE_VERTICAL || "general" }));








const callerStore = {};
const wsBySession = new Map();








const AMBIGUOUS_FIRST_NAMES = new Set([
  "john", "jon", "johnny", "jonny",
  "louie", "louis", "luis",
  "bobby", "bobbie",
  "carrie", "kari", "kerri", "keri", "kerry", "carey",
  "cathy", "kathy", "cathie", "kathi",
  "sara", "sarah",
  "steven", "stephen",
  "megan", "meaghan", "meghan", "meagan",
  "tracy", "tracey",
  "jamie", "jaime", "jamey",
  "terri", "terry", "teri",
  "bobbi", "robyn", "robin"
]);








const CRITICAL_LEAK_TERMS = [
  "water main", "main line", "broken main", "burst pipe", "flooding", "flooded",
  "ceiling leak", "roof leak", "water heater leak", "water everywhere", "pouring",
  "gushing", "sewer", "sewage", "no water"
];








const FIRST_AVAILABLE_PHRASES = [
  "first available", "earliest available", "soonest available", "next available",
  "first opening", "earliest opening", "soonest opening", "next opening",
  "whatever works", "whatever you have", "whatever you've got", "whatever youve got",
  "anything open", "anything available", "anything you have open", "anything soon",
  "the sooner the better", "sooner the better", "i'm flexible", "im flexible",
  "any time is fine", "anytime is fine", "first avail", "thatll work", "that'll work",
  "give me the first one", "i'll take anything", "ill take anything", "anything is fine"
];








const ALT_SLOT_PHRASES = [
  "what else do you have", "anything else", "another time", "different time",
  "later that day", "later the same day", "later in the afternoon",
  "later that afternoon", "later that morning", "anything later", "something later",
  "the next day", "next day", "following day", "day after"
];








const REPEAT_TIME_PHRASES = [
  "repeat that", "say that again", "what was that", "what was the time",
  "i missed that", "i missed the time", "can you repeat the time", "repeat the time",
  "what time was that"
];

const BUSINESS_DAY_START_MINUTES = 8 * 60;
const BUSINESS_DAY_END_MINUTES = 17 * 60;
const LATEST_CALLBACK_START_MINUTES = 16 * 60 + 30;
/** Used only when ENFORCE_MIN_CALLBACK_LEAD=true: open + this many clock hours (8am + 6h => 2pm floor). */
const MIN_CALLBACK_LEAD_WALL_HOURS = 6;








function currentEasternParts() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });








  const out = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}








function currentDateInEastern() {
  const p = currentEasternParts();
  return `${p.year}-${p.month}-${p.day}`;
}








function currentDateTimeInEastern() {
  const p = currentEasternParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}








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








function normalizeIntentText(text) {
  return normalizedText(text)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}








function containsAny(text, phrases) {
  return phrases.some((p) => text.includes(p));
}

/** Helps final "anything else?" turns: strips ASR chatter so "^nope|^no\b" matchers still fire. */
function stripLeadingBriefFillerForFinalWrapUp(it) {
  let s = String(it || "").trim();
  for (let guard = 0; guard < 8; guard++) {
    const next = s
      .replace(/^(uh+|um+|umm+|hmm+|mhm+|mm+|well+|oh+|so+|like+|hey+|right+|alright+)\s+/i, "")
      .replace(/^(okay|ok)\s*,\s*/i, "")
      .replace(/^(yeah|yep|yup|yes)\s*,\s*/i, "")
      .replace(/^(yeah|yep|yup)\s+(no|nope|nah|naw)\b\s*/i, "$2 ")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

const SOCIAL_OPENER_PHRASES = [
  "how are you", "how are doing", "how re you", "how are ya",
  "how ya doing", "how ya doin", "how you doing", "how you doin",
  "howya doing", "howya doin", "how ya been", "how you been",
  "how have you been"
];

function hasSocialOpenerPhrase(text) {
  const t = normalizeIntentText(text);
  return Boolean(t) && containsAny(t, SOCIAL_OPENER_PHRASES);
}








function toTitleCase(value) {
  if (!value) return "";
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}








function cleanName(input) {
  if (!input) return "";
  return cleanForSpeech(input)
    .replace(/^my name is\s+/i, "")
    .replace(/^this is\s+/i, "")
    .replace(/^it is\s+/i, "")
    .replace(/^it's\s+/i, "")
    .replace(/^i am\s+/i, "")
    .replace(/^i'm\s+/i, "")
    .replace(/^mr\.?\s+/i, "")
    .replace(/^mrs\.?\s+/i, "")
    .replace(/^ms\.?\s+/i, "")
    .trim();
}








function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
}








function hasFullName(name) {
  if (!name) return false;
  return cleanForSpeech(name).split(/\s+/).filter(Boolean).length >= 2;
}








function normalizeCompanyName(input) {
  const safe = cleanForSpeech(input || "")
    .replace(/[.,]+$/g, "")
    .trim();
  if (!safe) return "";
  return safe
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(llc|inc|co|corp|ltd|lp|pllc|pc|pa)$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function splitNameAndCompany(rawValue) {
  const safe = cleanForSpeech(rawValue || "")
    .replace(/[.,]+$/g, "")
    .trim();
  if (!safe) return { nameCandidate: "", companyName: "" };

  const match = safe.match(/^(.+?)\s+(?:from|with|at)\s+([A-Za-z0-9&'. -]+)$/i);
  if (!match) return { nameCandidate: safe, companyName: "" };

  const nameCandidate = cleanForSpeech(match[1] || "");
  const companyName = normalizeCompanyName(match[2] || "");
  if (!nameCandidate || !companyName || looksLikeIssueText(companyName)) {
    return { nameCandidate: safe, companyName: "" };
  }

  return { nameCandidate, companyName };
}

function extractCompanyNameFromSpeech(rawValue) {
  return splitNameAndCompany(cleanName(rawValue || "")).companyName || "";
}

function normalizeNameCandidate(rawName) {
  if (!rawName) return "";








  const cleanedName = cleanName(rawName);
  const { nameCandidate } = splitNameAndCompany(cleanedName);
  const cleaned = (nameCandidate || cleanedName).toLowerCase();
  const stopWords = new Set([
    "and", "i", "have", "need", "calling", "about", "with", "for", "regarding",
    "because", "alex", "my", "name", "is", "this", "am", "im", "hi", "hello", "hey"
  ]);
  const blockedNameWords = new Set([
    "not", "no", "issue", "problem", "service", "schedule", "scheduling", "appointment",
    "someone", "heating", "cooling", "draining", "working", "broken", "leaking",
    "stove", "oven", "range", "cooktop", "dishwasher", "refrigerator", "washer",
    "dryer", "microwave", "faucet", "sink", "toilet"
  ]);








  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !stopWords.has(word))
    .map((word) => word.replace(/[^a-zA-Z'-]/g, ""))
    .filter(Boolean);








  if (words.length === 0 || words.length > 4) return "";
  if (blockedNameWords.has(words[0])) return "";
  if (words.some((word) => blockedNameWords.has(word))) return "";








  return toTitleCase(words.join(" "));
}








function parseFullNameFromSpeech(rawName) {
  return normalizeNameCandidate(rawName);
}

function splitIssueAndTrailingName(text) {
  const safe = cleanForSpeech(text || "");
  if (!safe) return null;

  const socialStripped = stripSocialLeadIn(safe) || safe;
  const trailingNamePatterns = [
    /^(.*?)(?:,\s*|\s+and\s+)(?:my\s+name\s+is|this\s+is|i\s+am|i'm)\s+([A-Za-z' -]+)$/i,
    /^(.*?)(?:,\s*|\s+and\s+)([A-Za-z' -]+?)\s+here$/i
  ];

  for (const pattern of trailingNamePatterns) {
    const match = socialStripped.match(pattern);
    if (!match) continue;

    const issueCandidate = stripIssueLeadIn(cleanForSpeech(match[1] || ""));
    const possibleName = normalizeNameCandidate(match[2]);
    if (!possibleName || !issueCandidate) continue;

    if (!looksLikeIssueText(issueCandidate) && !detectServiceItem(issueCandidate) && !hasSpecificProblemDetail(issueCandidate)) {
      continue;
    }

    return {
      name: possibleName,
      companyName: extractCompanyNameFromSpeech(match[2]),
      issueText: issueCandidate
    };
  }

  return null;
}

function extractStrongLocalNameAndIssue(text) {
  const safe = cleanSpeechText(text || "");
  if (!safe) return null;

  const socialStripped = stripSocialLeadIn(safe) || safe;
  const sentenceParts = socialStripped
    .split(/(?<=[.!?])\s+/)
    .map((part) => cleanSpeechText(part.replace(/[.!?]+$/g, "")))
    .filter((part) => Boolean(part) && !/^(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)(?:\s*,?\s*alex)?$/i.test(part));

  const nameOnlyPatterns = [
    /^(?:this is|my name is|i am|i'm)\s+([A-Za-z' -]+)$/i,
    /^([A-Za-z' -]+?)\s+here$/i
  ];

  const nameAndIssuePatterns = [
    /^(?:this is|my name is|i am|i'm)\s+([A-Za-z' -]+?)\s*(?:,\s*|\s+and\s+)(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having)\s+(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([A-Za-z' -]+?)\s*[,.!?-]*\s*i\s+need\s+someone\s+(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([A-Za-z' -]+?)\s*[,.!?-]*\s*i\s+need\s+somebody\s+(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([A-Za-z' -]+?)\s*[,.!?-]*\s*(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having)\s+(.+)$/i,
    /^([A-Za-z' -]+?)\s+here\s*(?:,\s*|\s+-\s*|\s+)(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having)\s+(.+)$/i,
    /^(?:call me)\s+([A-Za-z' -]+?)\s*(?:,\s*|\s+and\s+)(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having)\s+(.+)$/i,
    /^(?:call me)\s+([A-Za-z' -]+?)\s*[,.!?-]*\s*(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having)\s+(.+)$/i
  ];

  const tryIssueCleanup = (value) => stripIssueLeadIn(cleanForSpeech(value || ""));
  const joined = sentenceParts.join(" ");

  for (const pattern of nameAndIssuePatterns) {
    const match = joined.match(pattern);
    if (!match) continue;
    const possibleName = normalizeNameCandidate(match[1]);
    const issueText = tryIssueCleanup(match[2]);
    if (possibleName && issueText) {
      return {
        name: possibleName,
        companyName: extractCompanyNameFromSpeech(match[1]),
        issueText
      };
    }
  }

  if (sentenceParts.length >= 2) {
    const first = sentenceParts[0];
    const remainder = sentenceParts.slice(1).join(" ");
    for (const pattern of nameOnlyPatterns) {
      const match = first.match(pattern);
      if (!match) continue;
      const possibleName = normalizeNameCandidate(match[1]);
      const issueText = tryIssueCleanup(remainder);
      if (possibleName && issueText) {
        return {
          name: possibleName,
          companyName: extractCompanyNameFromSpeech(match[1]),
          issueText
        };
      }
    }
  }

  return null;
}








/** Where spoken intro ends and issue begins ("Jim Miller and I have…"). */
function sliceIntroNameBeforeIssue(rest) {
  const value = String(rest || "").trim();
  if (!value) return "";

  const markers = [
    /\s*,\s*and\s+i\s+/i,
    /\s+and\s+i\s+have\b/i,
    /\s+and\s+i\s+need\b/i,
    /\s+and\s+i'?ve\s+got\b/i,
    /\s+and\s+i'?m\s+having\b/i,
    /\s+i\s+need\s+someone\b/i,
    /\s+i\s+need\s+somebody\b/i,
    /\s+need\s+someone\b/i,
    /\s+need\s+somebody\b/i,
    /\s+i\s+need\s+to\s+come\b/i,
    /\s+need\s+to\s+come\b/i,
    /\s*,\s*i\s+have\b/i,
    /\s*,\s*i\s+need\b/i,
    /\s+i\s+have\b/i,
    /\s+i\s+need\b/i,
    /\s+i'?ve\s+got\b/i,
    /\s+i'?m\s+having\b/i,
    /\s+i\s+am\s+having\b/i,
    /\s+i\s+was\s+calling\b/i,
    /\s+i'?m\s+calling\b/i,
    /\s+calling\s+about\b/i,
    /\s+calling\s+regarding\b/i,
    /\s+can\s+someone\b/i,
    /\s+can\s+somebody\b/i,
    /\s+can\s+you\b/i,
    /\s+got\s+a\b/i,
    /\s+there'?s\s+a\b/i,
    /\s+with\s+a\b/i,
    /\s+with\s+my\b/i,
    /\s+with\s+the\b/i,
    /\s+about\s+/i,
    /\s+regarding\s+/i
  ];

  let earliest = -1;
  for (const re of markers) {
    const m = value.match(re);
    if (m && typeof m.index === "number") {
      if (earliest === -1 || m.index < earliest) earliest = m.index;
    }
  }

  const segment = earliest >= 0 ? value.slice(0, earliest) : value;
  return segment.replace(/[,.]+$/g, "").trim();
}

/**
 * Full normalized name from opening intros — supports "this is Jim Miller and I have…"
 * (previously only the first word was captured).
 */
function extractIntroFullNameCandidate(text) {
  const safe = stripGreetingPrefix(text || "");
  if (!safe) return "";

  const prefixMatch =
    safe.match(/^(?:this is|my name is|i am|i'm)\s+/i)
    || safe.match(/^call me\s+/i)
    || safe.match(/^i'?m\s+(?:speaking|calling)\s+with\s+/i);
  if (prefixMatch) {
    const rest = safe.slice(prefixMatch[0].length);
    const nameSeg = sliceIntroNameBeforeIssue(rest);
    const full = normalizeNameCandidate(nameSeg);
    if (full) return full;
  }

  const here = safe.match(/^([a-zA-Z' -]+)\s+here\b/i);
  if (here) {
    const full = normalizeNameCandidate((here[1] || "").trim());
    if (full) return full;
  }

  const tailAfterIntro = safe.replace(/^(?:this is|my name is|i am|i'm)\s+/i, "").trim();
  if (tailAfterIntro) {
    const looseCut = tailAfterIntro.match(
      /^([a-z][a-z'\s-]{0,120}?)(?=\s+(?:,\s*)?(?:and\s+)?(?:i\s+have|i\s+need|i'?ve\s+got|need\s+someone|need\s+somebody)\b)/i
    );
    if (looseCut && looseCut[1]) {
      const full = normalizeNameCandidate(looseCut[1].trim().replace(/[,.]+$/g, ""));
      if (full) return full;
    }
  }

  const single = safe.match(/^(?:this is|my name is|i am|i'm)\s+([A-Za-z'-]+)\b/i);
  if (single) return normalizeNameCandidate(single[1]) || "";

  return "";
}








function firstNameNeedsSpelling(name) {
  const first = normalizedText(name).replace(/[^a-z]/g, "");
  return Boolean(first && AMBIGUOUS_FIRST_NAMES.has(first));
}








function normalizeSpelledFirstName(text, fallback = "") {
  const letters = cleanForSpeech(text || "").replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 2 && letters.length <= 15) {
    return toTitleCase(letters);
  }
  return fallback || "";
}








function maybeQueueFirstNameSpelling(caller, nextStep, preamble) {
  if (caller.firstName && !caller.nameSpellingConfirmed && firstNameNeedsSpelling(caller.firstName)) {
    caller.pendingNameNextStep = nextStep || (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name");
    caller.lastStep = "ask_first_name_spelling";
    const core = `I know ${caller.firstName} can be spelled a few different ways. How do you spell it?`;
    const prefix = preamble ? cleanForSpeech(preamble) : "";
    return prefix ? `${prefix} ${core}` : core;
  }
  return "";
}








function stripIssueLeadIn(text) {
  if (!text) return "";
  return cleanForSpeech(text)
    .replace(/^(and\s+)?i\s+have\s+/i, "")
    .replace(/^(and\s+)?i\'ve\s+got\s+/i, "")
    .replace(/^(and\s+)?i\s+need\s+/i, "")
    .replace(/^(and\s+)?i\s+would\s+like\s+/i, "")
    .replace(/^(and\s+)?i\'?d\s+like\s+/i, "")
    .replace(/^(and\s+)?i\s+want\s+/i, "")
    .replace(/^(and\s+)?i\s+am\s+interested\s+in\s+/i, "")
    .replace(/^(and\s+)?i\'?m\s+interested\s+in\s+/i, "")
    .replace(/^i\s+need\s+someone\s+to\s+call\s+me\s+about\s+/i, "")
    .replace(/^i\s+need\s+somebody\s+to\s+call\s+me\s+about\s+/i, "")
    .replace(/^i\s+need\s+someone\s+to\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^i\s+need\s+somebody\s+to\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^i\s+need\s+someone\s+to\s+check\s+/i, "")
    .replace(/^i\s+need\s+somebody\s+to\s+check\s+/i, "")
    .replace(/^can\s+someone\s+call\s+me\s+about\s+/i, "")
    .replace(/^can\s+somebody\s+call\s+me\s+about\s+/i, "")
    .replace(/^can\s+someone\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^can\s+somebody\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^can\s+someone\s+check\s+/i, "")
    .replace(/^can\s+somebody\s+check\s+/i, "")
    .replace(/^someone\s+to\s+call\s+me\s+about\s+/i, "")
    .replace(/^somebody\s+to\s+call\s+me\s+about\s+/i, "")
    .replace(/^someone\s+to\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^somebody\s+to\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^come\s+look\s+at\s+/i, "")
    .replace(/^come\s+check\s+/i, "")
    .replace(/^calling\s+about\s+/i, "")
    .replace(/^calling\s+with\s+/i, "")
    .replace(/^calling\s+for\s+/i, "")
    .replace(/^calling\s+regarding\s+/i, "")
    .replace(/^about\s+/i, "")
    .replace(/^with\s+/i, "")
    .replace(/^regarding\s+/i, "")
    .replace(/^because\s+/i, "")
    .replace(/^for\s+/i, "")
    .trim();
}

/** Strips a trailing name introduction bundled into issue text (same utterance, no pause). */
function stripTrailingNameIntroductionFromIssueText(text) {
  const safe = cleanForSpeech(text || "");
  if (!safe) return "";
  return safe
    .replace(/\s+(?:my name is|this is|i am|i'm)\s+[a-z][a-z'\s-]{0,120}$/i, "")
    .replace(/\s+call me\s+[a-z][a-z'\s-]{0,120}$/i, "")
    .trim();
}
















function stripGreetingPrefix(text) {
  return cleanSpeechText(text || "")
    .replace(/^(hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)\s*,?\s*alex\s*[,. -]*\s*/i, "")
    .replace(/^(hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)\s*[,. -]*\s*/i, "")
    .trim();
}








function normalizeGenericServiceIssue(text) {
  const stripped = cleanForSpeech(stripIssueLeadIn(stripTrailingNameIntroductionFromIssueText(text || "")));
  const item = detectServiceItem(stripped);
  if (!item) return stripped;
  if (hasSpecificProblemDetail(stripped)) return stripped;








  const lowered = normalizedText(stripped);
  if (containsAny(lowered, [
    "someone to come look at", "somebody to come look at",
    "someone to check", "somebody to check",
    "look at", "check", "come look at", "come check"
  ])) {
    return item.label;
  }








  if (/^(my|the|our)\s+/.test(lowered)) {
    return stripped;
  }








  return item.label;
}








function combineIssueContextAndDetail(issueContext, detail) {
  const safeContext = cleanForSpeech(stripIssueLeadIn(issueContext || ""));
  const safeDetail = cleanForSpeech(stripIssueLeadIn(detail || ""));
  if (!safeContext) return safeDetail;
  if (!safeDetail) return safeContext;




  const contextNorm = normalizedText(safeContext);
  const detailNorm = normalizedText(safeDetail);
  if (detailNorm.startsWith(contextNorm)) return safeDetail;
  if (contextNorm.includes(detailNorm) && detailNorm.length >= 4) return safeContext;




  return `${safeContext} ${safeDetail}`.trim();
}
















function looksLikeIssueText(text) {
  const t = normalizedText(text || "");
  return Boolean(
    t && (
      t.startsWith("my ") ||
      t.startsWith("the ") ||
      t.startsWith("our ") ||
      t.includes(" not ") ||
      t.includes("isn't") ||
      t.includes("isnt") ||
      t.includes("won't") ||
      t.includes("wont") ||
      t.includes("leak") ||
      t.includes("cool") ||
      t.includes("heat") ||
      t.includes("drain") ||
      t.includes("noise") ||
      t.includes("problem") ||
      t.includes("issue") ||
      t.includes("refrigerator") ||
      t.includes("fridge") ||
      t.includes("freezer") ||
      t.includes("oven") ||
      t.includes("dishwasher") ||
      t.includes("washer") ||
      t.includes("dryer") ||
      t.includes("range") ||
      t.includes("stove") ||
      t.includes("cooktop") ||
      t.includes("faucet") ||
      t.includes("sink") ||
      t.includes("toilet") ||
      t.includes("water heater") ||
      t.includes("quote") ||
      t.includes("estimate") ||
      t.includes("install")
    )
  );
}








function isGenericEmergencyIssue(text) {
  const t = normalizedText(text || "");
  if (!t) return false;
  if (!containsAny(t, ["emergency", "urgent", "right away", "as soon as possible", "immediately"])) return false;
  return !containsAny(t, [
    "leak", "burst", "pipe", "faucet", "sink", "toilet", "roof", "ceiling", "water heater",
    "refrigerator", "fridge", "freezer", "dishwasher", "washer", "dryer", "oven", "stove",
    "range", "cooktop", "water main", "yard", "sewer", "sewage", "gas leak", "flood", "drain",
    "clog", "clogged", "spigot", "remodel", "quote", "estimate", "installation"
  ]);
}








function extractOpeningNameAndIssue(text) {
  const original = cleanSpeechText(text || "");
  if (!original) return { name: null, issueText: "" };

  const fullyStrippedSocial = stripSocialLeadIn(original);
  if (!fullyStrippedSocial && hasSocialOpenerPhrase(original)) {
    return { name: null, issueText: "" };
  }








  const normalized = stripGreetingPrefix(original);

  const tryCleanupOpeningIssue = (value) => stripIssueLeadIn(cleanForSpeech(value || ""));
  const tailIdentityMatch = normalized.match(/\s+(?:my name is|this is|i am|i'm)\s+([a-z][a-z'\s-]{0,120})$/i);
  if (tailIdentityMatch && typeof tailIdentityMatch.index === "number") {
    const issueStem = normalized.slice(0, tailIdentityMatch.index).trim().replace(/[,.]+$/g, "");
    const extractedName = normalizeNameCandidate(tailIdentityMatch[1]);
    const issueText = tryCleanupOpeningIssue(issueStem);
    const specificEnough = Boolean(
      issueText &&
      (looksLikeIssueText(issueText) || detectServiceItem(issueText) || hasSpecificProblemDetail(issueText))
    );
    if (extractedName && specificEnough) {
      return {
        name: extractedName,
        companyName: extractCompanyNameFromSpeech(tailIdentityMatch[1]),
        issueText
      };
    }
  }

  const sentenceParts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => cleanSpeechText(part.replace(/[.!?]+$/g, "")))
    .filter(Boolean);








  const nameOnlyPatterns = [
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+)$/i,
    /^([a-zA-Z' -]+?)\s+here$/i
  ];








  const nameAndIssuePatterns = [
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s*(?:,\s*|\s+and\s+)(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s*[,.!?-]*\s*i\s+need\s+someone\s+(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s*[,.!?-]*\s*i\s+need\s+somebody\s+(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s*[,.!?-]*\s*(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having|i\s+was\s+calling\s+about|i\s+am\s+calling\s+about|i'm\s+calling\s+about)\s+(.+)$/i,
    /^([a-zA-Z' -]+?)\s+here\s*(?:,\s*|\s+-\s*|\s+)(.+)$/i,
    /^(?:call me)\s+([a-zA-Z' -]+?)\s*(?:,\s*|\s+and\s+)(.+)$/i,
    /^(?:call me)\s+([a-zA-Z' -]+?)\s*[,.!?-]*\s*(?:i\s+have|i've\s+got|i\s+need|i\s+am\s+having|i'm\s+having|i\s+was\s+calling\s+about|i\s+am\s+calling\s+about|i'm\s+calling\s+about)\s+(.+)$/i
  ];








  const tryIssueCleanup = (value) => stripIssueLeadIn(cleanForSpeech(value || ""));








  if (sentenceParts.length) {
    const first = sentenceParts[0];

    const sameSentenceIssueAndName = splitIssueAndTrailingName(first);
    if (sameSentenceIssueAndName) {
      return sameSentenceIssueAndName;
    }

    for (const pattern of nameAndIssuePatterns) {
      const match = first.match(pattern);
      if (!match) continue;
      const possibleName = normalizeNameCandidate(match[1]);
      const companyName = extractCompanyNameFromSpeech(match[1]);
      const issueText = tryIssueCleanup(match[2]);
      if (possibleName && issueText) return { name: possibleName, companyName, issueText };
    }







    for (const pattern of nameOnlyPatterns) {
      const match = first.match(pattern);
      if (!match) continue;
      const possibleName = normalizeNameCandidate(match[1]);
      if (!possibleName) continue;







      const remainder = sentenceParts.slice(1).join(" ");
      if (remainder) return { name: possibleName, issueText: tryIssueCleanup(remainder) };
      return { name: possibleName, issueText: "" };
    }







    let issueFirstName = null;
    let issueFirstCompanyName = "";
    let issueFirstIssueText = "";






    const issueLooksSpecificEnough = (value) => {
      const cleaned = tryIssueCleanup(value);
      return Boolean(cleaned && (looksLikeIssueText(cleaned) || detectServiceItem(cleaned) || hasSpecificProblemDetail(cleaned)));
    };

    for (const part of sentenceParts) {
      const sameSentencePartIssueAndName = splitIssueAndTrailingName(part);
      if (sameSentencePartIssueAndName) {
        issueFirstName = issueFirstName || sameSentencePartIssueAndName.name;
        issueFirstCompanyName = issueFirstCompanyName || sameSentencePartIssueAndName.companyName || "";
        issueFirstIssueText = issueFirstIssueText || sameSentencePartIssueAndName.issueText;
        continue;
      }

      for (const pattern of nameAndIssuePatterns) {
        const match = part.match(pattern);
        if (!match) continue;
        const possibleName = normalizeNameCandidate(match[1]);
        const candidateIssueText = tryIssueCleanup(match[2]);
        if (!possibleName) continue;
        issueFirstName = issueFirstName || possibleName;
        issueFirstCompanyName = issueFirstCompanyName || extractCompanyNameFromSpeech(match[1]);
        if (!issueFirstIssueText && issueLooksSpecificEnough(candidateIssueText)) {
          issueFirstIssueText = candidateIssueText;
        }
        break;
      }

      for (const pattern of nameOnlyPatterns) {
        const match = part.match(pattern);
        if (!match) continue;
        const possibleName = normalizeNameCandidate(match[1]);
        if (!possibleName) continue;
        issueFirstName = issueFirstName || possibleName;
        issueFirstCompanyName = issueFirstCompanyName || extractCompanyNameFromSpeech(match[1]);
        break;
      }

      if (!issueFirstIssueText) {
        const cleanedPart = tryIssueCleanup(part);
        if (issueLooksSpecificEnough(cleanedPart)) {
          issueFirstIssueText = cleanedPart;
        }
      }
    }






    if (issueFirstName && issueFirstIssueText) {
      return { name: issueFirstName, companyName: issueFirstCompanyName, issueText: issueFirstIssueText };
    }
  }

  const introMarker = normalized.match(/^(?:this is|my name is|i am|i'm)\s+/i);
  if (introMarker) {
    const remainder = normalized.slice(introMarker[0].length).trim();
    const issueMarkers = [
      /[,.]?\s+and\s+i\s+have\b/i,
      /[,.]?\s+i\s+have\b/i,
      /[,.]?\s+i\s+need\b/i,
      /[,.]?\s+i\'?m\s+having\b/i,
      /[,.]?\s+i\s+am\s+having\b/i,
      /[,.]?\s+can\s+someone\b/i,
      /[,.]?\s+can\s+somebody\b/i,
      /[,.]?\s+can\s+you\b/i,
      /[,.]?\s+calling\s+about\b/i,
      /[,.]?\s+calling\s+regarding\b/i,
      /[,.]?\s+about\b/i,
      /[,.]?\s+with\b/i,
      /[,.]?\s+regarding\b/i
    ];








    let earliestIndex = -1;
    for (const marker of issueMarkers) {
      const m = remainder.match(marker);
      if (!m || typeof m.index !== "number") continue;
      if (earliestIndex === -1 || m.index < earliestIndex) earliestIndex = m.index;
    }








    if (earliestIndex > 0) {
      const nameSegment = remainder.slice(0, earliestIndex);
      const possibleName = normalizeNameCandidate(nameSegment);
      const companyName = extractCompanyNameFromSpeech(nameSegment);
      const issueText = tryIssueCleanup(remainder.slice(earliestIndex));
      if (possibleName && issueText) return { name: possibleName, companyName, issueText };
    }








    const possibleNameOnly = normalizeNameCandidate(remainder);
    const companyNameOnly = extractCompanyNameFromSpeech(remainder);
    if (possibleNameOnly) return { name: possibleNameOnly, companyName: companyNameOnly, issueText: "" };
  }








  const directFallback = normalized.match(/^([a-zA-Z' -]+?)\s+here\s*(?:,\s*|\s+)(.+)$/i);
  if (directFallback) {
    const possibleName = normalizeNameCandidate(directFallback[1]);
    const companyName = extractCompanyNameFromSpeech(directFallback[1]);
    const issueText = tryIssueCleanup(directFallback[2]);
    if (possibleName && issueText) return { name: possibleName, companyName, issueText };
  }








  if (looksLikeIssueText(normalized)) {
    return { name: null, issueText: tryIssueCleanup(normalized) || original };
  }








  return { name: null, issueText: original };
}
















function normalizeProjectScopeNotes(text) {
  return cleanForSpeech(text || "")
    .replace(/\bflorida ceiling\b/gi, "floor-to-ceiling")
    .replace(/\bfloor to ceiling\b/gi, "floor-to-ceiling")
    .replace(/\bfloor two ceiling\b/gi, "floor-to-ceiling")
    .trim();
}








function wantsOptionalEmail(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (t.includes("@")) return true;
  if (isAffirmative(t)) return true;
  if (/\b(yeah|yes|yep|yup|sure)\b.*\bwed\s+better\b/.test(t)) return true;







  if (/^(yes|yeah|yep|yup|sure|okay|ok|alright|all right)\b.*\b(add|include|email)\b/.test(t)) return true;
  if (/^(yes|yeah|yep|yup|sure|okay|ok|alright|all right)\b.*\b(do that|do it|let s do that|lets do that|let s add that|lets add that|let s add one|lets add one)\b/.test(t)) return true;
  if (/^(yes|yeah|yep|yup|sure|okay|ok|alright|all right)\b.*\b(i ll|ill|let me)\b.*\b(give|add|include)\b/.test(t)) return true;
  if (/^(yes|yeah|yep|yup|sure|okay|ok|alright|all right)\b.*\b(add|include|email|let s|lets|give)\b/.test(t)) return true;
  if (/^(yes|yeah|yep|yup|sure|okay|ok|alright|all right)\b.*\b(that|one|that one|that too|that as well|that also)\b/.test(t) && /\b(add|include|email|give|do)\b/.test(t)) return true;








  return containsAny(t, [
    "we better add one", "we d better add one", "wed better add one",
    "we better add that", "we d better add that", "wed better add that",
    "let s add one", "lets add one", "let s add that", "lets add that",
    "let s do that", "lets do that", "let s do it", "lets do it",
    "add one", "add that", "include one", "include that",
    "i ll give it to you", "ill give it to you", "let me give it to you",
    "okay let me know when you re ready and i ll give it to you",
    "okay let me know when youre ready and ill give it to you",
    "yeah that ll do", "yeah thatll do", "yeah we better add one", "yeah we better add that",
    "yeah let s add one", "yeah lets add one", "yeah let s add that", "yeah lets add that",
    "yeah let s do that", "yeah lets do that", "yeah let s do it", "yeah lets do it",
    "yes please", "sure add one", "sure add that", "go ahead",
    "yeah wed better", "yes wed better", "yep wed better", "sure wed better",
    "we d better add", "we better add", "better include email",
    "yeah we better", "yes we better", "yeah better add", "should add email"
  ]);
}








function buildPostNotesTransition(caller, hadNotes) {
  if (hadNotes) {
    if (caller.leadType === "quote") return "Alright, I've added that to the quote request.";
    return "Alright, I've added that for the technician.";
  }
  return "Alright, let me get this wrapped up for us.";
}
















function buildAddressRequestPrompt(caller) {
  if (caller.leadType === "quote") {
    return "What is the project address?";
  }
  const variants = [
    "Got it—and what's the service address?",
    "Great, thanks. What's the service address?",
    "Perfect. Can I get the service address?"
  ];
  const idx = nextPromptIndex(caller, "addressRequestPromptIndex");
  return variants[idx % variants.length];
}








function appendAdditionalIssue(caller, issueText) {
  const safe = cleanForSpeech(issueText || "");
  if (!safe) return;
  caller.additionalIssues = Array.isArray(caller.additionalIssues) ? caller.additionalIssues : [];
  caller.additionalIssues.push(safe);
  caller.notes = caller.notes ? `${caller.notes} Additional issue: ${safe}` : `Additional issue: ${safe}`;
}




const ALEX_TONE_RANK = {
  neutral: 0,
  warm: 1,
  playful: 2,
  urgent_stressed: 3,
  frustrated: 4,
  overwhelmed: 4,
  upset: 5
};

function toneRank(tone) {
  return ALEX_TONE_RANK[tone] ?? 0;
}

function inferEmotionalToneFromSpeech(raw) {
  const t = normalizeIntentText(raw || "");
  if (!t) return "neutral";

  if (containsAny(t, [
    "furious", "lawsuit", "unacceptable", "ridiculous", "this is insane", "so angry",
    "screw this", "worst service", "outrageous", "disgusted", "this is a joke", "never using"
  ])) {
    return "upset";
  }
  if (containsAny(t, [
    "pissed", "sick of this", "had enough", "not happy", "very upset", "extremely frustrated",
    "this is ridiculous", "so frustrated", "damn it", "dammit", "angry", "fed up",
    "damn leak", "damn pipe", "damn thing", "hell of a leak", "hell of a mess", "this sucks"
  ]) || (/\b(damn|hell|crap)\b/.test(t) && containsAny(t, ["leak", "leaking", "drip", "dripping", "pipe", "burst", "water", "flood", "flooding"]))) {
    return "frustrated";
  }
  if (containsAny(t, [
    "overwhelmed", "freaking out", "losing it", "losing my mind", "frazzled", "so stressed",
    "cant take it", "can't take it", "exhausted", "crying", "panic", "spinning", "too much at once"
  ])) {
    return "overwhelmed";
  }
  if (containsAny(t, [
    "right now", "asap", "as soon as possible", "immediately", "urgent", "hurry", "quickly",
    "need someone now", "dont have time", "don't have time", "need this fixed today", "need help now",
    "need to get this fixed", "need to get this thing fixed", "get this thing fixed", "get this fixed",
    "gotta get this fixed", "got to get this fixed", "need it fixed"
  ])) {
    return "urgent_stressed";
  }
  if (containsAny(t, ["haha", "ha ha", "lol", "l o l", "just kidding", "kidding", "joking", "too funny"])) {
    return "playful";
  }
  if (containsAny(t, ["thank you so", "really appreciate", "you have been great", "you've been great", "so kind"])) {
    return "warm";
  }
  return "neutral";
}

function updateCallerEmotionalTone(caller, userText) {
  if (!caller) return;
  const next = inferEmotionalToneFromSpeech(userText);
  if (next === "neutral") return;
  const cur = caller.alexEmotionalTone || "neutral";
  if (toneRank(next) >= toneRank(cur)) {
    caller.alexEmotionalTone = next;
  }
}

function applyAlexConversationalToneLayer(caller, text, options = {}) {
  let out = String(text || "");
  if (!out.trim()) return out;
  const tone = caller.alexEmotionalTone || "neutral";
  const skipPrefix = options.tonePrefix === false;
  const trimmed = out.trim();
  const alreadyEmpathic =
    /^I'?m sorry\b/i.test(trimmed) ||
    /\bI know that\b/i.test(trimmed) ||
    /^(I hear|I understand|It sounds like|Thanks for sharing|I appreciate the humor)/i.test(trimmed);

  if (!skipPrefix && !alreadyEmpathic && (caller.alexEmpathyPrefixCount || 0) < 1 && out.length >= 56) {
    const prefixes = {
      upset: "I'm on it—",
      frustrated: "I get it—",
      overwhelmed: "Let's take this one step at a time—",
      urgent_stressed: "On it—",
      warm: "Thanks—"
    };
    const pre = prefixes[tone];
    if (pre) {
      caller.alexEmpathyPrefixCount = (caller.alexEmpathyPrefixCount || 0) + 1;
      out = pre + out;
    }
  }

  if (tone === "playful" && (caller.alexPlayfulLeadIns || 0) < 1 && out.length >= 48) {
    if (!/^Love it/i.test(trimmed)) {
      caller.alexPlayfulLeadIns = (caller.alexPlayfulLeadIns || 0) + 1;
      out = "Love it—" + out;
    }
  }

  return out;
}

function buildTechnicianNotesPrompt(caller) {
  const c = caller || {};
  if (c.leadType === "quote") {
    const tone = c.alexEmotionalTone || "neutral";
    if (tone === "overwhelmed" || tone === "upset") {
      return "Whenever you're ready—any other details we should pass to the estimator, like access notes or a second contact? If not, that's okay.";
    }
    if (tone === "urgent_stressed" || tone === "frustrated") {
      return "One last thing for the quote packet—access, parking, HOA, or timing notes the office should know about?";
    }
    const variants = [
      "Is there anything else you'd like me to include with this quote request?",
      "Anything for the estimator—access, parking, multiple decision-makers, or timing notes—I should add?",
      "Last optional bit: any notes for the team putting the quote together?"
    ];
    const idx = nextPromptIndex(c, "quoteNotesVariantIndex");
    return variants[idx % variants.length];
  }
  const tone = c.alexEmotionalTone || "neutral";
  if (tone === "overwhelmed" || tone === "upset") {
    return "Whenever you're ready, is there anything you'd like the technician to know before they arrive? If not, that's completely okay.";
  }
  if (tone === "urgent_stressed" || tone === "frustrated") {
    return "Before we wrap, any short notes for the technician—access codes, pets, parking, anything like that?";
  }
  const variants = [
    "Before I wrap this up, are there any special instructions or notes you want me to include for the technician?",
    "When you have a moment, is there anything specific the technician should know before they head out?",
    "Last quick thing for the tech—any special instructions or access notes I should include?"
  ];
  const idx = nextPromptIndex(c, "techNotesVariantIndex");
  return variants[idx % variants.length];
}

function buildMissingNameAfterIssuePrompt(caller) {
  const speech = humanizeIssueSummaryForSpeech(caller.issueSummary || caller.issue || "").trim();

  const withIssueVariants = [
    (issue) => `I can help with ${issue}. Can I get your full name, please?`,
    (issue) => `Got it—we'll get somebody lined up for ${issue}. Who should I list as the contact? I'll need your full first and last name.`,
    (issue) => `Absolutely, I'll note ${issue} for the team. What's your complete first and last name?`
  ];

  const noIssueVariants = [
    "Sure—I can help with that request. What's your full name?",
    "I can definitely help with this today. Who should I list—full first and last name?",
    "Sounds good—can we start with your full name?"
  ];

  const i = nextPromptIndex(caller, "missingNameAfterIssuePromptIndex");

  if (speech && speech.length >= 6) {
    return withIssueVariants[i % withIssueVariants.length](speech);
  }
  return noIssueVariants[i % noIssueVariants.length];
}








/** True when caller is done with the anything-else pass (affirmative goodbye, no, nope, etc.). */
function isFinalQuestionWrapUpAnswer(text) {
  const it = stripLeadingBriefFillerForFinalWrapUp(normalizeIntentText(text || ""));
  if (!it) return false;

  if (looksLikeSubstantiveFinalQuestionAddition(text)) return false;

  if (isAffirmative(it) || isNegative(it) || isEndCallPhrase(it)) return true;

  const tLo = normalizedText(it);

  if (
    containsAny(it, [
      "i think that s it",
      "i think thats it",
      "that s all",
      "thats all",
      "that is all",
      "nope that s it",
      "nope thats it",
      "nah that s it",
      "nah thats it",
      "no that s it",
      "no thats it",
      "no nothing",
      "no nothing else",
      "nothing else",
      "nothing more",
      "nothing to add",
      "nothing more to add",
      "that s everything",
      "thats everything",
      "that ll do it",
      "thatll do it",
      "that will do it",
      "that ll do",
      "thatll do",
      "all set",
      "we re all set",
      "were all set",
      "i m all set",
      "im all set",
      "we re good",
      "were good",
      "i m good",
      "im good"
    ]) ||
    containsAny(tLo, [
      "bye",
      "goodbye",
      "good bye",
      "see ya",
      "cya",
      "catch you later",
      "that's all",
      "that's it",
      "that'll do",
      "that'll do it"
    ])
  ) {
    return true;
  }

  if (
    /\b(no|nope|nah|naw)\s+(that s it|thats it|that s all|thats all|nothing else|nothing more)\b/.test(it) ||
    /\b(that s it|thats it|that s all|thats all|nothing else|that ll do|thatll do|that will do)\s*(thanks|thank you|thx)\b/.test(it)
  ) {
    return true;
  }

  if (it.length <= 42 && /\b(that s it|thats it|that s all|thats all|nothing else|all set)\b$/i.test(it)) {
    return true;
  }

  return false;
}

/** After caller adds another detail at final_question—short acknowledgement (then a fresh anything-else pitch). */
function buildAcknowledgeAdditionalFinalIssue(caller) {
  const pools = [
    "Got it—I have folded that into what we are passing to the team.",
    "Thanks, I have slipped that in on the request.",
    "Okay, I have tucked that detail in for whoever reaches out.",
    "Perfect—that is noted alongside the rest.",
    "Sure thing—I have queued that up with the other details."
  ];
  const i = nextPromptIndex(caller, "additionalFinalIssueAckIndex");
  return pools[i % pools.length];
}

function buildFinalSubmissionPrompt(caller) {
  if (caller.emergencyAlert) {
    const pools = [
      "Need anything else from me before I flag this emergency for the crew?",
      "Anything else you want captured while we are wrapping this urgency up?",
      "Before I punch this through as an emergency—is there anything else I should pass along?",
      "If there is nothing else, I will get this flagged so someone reaches out ASAP—sound good?"
    ];
    const ei = nextPromptIndex(caller, "finalSubmissionPitchEmergency");
    return pools[ei % pools.length];
  }

  if (caller.leadType === "quote") {
    const pools = [
      "Anything else about the quote I should jot down?",
      "Is there something else about the estimate or timeline you would like me to capture?",
      "Need me to attach any other quote details before we wrap?",
      "If you are all set otherwise, someone from our office will follow up on the quote—is there anything else today?"
    ];
    const qi = nextPromptIndex(caller, "finalSubmissionPitchQuote");
    return pools[qi % pools.length];
  }

  if (caller.status === "scheduled" && caller.appointmentDate && caller.appointmentTime) {
    const d = caller.appointmentDate;
    const tm = caller.appointmentTime;
    const scheduledPools = [
      `You are on the calendar for ${d} at ${tm}. Anything else I can line up before we sign off?`,
      `I have you down for ${d} at ${tm}—anything else you would like me to add?`,
      `Callback-wise you are set for ${d} at ${tm}. Anything else you would want noted?`,
      `That ${d} at ${tm} slot is tracked. Need anything else from me today?`
    ];
    const si = nextPromptIndex(caller, "finalSubmissionPitchScheduled");
    return scheduledPools[si % scheduledPools.length];
  }

  if (caller.status === "scheduled_pending_confirmation" && caller.appointmentDate && caller.appointmentTime) {
    const d = caller.appointmentDate;
    const tm = caller.appointmentTime;
    const pendPools = [
      `I have got your preference at ${d} ${tm}; the office still confirms timing. Anything else to add meanwhile?`,
      `${d} at ${tm} is what you asked for—we will confirm from the office. Anything else you would like captured?`,
      `Noted for ${d} around ${tm} pending confirmation—anything else for the team?`,
      `Anything else before we wrap, while we wait on confirming ${d} at ${tm}?`
    ];
    const pi = nextPromptIndex(caller, "finalSubmissionPitchPendingSched");
    return pendPools[pi % pendPools.length];
  }

  const defaultPools = [
    "Anything else you want passed along before we wrap up?",
    "Is there something else you would like noted while we have still got a moment?",
    "Need me to squeeze in anything else—otherwise someone from the office follows up shortly.",
    "Anything else on your mind today, or are we good to close this out?",
    "If nothing else jumps out, we will hand this off—is there anything else I can grab for you?"
  ];
  const di = nextPromptIndex(caller, "finalSubmissionPitchDefault");
  return defaultPools[di % defaultPools.length];
}












function buildFinalSubmissionClose(caller) {
  const pools = [
    "Thanks again for calling Blue Caller Automation—we will pick it up from here. Have a great rest of your day. Goodbye.",
    "Really appreciate you calling Blue Caller Automation. Enjoy the rest of your day—we will follow up shortly. Goodbye.",
    "Thank you for calling Blue Caller Automation. That is all wrapped on my side; take care, and goodbye for now.",
    "Perfect—you are all set here at Blue Caller Automation. Thanks again, and have a great day. Goodbye.",
    "Thanks for reaching out to Blue Caller Automation today. Someone will be in touch—have a great rest of your day. Goodbye."
  ];
  const hi = nextPromptIndex(caller, "finalHangupFarewellIndex");
  return pools[hi % pools.length];
}




function buildDemoCloseMessage() {
  return "Thank you for trying out our demo. Feel free to visit our website at bluecallerautomation.com. And if you have any questions, just give us a call back at this number. We'll be happy to help.";
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

/**
 * Dispatch-line normalization + completeness (inline so `node server.js` never depends on a sibling file —
 * avoids MODULE_NOT_FOUND on hosts that copy only server.js).
 * `./address_validation.js` mirrors this for tests; keep both aligned when logic changes.
 */
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

const US_STATE_ABBREV_FOR_DISPATCH = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY",
]);

const US_STATE_FULL_SNIPPETS_FOR_DISPATCH = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
  "district of columbia","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota",
  "mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico",
  "new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island",
  "south carolina","south dakota","tennessee","texas","utah","vermont","virginia","washington",
  "washington dc","washington d c","west virginia","wisconsin","wyoming",
];

const US_STATE_FULL_SNIPPETS_LONGEST_FOR_DISPATCH = [...US_STATE_FULL_SNIPPETS_FOR_DISPATCH]
  .sort((a, b) => b.length - a.length);

function abbreviationIsStreetSuffixForDispatch(abbrUpper) {
  return ["ST","DR","RD","LN","AVE","BLVD","CT","PL","HWY","PKWY"].includes(abbrUpper);
}

function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasFullStateNearDispatchTail(safe) {
  const text = cleanForSpeech(safe || "").toLowerCase();
  if (!text) return false;
  return US_STATE_FULL_SNIPPETS_LONGEST_FOR_DISPATCH.some((stateName) => {
    const statePattern = escapeRegexLiteral(stateName).replace(/\s+/g, "\\s+");
    const re = new RegExp(
      `(?:^|[,\\s])${statePattern}(?:\\s*,?\\s*\\d{5}(?:-\\d{4})?|\\s*,?\\s*$)`,
      "i"
    );
    return re.test(text);
  });
}

function analyzeUsServiceAddressCompleteness(raw) {
  const working = normalizeAddressInput(raw || "");
  const missing = [];
  const safe = working;
  if (!safe || safe.length < 6) {
    return { ok: false, missing: ["street", "city", "state", "zip"], working };
  }

  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(safe);

  let hasStreet = dispatchLineHasStreetNumber(safe.trim());

  let hasStateAbbrev = false;
  const anchored = safe.trim();
  for (const abbr of US_STATE_ABBREV_FOR_DISPATCH) {
    if (abbreviationIsStreetSuffixForDispatch(abbr)) continue;
    const re = new RegExp(`(?:^|[,\\s])${abbr}(?:\\s|,|$|\\s{1,12}\\d{5})`, "i");
    if (re.test(anchored)) {
      hasStateAbbrev = true;
      break;
    }
  }

  const hasFullState = hasFullStateNearDispatchTail(safe);
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
      if (!(cityCand.length === 2 && US_STATE_ABBREV_FOR_DISPATCH.has(cityCand.toUpperCase())))
        hasCity = cityCand.length >= 2;
    } else if (/\b\d{5}\b/.test(tail) && containsAny(normalizedText(tail), US_STATE_FULL_SNIPPETS_FOR_DISPATCH)) {
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
        !US_STATE_FULL_SNIPPETS_FOR_DISPATCH.some((snip) => snip.replace(/\s+/g, "") === cityChunk.replace(/\s+/g, ""));
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














const SMALL_NUMBER_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS_WORDS = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];








function numberUnder100ToWords(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n < 0) return String(num || "");
  if (n < 20) return SMALL_NUMBER_WORDS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones ? `${TENS_WORDS[tens]}-${SMALL_NUMBER_WORDS[ones]}` : TENS_WORDS[tens];
}








function streetNumberToSpeech(numText) {
  const digits = String(numText || "").replace(/\D/g, "");
  if (!digits) return String(numText || "");
  if (digits.length === 3) {
    return `${numberUnder100ToWords(Number(digits.slice(0, 1)))} ${numberUnder100ToWords(Number(digits.slice(1)))}`;
  }
  // 4+ digits: digit-by-digit so 5402 is not heard as "542" (fifty-four two).
  return digits.split("").map((d) => SMALL_NUMBER_WORDS[Number(d)]).join(" ");
}








function parseAddressParts(address) {
  const safe = cleanForSpeech(address || "");
  if (!safe) return { streetLine: "", city: "" };
  const parts = safe.split(",").map((p) => cleanForSpeech(p)).filter(Boolean);
  const streetLine = parts[0] || safe;
  const city = parts[1] || "";
  return { streetLine, city };
}








function formatAddressForSpeech(address) {
  const { streetLine, city } = parseAddressParts(address);
  if (!streetLine) return "";








  const streetSpeech = streetLine.replace(/^(\d{1,6})(\s+.+)$/, (m, num, rest) => `${streetNumberToSpeech(num)} ${rest}`);
  return city ? `${streetSpeech} in ${city}` : streetSpeech;
}


function formatAddressForConfirmation(address) {
  const safe = cleanForSpeech(address || "");
  if (!safe) return "";

  const isStateOrZipPart = (value) => {
    const part = cleanForSpeech(value || "");
    if (!part) return false;
    if (/^\d{5}(?:-\d{4})?$/i.test(part)) return true;
    return /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)(?:\s+\d{5}(?:-\d{4})?)?$/i.test(part);
  };

  const stripTrailingStateZip = (value) => cleanForSpeech(value || "")
    .replace(/,?\s+(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\s+\d{5}(?:-\d{4})?$/i, "")
    .replace(/,?\s+(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)$/i, "")
    .replace(/,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i, "")
    .replace(/,?\s+[A-Z]{2}$/i, "")
    .replace(/\s+\d{5}(?:-\d{4})?$/i, "")
    .trim();

  const rawParts = safe.split(",").map((p) => cleanForSpeech(p)).filter(Boolean);
  if (rawParts.length >= 2) {
    const normalizedParts = rawParts.map((part) => stripTrailingStateZip(part)).filter(Boolean);
    const streetLine = normalizedParts.find((part) => /\d/.test(part)) || normalizedParts[0] || "";
    const city = normalizedParts.find((part) => part !== streetLine && !isStateOrZipPart(part)) || "";
    return formatAddressForSpeech(city ? `${streetLine}, ${city}` : streetLine);
  }

  return formatAddressForSpeech(stripTrailingStateZip(safe));
}










function isBrowserCaller(caller) {
  const phone = cleanForSpeech(caller && caller.phone ? caller.phone : "");
  return !phone || /^client:/i.test(phone) || phone === "browser-user";
}








function buildBrowserCallbackPrompt() {
  return "Can I get your best contact number?";
}








function getPhoneCollectionStep(caller) {
  return isBrowserCaller(caller) ? "get_new_phone" : "confirm_phone";
}

function callerHasReachablePhoneDigits(caller) {
  const d = extractPhoneDigits(String(caller.callbackNumber || caller.phone || ""));
  if (!d) return false;
  if (d.length === 11 && d.startsWith("1")) return true;
  return d.length === 10;
}

function resolvePhoneIntakeStep(caller) {
  if (callerHasReachablePhoneDigits(caller)) return "confirm_phone";
  return getPhoneCollectionStep(caller);
}

function buildPhoneIntakePromptFragment(caller) {
  if (callerHasReachablePhoneDigits(caller)) {
    return `Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`;
  }
  return isBrowserCaller(caller) ? buildBrowserCallbackPrompt() : `Is ${formatPhoneNumberForSpeech(caller.phone)} a good number to reach you?`;
}

function tryHarvestPhoneFromUtterance(caller, rawText) {
  const digits = extractPhoneDigits(rawText || "");
  if (!digits) return false;
  const phone10 = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (phone10.length !== 10) return false;
  caller.callbackNumber = normalizePhoneForStorage(phone10);
  return true;
}

function sliceOpeningHeadBeforeIssueClause(raw) {
  const safe = cleanForSpeech(raw || "");
  if (!safe) return "";
  const lower = safe.toLowerCase();
  const needles = [
    ", and i need ", ", and i've got ", ", and ive got ", ", and i have ",
    ", i need ", " and i need ", " and i have ", " and i've got ", " and ive got ",
    " i need someone ", " i need somebody ", " i need to ",
    " calling about ", " calling regarding "
  ];
  let cut = -1;
  for (const n of needles) {
    const idx = lower.indexOf(n);
    if (idx >= 0 && (cut < 0 || idx < cut)) cut = idx;
  }
  if (cut < 0) return safe;
  return safe.slice(0, cut).trim().replace(/[,.]+$/g, "");
}

function tryExtractAddressAfterAtClause(head) {
  const t = cleanForSpeech(head || "");
  if (!t) return "";
  const m = t.match(/\b(?:at|@)\s+(\d{1,6}\s+.+)$/i);
  if (!m) return "";
  let addr = cleanForSpeech(m[1]).replace(/[,.]+$/g, "");
  if (!addr || !/\d/.test(addr)) return "";
  const n = normalizedText(addr);
  const hasStreetType = containsAny(n, [
    "street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "dr",
    "boulevard", "blvd", "court", "ct", "circle", "cir", "way", "highway", "hwy",
    "parkway", "pkwy", "route", "place", "pl"
  ]);
  const hasInCity = /\s+in\s+[a-z]/i.test(addr);
  if (!hasStreetType && !hasInCity) return "";
  addr = addr.replace(/\s+in\s+([a-z][a-z'\-\s]*)$/i, ", $1");
  return normalizeAddressInput(addr);
}

function describeMissingAddressFacets(missingKeys) {
  const labels = {
    street: "the street number and name",
    city: "the city",
    state: "the state",
    zip: "the ZIP code"
  };
  const keys = [...new Set(missingKeys || [])];
  const parts = keys.map((k) => labels[k] || k).filter(Boolean);
  if (parts.length === 0) return "a bit more of the address";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function buildIncompleteAddressPrompt(caller, missingKeys) {
  const detail = describeMissingAddressFacets(missingKeys);
  const ix = caller ? nextPromptIndex(caller, "incompleteAddressPromptIx") : 0;
  const pools = [
    `I still need ${detail}.`,
    `Could you give me ${detail}?`,
    `I'm missing ${detail}—what should I put there?`,
  ];
  return pools[ix % pools.length];
}

function callerHasCompleteUsServiceAddress(caller) {
  return analyzeUsServiceAddressCompleteness(caller.address || "").ok;
}

function callerHasHarvestableServiceAddress(caller) {
  const a = cleanForSpeech(caller.address || "");
  return Boolean(a && a.length >= 10 && /\d/.test(a));
}

function tryHarvestAddressFromUtterance(caller, rawText) {
  if (cleanForSpeech(caller.address || "").length >= 12) return false;
  const head = sliceOpeningHeadBeforeIssueClause(rawText);
  if (!head) return false;
  const extracted = tryExtractAddressAfterAtClause(head);
  if (!extracted) return false;
  caller.address = extracted;
  return true;
}








const SPOKEN_PHONE_DIGIT_MAP = {
  zero: "0", oh: "0", o: "0",
  one: "1",
  two: "2", too: "2", to: "2",
  three: "3",
  four: "4", for: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8", ate: "8",
  nine: "9"
};








/**
 * When the caller mistakenly starts with their address during phone capture and then clarifies ("sorry, I meant…"),
 * keep the corrective tail only so numeric runs are not blindly concatenated across the whole utterance.
 */
function extractPhoneCorrectionFocusTail(raw) {
  const s = cleanForSpeech(raw || "");
  if (!s || s.length < 5) return "";

  let bestStrong = -1;
  function bumpStrong(re) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const end = m.index + m[0].length;
      if (end > bestStrong) bestStrong = end;
    }
  }

  bumpStrong(/\bmeant\s+to\s+(?:say|give)\b/gi);
  bumpStrong(/\bi\s+meant\b/gi);
  bumpStrong(/\bsorry\b[\s\S]{0,160}?\bmeant\b/gi);
  bumpStrong(/\bthat(?:'|\u2019)s\s+(?:my\s+|the\s+)?address\b/gi);
  bumpStrong(/\bthat\s+s\s+(?:my\s+|the\s+)?address\b/gi);
  bumpStrong(/\bthat\s+was\s+(?:my\s+|the\s+)?address\b/gi);
  bumpStrong(/\bnot\s+(?:my\s+|the\s+)?address\b/gi);
  bumpStrong(/\bcorrection\b/gi);
  bumpStrong(/\bwrong\s+(?:number|phone|callback)\b/gi);

  if (bestStrong >= 0) {
    const t = s.slice(bestStrong).trim();
    return t || s;
  }

  let bestWeakEnd = -1;
  function tailLooksLikeDigitsOrSpelledNumber(tail) {
    const x = tail.trim();
    if (!x || x.length < 3) return false;
    if (/^(yeah|yes|no|nah|yep|nope|okay|sure|correct|that\s+|thats\b)/i.test(x)) return false;
    return /\d/.test(x) || /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i.test(x);
  }

  const weakRes = /\b(?:actually|instead)\b/gi;
  weakRes.lastIndex = 0;
  let wm;
  while ((wm = weakRes.exec(s)) !== null) {
    const tail = s.slice(wm.index + wm[0].length).trim();
    if (!tailLooksLikeDigitsOrSpelledNumber(tail)) continue;
    const end = wm.index + wm[0].length;
    if (end > bestWeakEnd) bestWeakEnd = end;
  }

  if (bestWeakEnd >= 0) {
    const t = s.slice(bestWeakEnd).trim();
    if (t) return t;
  }
  return s;
}

/** True when substring has common street-ish tokens (paired with glued digit strings to skip naive merges). */
function looksLexicallyLikeAddressFragmentNearDigits(raw) {
  const it = normalizeIntentText(raw || "");
  if (!it || !/\d/.test(raw || "")) return false;
  return containsAny(it, [
    "street",
    "st",
    "road",
    "rd",
    "avenue",
    "ave",
    "drive",
    "dr",
    "lane",
    "ln",
    "boulevard",
    "blvd",
    "court",
    "circle",
    "way",
    "highway",
    "hwy",
    "suite",
    "unit",
    "apartment",
    "apt",
    "lake",
    "address",
    "po box",
    "pobox"
  ]);
}

function extractPhoneDigitsFromSpokenTokensOnly(raw) {
  const rawClean = cleanForSpeech(raw || "");
  if (!rawClean) return "";

  const fillerWords = new Set([
    "my",
    "callback",
    "number",
    "is",
    "it",
    "s",
    "its",
    "the",
    "best",
    "good",
    "reach",
    "me",
    "at",
    "can",
    "you",
    "use",
    "to",
    "call",
    "back",
    "phone",
    "cell",
    "home",
    "office",
    "area",
    "code",
    "sorry",
    "meant",
    "actually",
    "instead",
    "wait",
    "no",
    "yes",
    "yeah",
    "correction",
    "address",
    "i"
  ]);

  const tokens = normalizeIntentText(rawClean)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !fillerWords.has(token));

  if (!tokens.length) return "";

  let digits = "";
  let recognizedCount = 0;
  for (const token of tokens) {
    if (SPOKEN_PHONE_DIGIT_MAP[token]) {
      digits += SPOKEN_PHONE_DIGIT_MAP[token];
      recognizedCount += 1;
      continue;
    }
    if (/^\d+$/.test(token)) {
      digits += token;
      recognizedCount += token.length;
      continue;
    }
    return "";
  }

  return recognizedCount >= 7 ? digits : "";
}

/** Prefer separated digit groups (street number … phone) or NANP-ish tail of a glued run; no whole-utterance digit merge here. */
function canonicalNanpDigitRunFromSegment(seg) {
  const raw = cleanForSpeech(seg || "");
  if (!raw) return "";

  const runs = raw.split(/\D+/).filter((p) => /^\d+$/.test(p) && p.length > 0);
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.length === 11 && r.startsWith("1")) return r.slice(1);
    if (r.length === 10) return r;
  }

  if (runs.length === 1) {
    const r = runs[0];
    if (r.length === 11 && r.startsWith("1")) return r.slice(1);
    if (r.length === 10) return r;
    if (r.length >= 12 && r.length <= 15) return r.slice(-10);
  }

  const spokenDigitBlock = extractPhoneDigitsFromSpokenTokensOnly(seg);
  if (!spokenDigitBlock) return "";

  let d = spokenDigitBlock.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length === 10) return d;
  return "";
}

function extractPhoneDigits(text) {
  const raw = cleanForSpeech(text || "");
  if (!raw) return "";

  const focused = extractPhoneCorrectionFocusTail(raw);
  const segments = [];
  const seen = new Set();
  const pushSeg = (s) => {
    const key = normalizedText(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    segments.push(s);
  };

  pushSeg(raw);
  if (normalizedText(focused) !== normalizedText(raw)) {
    segments.unshift(focused);
  }

  let canonicalTen = "";
  for (const seg of segments) {
    const c = canonicalNanpDigitRunFromSegment(seg);
    if (c.length === 10) {
      canonicalTen = c;
      break;
    }
  }
  if (canonicalTen.length === 10) return canonicalTen;

  for (const seg of segments) {
    const spoken = extractPhoneDigitsFromSpokenTokensOnly(seg);
    if (!spoken || spoken.length < 7) continue;
    let d = spoken.replace(/\D/g, "");
    if (!d.length) continue;
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    if (d.length >= 7) return d;
  }

  const numericDigits = raw.replace(/\D/g, "");
  const correctedFocusApplied = normalizedText(focused) !== normalizedText(raw);

  if (numericDigits.length >= 7 && numericDigits.length <= 11) return numericDigits;

  const tailCanon = canonicalNanpDigitRunFromSegment(focused);
  if (tailCanon.length === 10) return tailCanon;

  if (
    numericDigits.length >= 12 &&
    numericDigits.length <= 15 &&
    (!looksLexicallyLikeAddressFragmentNearDigits(raw) || correctedFocusApplied)
  ) {
    return numericDigits.slice(-10);
  }

  const tailSpoken = extractPhoneDigitsFromSpokenTokensOnly(focused);
  if (tailSpoken.length >= 7) {
    let d = tailSpoken.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    return d;
  }

  return "";
}








function isLikelyPhoneNumberResponse(text) {
  return extractPhoneDigits(text).length >= 7;
}








function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.substring(1);
  const toWord = (d) => {
    const n = Number(d);
    return Number.isFinite(n) ? SMALL_NUMBER_WORDS[n] : d;
  };
  if (digits.length === 10) {
    const a = digits.slice(0, 3).split("").map(toWord).join(" ");
    const b = digits.slice(3, 6).split("").map(toWord).join(" ");
    const c = digits.slice(6).split("").map(toWord).join(" ");
    return `${a}, ${b}, ${c}`;
  }
  return digits.split("").map(toWord).join(" ");
}








function isAffirmative(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (containsAny(t, ["not an emergency", "not emergency", "non emergency", "nonemergency", "not urgent"])) return false;
  if (isNegative(t)) return false;








  const directYes = new Set([
    "yes", "yeah", "yea", "yep", "yup", "sure", "for sure", "ok", "okay", "absolutely", "definitely", "correct",
    "fine", "works", "that works", "that will work", "thatll work", "that is okay", "thats okay",
    "that is fine", "thats fine", "all right", "alright", "it is", "it is correct", "its correct",
    "that is correct", "thats correct", "that is right", "thats right",
    "yes sir", "yes ma am", "yessir", "you bet", "indeed", "affirmative", "correct that"
  ]);
  if (directYes.has(t)) return true;








  if (/\bthat\s+(works|will work|should work|will be fine|should be fine|is fine|is okay|is ok|is good|is great|is correct|is right)\b/.test(t)) return true;
  if (/\bit\s+(is|s)\s+(correct|right)\b/.test(t)) return true;
  if (/^it\s+is\s+(yes|yeah|yep|yup|correct|right)$/i.test(t)) return true;
  if (/^that\s+(is|s)\s+(yes|yeah|yep|yup|correct|right)$/i.test(t)) return true;
  if (/^(yes|yeah|yep|yup|correct|absolutely|ok|okay)\b.*\b(correct|right|works|work)\b/.test(t)) return true;
  if (/\b(i|we)\s+(ll|will)\s+take\s+(it|that)\b/.test(t)) return true;
  if (/\b(go ahead|please do|do that|book it|schedule it|book that|schedule that)\b/.test(t)) return true;








  return containsAny(t, [
    "yes please", "yeah please", "sounds good", "sounds great", "sounds fine", "sounds okay",
    "lets do that", "let s do that", "mark this as an emergency", "make this an emergency",
    "this is an emergency", "it is an emergency", "its an emergency",
    "yeah have someone call me", "have someone call me", "have somebody call me",
    "whatever works", "that sounds good", "that sounds fine", "that sounds okay",
    "that date works", "the date works", "that time works", "the time works", "that should work for me",
    "sure that works", "sure that is fine", "sure that s fine", "fine by me", "okay that works",
    "that is good", "that s good", "thatll do", "that ll do", "fine with me", "works for me",
    "go ahead and do that", "go ahead and book it", "go ahead and schedule it", "ill take that", "i ll take that",
    "ill take it", "i ll take it", "that should be okay", "that should be fine",
    "yeah that ll work", "yeah thatll work", "yes that ll work", "yes thatll work",
    "yeah that is correct", "yeah thats correct", "yes that is correct", "yes thats correct",
    "we d better add one", "wed better add one", "better add one", "let s add one", "lets add one",
    "i ll give it to you", "ill give it to you", "add one", "yes add one", "yeah add one",
    "let me know when you re ready and i ll give it to you", "let me know when youre ready and ill give it to you",
    "okay let me know when you re ready and i ll give it to you", "okay let me know when youre ready and ill give it to you",
    "yeah we better add that", "we better add that", "yeah let s add one", "yeah lets add one",
    "yeah let s add that", "yeah lets add that", "let s add that", "lets add that",
    "okay i ll give it to you", "okay ill give it to you", "yes i ll give it to you", "yes ill give it to you",
    "okay let me know when you re ready and i ll give it to you", "okay let me know when youre ready and ill give it to you",
    "yeah wed better", "yes wed better", "yep wed better", "sure wed better", "we d better add",
    "might as well add", "might as well include", "probably should add"
  ]);
}








function isNegative(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;

  const loneWordNegatives = new Set([
    "no", "nope", "nah", "naw", "nay", "nyet",
    "negative", "negatory",
    "skip", "pass", "nada",
    "uhuh", "uh uh", "nuhuh", "nuh uh", "unuh", "un uh"
  ]);
  if (loneWordNegatives.has(t)) return true;
  if (/^(no|nope|nah|naw|negative)\b/.test(t)) return true;

  return containsAny(t, [
    "no thanks", "no thank you", "thanks no",
    "not now", "not really", "dont", "do not",
    "not at all",
    "nah im good", "nah i m good", "nah were good", "nah we re good",
    "nope were good", "nope we re good", "nope i m good", "nah we re all good", "nope we re all good",
    "not an emergency", "not emergency", "non emergency", "nonemergency", "not urgent",
    "standard service", "normal service", "regular service", "something else", "another time", "different time",
    "that s not necessary", "thats not necessary", "that is not necessary",
    "that s not needed", "thats not needed", "that is not needed",
    "that won t be necessary", "that wont be necessary", "that will not be necessary",
    "never mind", "nevermind", "never mind thanks",
    "forget it",
    "i don t think so", "i dont think so", "i do not think so", "i don t need that", "i dont need that", "i do not need that",
    "rather not",
    "no way",
    "absolutely not",
    "definitely not",
    "i ll pass", "ill pass",
    "not interested"
  ]);
}
















function isUseSameContactInfo(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (containsAny(t, [
    "use the same", "use same", "same info", "same information", "same contact info",
    "same contact information", "same as the demo", "same as demo",
    "same as i already gave you", "same as what i already gave you",
    "use what i already gave you", "use what i gave you",
    "use the contact information you already have", "use the information you already have",
    "use the previous contact information", "use the info from the demo", "the same as the demo"
  ])) return true;
  return /^(yes|yeah|yep|sure)\b.*\bsame\b/.test(t) || /^(no|nope|nah)\b.*\bsame\b/.test(t);
}




function isDemoFollowupAcceptance(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (isAffirmative(text)) return true;
  return containsAny(t, [
    "that sounds like a good idea", "sounds like a good idea",
    "yeah that sounds like a good idea", "yes that sounds like a good idea",
    "why don t we do that", "why dont we do that",
    "yeah why don t we do that", "yeah why dont we do that",
    "let s do that", "lets do that",
    "yeah let s do that", "yeah lets do that",
    "i d like to talk to someone", "id like to talk to someone",
    "i would like to talk to someone",
    "yeah i d like to talk to someone", "yeah id like to talk to someone",
    "have someone call me about the demo", "have somebody call me about the demo",
    "i d like someone to call me", "id like someone to call me"
  ]);
}




function isCallbackNumberChangeIntent(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (isLikelyPhoneNumberResponse(text)) return false;
  return containsAny(t, [
    "change my contact number", "change the contact number",
    "change my callback number", "change the callback number",
    "change my phone number", "change the phone number",
    "update my contact number", "update the contact number",
    "update my callback number", "update the callback number",
    "update my phone number", "update the phone number",
    "use a different number", "use another number",
    "use my wife s number", "use my wifes number",
    "use my husband s number", "use my husbands number",
    "use my wife because", "use my husband because",
    "my wife s number instead", "my wifes number instead",
    "my husband s number instead", "my husbands number instead",
    "change it to my wife s", "change it to my wifes",
    "change it to my husband s", "change it to my husbands",
    "i need to change my number", "i need to change the number",
    "i need to change my contact number", "i need to change my callback number",
    "different callback number", "new callback number",
    "different contact number", "new contact number"
  ]);
}




function isKeepSameContactPerson(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return containsAny(t, [
    "same person", "same contact", "keep me", "keep it the same",
    "keep the same contact", "keep the contact the same",
    "same name", "just keep me as the contact", "it can stay the same"
  ]);
}




function isChangeContactPersonIntent(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return containsAny(t, [
    "change that too", "change the contact person", "change the contact",
    "use my wife", "use my husband", "use her", "use him",
    "make her the contact", "make him the contact",
    "change the name", "update the contact person", "update the contact",
    "i d like to change", "id like to change", "i d like to change it", "like to change it",
    "change it to", "switch it to", "update it to"
  ]);
}

/** Caller is declining a contact update ("don't change my contact…") so we should not hijack the turn. */
function isNegatedMidCallContactUpdateRequest(text) {
  const t = normalizeIntentText(text || "");
  if (!t) return false;
  return (
    /\b(don t|dont|do not)\s+change\s+(?:my|the|it|that)\s+contact\b/.test(t) ||
    /\b(don t|dont|do not)\s+update\s+(?:my|the|it|that)\s+contact\b/.test(t) ||
    /\b(don t|dont|do not)\s+want\s+to\s+(?:change|update)\s+(?:my|the)\s+contact\b/.test(t)
  );
}

/**
 * After main intake, route correction intents back to capture_updated_callback_number (and optional name),
 * including generic "contact info" wording — not only explicit callback/phone phrases.
 */
function isPostIntakeContactUpdateIntent(text) {
  if (isNegatedMidCallContactUpdateRequest(text)) return false;
  if (isCallbackNumberChangeIntent(text)) return true;
  const t = normalizeIntentText(text || "");
  if (!t) return false;
  if (containsAny(t, [
    "change my contact info", "change the contact info", "change contact info",
    "update my contact info", "update the contact info", "update contact info",
    "change my contact information", "change the contact information", "change contact information",
    "update my contact information", "update the contact information", "update contact information",
    "i want to change my contact", "i need to change my contact",
    "i want to update my contact", "i need to update my contact",
    "wrong contact info", "wrong contact information", "incorrect contact info"
  ])) return true;
  return isChangeContactPersonIntent(text);
}




function extractUpdatedContactNameFromSpeech(text) {
  const safe = cleanForSpeech(text || "");
  if (!safe) return "";

  const rawSpouse = safe.match(/(?:my\s+wife|my\s+husband)\s+([A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2})\b/i);
  if (rawSpouse) {
    const spouseCandidate = parseFullNameFromSpeech(rawSpouse[1]);
    if (spouseCandidate) return spouseCandidate;
  }

  const rawNamed = safe.match(/(?:her|his)\s+name\s+is\s+([A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2})\b/i);
  if (rawNamed) {
    const namedCandidate = parseFullNameFromSpeech(rawNamed[1]);
    if (namedCandidate) return namedCandidate;
  }

  const lowerSafe = safe.toLowerCase();
  const soundsLikeContactRename =
    /\b(change|update|switch|contact|name|person|callback|phone)\b/.test(lowerSafe);

  const explicitToName = safe.match(
    /(?:change|switch|update)\s+(?:it|that|my\s+contact|the\s+contact(?:\s+person)?|the\s+name|the\s+contact\s+name)\s+to\s+([A-Za-z' -]+(?:\s+[A-Za-z' -]+){0,3})/i
  );
  if (explicitToName) {
    const candidate = parseFullNameFromSpeech(explicitToName[1].replace(/[.,!?]+$/g, "").trim());
    if (candidate) return candidate;
  }

  const gluedToName = safe.match(/\b(?:change|switch|update)\s*it\s*to\s+([A-Za-z' -]+(?:\s+[A-Za-z' -]+){0,3})/i);
  if (gluedToName) {
    const candidate = parseFullNameFromSpeech(gluedToName[1].replace(/[.,!?]+$/g, "").trim());
    if (candidate) return candidate;
  }

  if (soundsLikeContactRename) {
    const segments = safe.split(/\s+to\s+/i);
    if (segments.length >= 2) {
      const rhs = segments[segments.length - 1].replace(/[.,!?]+$/g, "").trim();
      if (rhs && !/^(the|a|an)\s+/i.test(rhs)) {
        const candidate = parseFullNameFromSpeech(rhs);
        if (candidate) return candidate;
      }
    }
  }

  let stripped = safe
    .replace(/^(no|nope|nah)\s*,?\s*/i, "")
    .replace(/^(yes|yeah|yep|yup)\s*,?\s*/i, "")
    .replace(/\bi['']?d\s+like\s+to\s+/i, "")
    .replace(/\bi\s+would\s+like\s+to\s+/i, "")
    .replace(/^(?:can|could|would)\s+you\s+(?:switch|change|update)\s+(?:it|that|the\s+contact(?:\s+person)?|the\s+name)?\s*(?:to|for)\s+/i, "")
    .replace(/^(please\s+)?(?:switch|change|update)\s+(?:that\s+too|the\s+contact(?:\s+person)?|the\s+name|the\s+contact\s+name)?\s*(?:to|for)\s+/i, "")
    .replace(/^(?:change|update|switch)\s+(?:it|that)\s+to\s+/i, "")
    .replace(/\b(?:change|update|switch)\s*it\s*to\s+/gi, " ")
    .replace(/\bchangeto\b/gi, " ")
    .replace(/^(?:use|make)\s+/i, "")
    .replace(/^(?:my\s+wife(?:'s)?|my\s+husband(?:'s)?|my\s+wife|my\s+husband)\s+name\s+is\s+/i, "")
    .replace(/^(?:my\s+wife(?:'s)?|my\s+husband(?:'s)?|my\s+wife|my\s+husband)\s+/i, "")
    .replace(/^(?:her|him|his)\s+name\s+is\s+/i, "")
    .replace(/^(?:it's|it is)\s+/i, "")
    .trim();

  let parsed = parseFullNameFromSpeech(stripped);
  if (parsed) return parsed;

  stripped = stripped
    .replace(/\b(?:yes|yeah|yep|like|to|change|it|that|contact|update|switch|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  parsed = parseFullNameFromSpeech(stripped);
  if (parsed) return parsed;

  const direct = stripped.match(/^([A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2})\b/);
  if (direct) {
    const candidate = parseFullNameFromSpeech(direct[1]);
    if (candidate) return candidate;
  }

  return "";
}


function extractLastNameFromFullName(name) {
  const parts = cleanForSpeech(name || "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return "";
  return parts.slice(1).join(" ");
}


function clearPendingUpdatedContactName(caller) {
  caller.pendingUpdatedContactFirstName = "";
  caller.pendingUpdatedContactFullName = "";
}

function isDemoFollowupContactStep(step = "") {
  return new Set([
    "confirm_demo_followup_info",
    "ask_demo_followup_contact_name",
    "ask_demo_followup_phone",
    "ask_demo_followup_email_optional",
    "capture_demo_followup_email"
  ]).has(step);
}

function afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated = false } = {}) {
  const resume = caller.resumeStepAfterPhoneUpdate || "";
  caller.resumeStepAfterPhoneUpdate = "";

  const updateLine = nameAlsoUpdated
    ? "Got it. I've updated the callback number and contact name."
    : "Got it. I've updated the callback number.";

  if (resume && resume !== "ask_notes") {
    caller.lastStep = resume;
    if (resume === "confirm_demo_followup_info") {
      sendText(ws, `${updateLine} Should I use the contact information you already gave me?`);
      return;
    }
    if (isDemoFollowupContactStep(resume) || resume === "offer_demo_followup" || resume === "final_question") {
      const followUp =
        resume === "final_question"
          ? buildFinalSubmissionPrompt(caller)
          : buildResumePromptForCurrentStep(caller) || "How else can I help?";
      sendText(ws, `${updateLine} ${followUp}`);
      return;
    }
  }

  caller.lastStep = "ask_notes";
  sendText(ws, `${updateLine} ${buildTechnicianNotesPrompt(caller)}`);
}




function isSameLastNameResponse(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return containsAny(t, [
    "same", "same last name", "same last", "same as mine", "same as the current contact",
    "same as before", "same as me", "same as my last name"
  ]);
}




function isEmailAddAcceptance(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (wantsOptionalEmail(text)) return true;
  return containsAny(t, [
    "yes let s do that", "yes lets do that", "yeah let s do that", "yeah lets do that",
    "yes we better do that", "yeah we better do that", "we better do that",
    "yes let s add that", "yes lets add that", "yeah let s add that", "yeah lets add that",
    "yes let s add an email", "yes lets add an email", "yeah let s add an email", "yeah lets add an email",
    "yes add an email", "yeah add an email", "let s add an email", "lets add an email",
    "yes let s add one", "yes lets add one", "yeah let s add one", "yeah lets add one",
    "yes let s add a number", "yes lets add a number", "yeah let s add a number", "yeah lets add a number",
    "add that", "add one", "do that", "let s do it", "lets do it",
    "yeah wed better", "yes wed better"
  ]);
}




function isRepeatRequest(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return containsAny(t, [
    "what was that", "what did you say", "say that again", "can you say that again",
    "repeat that", "can you repeat that", "i missed that", "i didn t catch that",
    "i didnt catch that", "i m sorry what was that", "im sorry what was that",
    "i m sorry can you repeat that", "im sorry can you repeat that", "repeat the number",
    "repeat the address", "repeat the time", "what was the number", "what was the address",
    "what was the time", "can you repeat the number", "can you repeat the address",
    "can you repeat the time"
  ]);
}








function isAddressConfirmation(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return containsAny(t, [
    "that s it", "thats it", "that is it",
    "that s correct", "thats correct", "that is correct",
    "that s right", "thats right", "that is right",
    "yep that s it", "yep thats it", "yeah that s it", "yeah thats it",
    "yes that s it", "yes thats it", "yup that s it", "yup thats it",
    "that looks right", "that sounds right", "that is the one", "that s the one", "thats the one"
  ]);
}








function lowercaseFirst(value) {
  const safe = String(value || "").trim();
  if (!safe) return "";
  return safe.charAt(0).toLowerCase() + safe.slice(1);
}








function parseLastNameResponse(text) {
  const safe = cleanForSpeech(text || "")
    .replace(/^my last name is\s+/i, "")
    .replace(/^it(?: is|'s)?\s+/i, "")
    .trim();
  if (!safe) return "";








  const direct = safe.match(/^([A-Za-z'-]+)(?:\s*,?\s*(?:[A-Za-z][\s-]*){2,})?$/);
  if (direct) return toTitleCase(direct[1]);








  const lettersOnly = safe.replace(/[^A-Za-z]/g, "");
  if (lettersOnly.length >= 2 && lettersOnly.length <= 20) return toTitleCase(lettersOnly);








  const firstWord = safe.match(/^([A-Za-z'-]+)/);
  if (firstWord) return toTitleCase(firstWord[1]);








  return "";
}








function buildRepeatPrompt(caller) {
  const prompt = cleanForSpeech(caller.pendingPromptText || "");
  if (!prompt) return "";








  const lowered = lowercaseFirst(prompt);
  const questionLike = /^(is|are|was|were|can|could|would|will|do|does|did|have|has|had)\b/i.test(prompt);
  const repeated = questionLike ? `if ${lowered}` : lowered;








  const variants = [
    `Oh, yeah, I'm sorry — I was asking ${repeated}`,
    `Certainly — I was asking ${repeated}`,
    `I'm sorry about that — I was asking ${repeated}`
  ];
  const index = nextPromptIndex(caller, "repeatPromptIndex");
  return variants[index % variants.length];
}

function stripSocialLeadIn(text) {
  let safe = cleanSpeechText(text || "");
  if (!safe) return "";

  safe = safe
    .replace(/^(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)\s*,?\s*alex\s*[,.!? -]*/i, "")
    .replace(/^(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)\s*[,.!? -]*/i, "")
    .replace(/^(?:how are you(?: doing)?|how are doing|how're you(?: doing)?|how are ya|how ya doing|how ya doin|how you doing|how you doin|howya doing|howya doin|how ya been|how you been|how have you been)(?:\s+(?:today|tonight|this morning|this afternoon|this evening))?\s*,?\s*(?:alex)?\s*[,.!? -]*/i, "")
    .replace(/^(?:alex)\s*[,.!? -]*/i, "")
    .trim();

  return safe;
}

function isHowAreYouOnly(text) {
  if (!hasSocialOpenerPhrase(text)) return false;

  const stripped = stripSocialLeadIn(text);
  if (!stripped) return true;
  if (/^(alex)$/i.test(cleanForSpeech(stripped))) return true;
  if (looksLikeIssueText(stripped)) return false;
  return hasSocialOpenerPhrase(stripped);
}

function isShortCourtesyResponse(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return new Set([
    "thank you", "thanks", "thank you alex", "thanks alex", "okay thank you", "ok thank you",
    "alright thank you", "all right thank you", "appreciate it", "i appreciate it", "thank you so much",
    "thanks so much", "much appreciated"
  ]).has(t);
}

function buildResumePromptForCurrentStep(caller) {
  switch (caller.lastStep) {
    case "ask_issue":
    case "ask_issue_again":
      return "How can I help you today?";
    case "ask_name": {
      const variants = [
        "Can I start by getting your full name, please?",
        "To start, can I get your full name?",
        "Who should I list as the contact—full first and last name?"
      ];
      const i = nextPromptIndex(caller, "askNameResumePromptIndex");
      return variants[i % variants.length];
    }
    case "ask_first_name_spelling":
      return caller.firstName ? `I know ${caller.firstName} can be spelled a few different ways. How do you spell it?` : "How do you spell your first name?";
    case "ask_last_name":
      return "Can I get your last name as well?";
    case "ask_item_issue_detail":
      return caller.pendingIssuePrompt ? `What seems to be going on with ${caller.pendingIssuePrompt}?` : "What seems to be going on?";
    case "appliance_service_intake":
      return buildNextApplianceDetailQuestion(caller);
    case "leak_emergency_choice":
      return "Do you want me to mark this as an emergency?";
    case "refrigerator_emergency_choice":
      return "Do you want me to mark this as an emergency?";
    case "appliance_priority_choice":
      return "Would you like me to mark this as an emergency?";
    case "confirm_phone":
      return `Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`;
    case "get_new_phone":
      return isBrowserCaller(caller) ? buildBrowserCallbackPrompt() : "Can I get your best contact number?";
    case "capture_updated_callback_number":
      return "What is the best contact number to use instead?";
    case "confirm_contact_person_after_phone_change":
      return "Should the contact person stay the same, or would you like me to change that as well?";
    case "capture_updated_contact_name":
      return "What name should I use instead?";
    case "confirm_same_last_name_after_contact_change": {
      const existingLastName = extractLastNameFromFullName(caller.fullName || "");
      return existingLastName && caller.pendingUpdatedContactFirstName
        ? `Should I use ${caller.pendingUpdatedContactFirstName} ${existingLastName} as the contact name?`
        : "Should I use that as the contact name?";
    }
    case "capture_updated_contact_last_name":
      return caller.pendingUpdatedContactFirstName ? `What is ${caller.pendingUpdatedContactFirstName}'s last name?` : "What is the last name?";
    case "ask_address": {
      const chk = analyzeUsServiceAddressCompleteness(caller.address || "");
      if (!chk.ok && callerHasHarvestableServiceAddress(caller)) {
        return buildIncompleteAddressPrompt(caller, chk.missing);
      }
      return buildAddressRequestPrompt(caller);
    }
    case "confirm_address":
      return `Great, let me make sure I have this right. You said ${formatAddressForConfirmation(caller.address)}. Is that correct?`;
    case "schedule_or_callback":
      return buildSchedulingChoicePrompt(caller);
    case "ask_appointment_day":
      return "What day works best for you?";
    case "ask_appointment_time":
      return "What callback time works best for you?";
    case "confirm_first_available":
      return caller.pendingOfferedDate && caller.pendingOfferedTime ? buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime) : "Would you like me to schedule that callback?";
    case "late_day_preference_choice":
      return buildLateDayFallbackPrompt(caller);
    case "ask_notes":
      return buildTechnicianNotesPrompt(caller);
    case "offer_demo_followup":
      return "Would you like me to have one of our team members call you to discuss how this could help your company?";
    case "confirm_demo_followup_info":
      return "Should I use the contact information you already gave me?";
    case "ask_demo_followup_contact_name":
      return "What is a good contact name?";
    case "ask_demo_followup_phone":
      return "What about a phone number?";
    case "ask_demo_followup_email_optional":
    case "ask_demo_email_optional":
      return "Would you like to include an email address as well?";
    case "capture_demo_followup_email":
    case "capture_demo_email":
      return "Alright, go ahead and spell that out for me.";
    case "ask_project_timeline":
      return "What is the projected timeline or anticipated start date for this project?";
    case "ask_project_scope":
      return "Can you give me a quick idea of what all you'd like done?";
    case "ask_proposal_deadline":
      return "Is there a deadline you're working with for the estimate or proposal?";
    case "ask_quote_email_optional":
      return "Would you like to include an email address with this quote request as well?";
    case "capture_quote_email":
      return "Alright, go ahead and spell that out for me.";
    default:
      return "";
  }
}

function buildServiceIntakeLeadIn(caller) {
  const c = caller || {};
  const tone = c.alexEmotionalTone || "neutral";
  if (tone === "overwhelmed" || tone === "upset") {
    return "I'm here with you—I'll keep this simple. I just need a few details to make sure we get this right.";
  }
  if (tone === "urgent_stressed" || tone === "frustrated") {
    return "I'm going to keep this quick—I just need a few details so the team can jump on this.";
  }
  const neutrals = [
    "I'm here to help, so let's pick up a few details.",
    "Let me grab a few quick details so we're set up cleanly.",
    "I'll take down a few basics and we can line up the next step."
  ];
  const i = nextPromptIndex(caller, "serviceLeadInPromptIndex");
  return neutrals[i % neutrals.length];
}

function buildStandardIntakePrompt(caller) {
  if (caller.fullName) {
    if (hasFullName(caller.fullName)) {
      return `Thank you, ${caller.firstName}. ${buildIssueAcknowledgement(caller)} ${buildServiceIntakeLeadIn(caller)} ${buildPhoneIntakePromptFragment(caller)}`;
    }
    return `Thank you, ${caller.firstName}. ${buildIssueAcknowledgement(caller)} ${buildServiceIntakeLeadIn(caller)} Before I go any further, can I get your last name as well?`;
  }
  return `${buildIssueAcknowledgement(caller)} ${buildServiceIntakeLeadIn(caller)} Can I start by getting your full name, please?`;
}

function buildUrgentFlaggedLine() {
  return "Understood. I'll go ahead and flag this as urgent so the office knows you'd like to hear from someone as soon as possible.";
}

function isUrgentSelection(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (
    /\bnot\s+urgent\b/.test(t) ||
    /\bno\s+urgency\b/.test(t) ||
    /\bnothing\s+urgent\b/.test(t) ||
    containsAny(t, ["non urgent", "nonurgent", "not really urgent"])
  ) {
    return false;
  }
  return containsAny(t, [
    "urgent", "mark it as urgent", "mark this as urgent", "flag it as urgent",
    "flag this as urgent", "as soon as possible", "right away", "asap"
  ]) && !containsAny(t, ["emergency", "mark it as an emergency", "mark this as an emergency"]);
}

function isUrgentNonEmergencyRequest(text) {
  const t = normalizeIntentText(text);
  if (!t || isHardEmergency(text)) return false;
  if (containsAny(t, ["not an emergency", "not emergency", "non emergency", "nonemergency"])) {
    return containsAny(t, ["urgent", "right away", "as soon as possible", "asap", "today", "tomorrow", "soon as possible"]);
  }
  return containsAny(t, ["urgent", "as soon as possible", "asap", "right away"]) && !containsAny(t, ["not urgent"]);
}

function normalizedIssueHasFridgeCoolingProblem(t) {
  if (!containsAny(t, ["refrigerator", "fridge", "freezer"])) return false;
  return containsAny(t, [
    "not cooling", "isn't cooling", "isnt cooling", "wasn't cooling", "wasnt cooling",
    "not cool", "won't cool", "wont cool", "doesn't cool", "doesnt cool",
    "stopped cooling", "not staying cold", "won't stay cold", "wont stay cold",
    "not cold enough", "isn't cold", "isnt cold", "nothing feels cold",
    "too warm", "getting warm", "everything thaw", "stuff thaw", "food thaw",
    "not freezing", "isn't freezing", "isnt freezing", "stopped freezing"
  ]);
}

function isRefrigeratorEmergencyCandidate(issue) {
  const t = normalizedText(issue);
  return normalizedIssueHasFridgeCoolingProblem(t);
}

function isCookingAppliancePriorityCandidate(issue) {
  const t = normalizedText(issue);
  const cookingAppliance = containsAny(t, ["oven", "cooktop", "cook top", "range", "stove"]);
  const timingProblem = containsAny(t, [
    "not heating", "isn't heating", "isnt heating", "not turning on", "won't turn on", "wont turn on",
    "not igniting", "won't ignite", "wont ignite"
  ]);
  return cookingAppliance && timingProblem;
}

function buildRefrigeratorEmergencyPrompt(caller) {
  return `${buildIssueAcknowledgement(caller)} When you're losing refrigeration like that, spoilage can become a concern pretty fast—I know that's stressful. Would you like me to mark this as an emergency?`;
}

function buildCookingPriorityPrompt(caller) {
  return `${buildIssueAcknowledgement(caller)} Would you like me to mark this as an emergency?`;
}

function markUrgent(caller) {
  caller.emergencyAlert = false;
  caller.urgency = "urgent";
  caller.leadType = "service";
  caller.status = "new_lead";
}

function buildUrgentIntakePrompt(caller) {
  const acknowledgement = buildIssueAcknowledgement(caller);
  const withName = caller.firstName ? `${caller.firstName}, ` : "";
  const leadIn = `${withName}${acknowledgement} ${buildUrgentFlaggedLine()} I just need to get some information from you.`;

  if (caller.fullName) {
    if (hasFullName(caller.fullName)) {
      return `${leadIn} ${buildPhoneIntakePromptFragment(caller)}`;
    }
    return `${leadIn} Before I go any further, can I get your last name as well?`;
  }

  return `${acknowledgement} ${buildUrgentFlaggedLine()} I just need to get some information from you. Can I start by getting your full name, please?`;
}

function buildEmergencyIntakePromptAfterPriorAck(caller) {
  const withName = caller.firstName ? `${caller.firstName}, ` : "";
  const core = `${withName}I'm going to get this marked as an emergency so our service team can review it right away. I just need to get some information from you.`;
  if (caller.fullName) {
    if (hasFullName(caller.fullName)) return `${core.trim()} ${buildPhoneIntakePromptFragment(caller)}`;
    return `${core.trim()} Before I go any further, can I get your last name as well?`;
  }
  return `${core.trim()} Can I start by getting your full name, please?`;
}

function buildUrgentIntakePromptAfterPriorAck(caller) {
  const withName = caller.firstName ? `${caller.firstName}, ` : "";
  const core = `${withName}${buildUrgentFlaggedLine()} I just need to get some information from you.`;
  if (caller.fullName) {
    if (hasFullName(caller.fullName)) return `${core.trim()} ${buildPhoneIntakePromptFragment(caller)}`;
    return `${core.trim()} Before I go any further, can I get your last name as well?`;
  }
  return `${core.trim()} Can I start by getting your full name, please?`;
}

function buildStandardIntakePromptAfterPriorSeverityAck(caller) {
  const lead = buildServiceIntakeLeadIn(caller);
  if (caller.fullName) {
    if (hasFullName(caller.fullName)) {
      return `Thank you, ${caller.firstName}. Understood—we won't flag this as an emergency. ${lead} ${buildPhoneIntakePromptFragment(caller)}`;
    }
    return `Thank you, ${caller.firstName}. Understood—we won't flag this as an emergency. ${lead} Before I go any further, can I get your last name as well?`;
  }
  return `Understood—we won't flag this as an emergency. ${lead} Can I start by getting your full name, please?`;
}

function buildStandardIntakePromptAfterCookingPriorityAck(caller) {
  const lead = buildServiceIntakeLeadIn(caller);
  if (caller.fullName) {
    if (hasFullName(caller.fullName)) {
      return `Thank you, ${caller.firstName}. Got it—we'll treat this as a regular-priority visit. ${lead} ${buildPhoneIntakePromptFragment(caller)}`;
    }
    return `Thank you, ${caller.firstName}. Got it—we'll treat this as a regular-priority visit. ${lead} Before I go any further, can I get your last name as well?`;
  }
  return `Got it—we'll treat this as a regular-priority visit. ${lead} Can I start by getting your full name, please?`;
}

function buildStandardPostIssueSpellingPreamble(caller) {
  const ack = buildIssueAcknowledgement(caller);
  const lead = buildServiceIntakeLeadIn(caller);
  if (caller.firstName) return `Thank you, ${caller.firstName}. ${ack} ${lead}`.trim();
  return `${ack} ${lead}`.trim();
}

function buildUrgentPostIssueSpellingPreamble(caller) {
  const withName = caller.firstName ? `${caller.firstName}, ` : "";
  return `${withName}${buildIssueAcknowledgement(caller)} ${buildUrgentFlaggedLine()} I just need to get some information from you.`.trim();
}


















function isPhoneCorrection(text) {
  const t = normalizeIntentText(text);
  return (
    isNegative(t) ||
    containsAny(t, ["wrong number", "different number", "new number", "not that number", "thats not right", "that is not right", "incorrect"])
  );
}








function isSkipResponse(text) {
  const t = normalizeIntentText(text);
  return (
    t === "skip" || t === "none" || t === "not right now" || t === "id rather skip that" || t === "i would rather skip that" || isNegative(t)
  );
}








function isEndCallPhrase(text) {
  const t = normalizedText(text);
  const it = normalizeIntentText(text);
  if (/^(yes|yeah|yep|yup)\b.*\b(that ll do it|thatll do it|that will do it|that s all|thats all|that s it|thats it|we re good|were good|i m good|im good|all set)\b/.test(it)) return true;
  if (containsAny(it, [
    "no thats it", "no that s it", "no thats all", "no that s all",
    "nothing more to add", "nothing to add", "nothing else to add",
    "no nothing", "no notes", "no note", "no special instructions",
    "nothing for the tech", "nothing for the technician", "no instructions",
    "no thats everything", "no that s everything"
  ])) return true;
  return containsAny(t, [
    "that's all", "that is all", "nothing else", "i'm good", "im good", "all set",
    "that'll do it", "that will do it", "that's everything", "that is everything",
    "that's all i need", "that is all i need", "we're good", "we are good", "that should do it",
    "i think that's it", "i think that is it", "no i think that's it", "no i think that is it",
    "no that's all", "no that is all", "no that's it", "no that is it", "okay bye", "bye bye", "goodbye",
    "yeah that'll do it", "yeah thatll do it", "yeah that will do it", "yeah that's all", "yeah thats all",
    "yeah that's it", "yeah thats it", "yeah we're good", "yeah we are good"
  ]);
}

/** True when caller is giving real technician instructions (override shallow “no …”). */
function looksLikeSubstantiveTechNoteIntent(text) {
  const it = normalizeIntentText(text);
  if (!it) return false;
  if (/\d/.test(text || "")) return true;
  return containsAny(it, [
    "gate", "code", "door", "key", "keys", "lock", "dog", "dogs", "pet", "pets", "cat", "alarm",
    "parking", "driveway", "basement", "side door", "back door", "fence", "garage",
    "note that", "make sure", "watch out", "careful", "hazard", "fragile",
    "call me", "text me", "reach me", "extension", "cell", "mobile",
    "broken", "step", "stairs", "wet floor", "construction", "hoa",
    "vacant", "rental", "tenant", "lockbox", "combo"
  ]);
}

function looksLikeSubstantiveFinalQuestionAddition(text) {
  const it = normalizeIntentText(text);
  if (!it) return false;
  if (looksLikeSubstantiveTechNoteIntent(text)) return true;
  return containsAny(it, [
    "also", "one more thing", "another thing", "can you add", "could you add", "please add",
    "add that", "add this", "include that", "include this", "put it in the notes",
    "put in the notes", "make a note", "note that", "notes that",
    "address", "phone", "email", "text me", "call me",
    "broken", "cracked", "leaking", "leak", "is out", "not working", "stopped working",
    "renting", "renter", "tenant"
  ]);
}

/** Caller is declining extra notes for the tech (not the same as generic isNegative — avoids “no, put gate code…”). */
function isDecliningTechnicianNotes(text) {
  const it = normalizeIntentText(text);
  if (!it) return false;
  if (isEndCallPhrase(text)) return true;

  const substantive = looksLikeSubstantiveTechNoteIntent(text);
  if (!substantive && isNegative(text)) return true;

  if (containsAny(it, [
    "no notes", "nonotes", "no note", "zero notes",
    "nothing for the tech", "nothing for the technician",
    "nothing else", "nothing to add", "nothing more", "no nothing",
    "nothing really", "nothing more to say", "no nothing thanks",
    "no special instructions", "no instructions", "no thats okay", "no that s okay",
    "were good", "we re good", "were all set", "we re all set", "all set",
    "thats fine", "that s fine", "im good", "i m good", "nah im good",
    "nah i m good",
    "i dont think so", "i do not think so", "dont think so", "don t think so",
    "not really",
    "probably not", "i guess not",
    "no thanks", "no thank you", "thanks but no thanks",
    "not now", "skip that", "rather not"
  ])) return true;
  return false;
}








function isPricingQuestion(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "how much", "price", "pricing", "cost", "what is this going to cost",
    "what's this going to cost", "what will this cost", "how much do you charge",
    "what do you charge", "service fee", "trip charge", "diagnostic fee"
  ]);
}








function pricingResponse() {
  return "That is a great question. Pricing can vary depending on the job, so someone from the office will go over that with you when they call.";
}

function isHumanAgentRequest(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (containsAny(t, [
    "real person", "live person", "actual person", "human being",
    "speak to a person", "speak to someone", "speak to a human", "speak to somebody",
    "talk to a person", "talk to someone", "talk to a human", "talk to somebody",
    "speak with a person", "speak with someone", "speak with a human",
    "talk with a person", "talk with someone", "talk with a human",
    "live agent", "live representative", "customer service rep", "customer service",
    "transfer me", "connect me to someone", "connect me to a person",
    "get me a person", "get me someone", "put me through to someone",
    "speak to a rep", "talk to a rep", "real agent", "real representative"
  ])) return true;
  return /\b(can|could|may|want to|wanna|need to)\b.*\b(speak|talk)\b.*\b(person|someone|somebody|human|agent|representative|rep)\b/.test(t);
}

function isAiIdentityQuestion(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (containsAny(t, [
    "are you ai", "are you a i", "is this ai", "is this a i",
    "are you artificial", "artificial intelligence",
    "are you a robot", "are you automated", "is this automated",
    "is this a bot", "are you a bot", "talking to a bot",
    "talking to ai", "talking to a computer", "speaking to ai",
    "am i talking to ai", "am i speaking to ai",
    "is this a computer", "virtual assistant", "automated system"
  ])) return true;
  return /\b(is this|are you|am i talking to|am i speaking to)\b.*\b(ai|bot|robot|computer|automated|virtual)\b/.test(t);
}

function buildAutomatedServiceAcknowledgement(caller, text) {
  if (isHumanAgentRequest(text)) {
    const pools = [
      "There isn't a live person on this line—this is the automated Blue Caller demo. I can still take your details, or you can reach the team at bluecallerautomation.com.",
      "I can't transfer you to a live agent on this demo line. I'm happy to keep going and capture your info, or you can contact Blue Caller Automation directly.",
    ];
    return pools[nextPromptIndex(caller, "humanAgentAckIx") % pools.length];
  }
  const pools = [
    "Yes—I'm the automated assistant on the Blue Caller demo line. I can still help finish your request.",
    "That's right—this is an AI demo line. I can keep going whenever you're ready.",
  ];
  return pools[nextPromptIndex(caller, "aiIdentityAckIx") % pools.length];
}








function isDemoIntent(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "demo", "demonstration", "schedule a demo", "book a demo", "interested in your service",
    "interested in the service", "interested in your ai receptionist", "virtual receptionist service",
    "ai receptionist service", "learn more about your service", "how does your service work"
  ]);
}








function isQuoteIntent(text) {
  const t = normalizedText(text);
  if (containsAny(t, ["quote", "estimate", "proposal", "bid"])) return true;
  if (containsAny(t, ["remodel", "remodeling", "renovation", "renovating", "reno", "renos"])) return true;
  if (containsAny(t, ["install", "installation", "replace", "replacement", "new"]) && containsAny(t, [
    "appliance", "refrigerator", "fridge", "dishwasher", "stove", "oven", "range", "cooktop",
    "washer", "dryer", "microwave", "garbage disposal", "water heater", "toilet", "faucet"
  ])) return true;
  return false;
}








function classifyProjectType(text) {
  const raw = cleanForSpeech(text || "");
  const t = normalizedText(raw);
  if (containsAny(t, ["refrigerator", "fridge", "freezer"]) && containsAny(t, ["install", "installation", "replace", "replacement"])) return "an appliance installation";
  if (t.includes("dishwasher") && containsAny(t, ["install", "installation", "replace", "replacement"])) return "a dishwasher installation";
  if (t.includes("stove") && containsAny(t, ["install", "installation", "replace", "replacement"])) return "an appliance installation";
  if (containsAny(t, ["bathroom", "bath"]) && containsAny(t, ["remodel", "quote", "estimate"])) return "a bathroom remodel";
  if (t.includes("kitchen") && containsAny(t, ["remodel", "quote", "estimate"])) return "a kitchen remodel";
  return raw || "this project";
}

function detectNamedApplianceBrand(text) {
  const t = normalizedText(text || "");
  if (!t) return "";
  const brandPatterns = [
    [/\bsub[-\s]?zero\b/, "Sub-Zero"],
    [/\bwolf\b/, "Wolf"],
    [/thermador/, "Thermador"],
    [/gaggenau/, "Gaggenau"],
    [/miele/, "Miele"],
    [/speed[-\s]?queen|speedqueen/, "Speed Queen"],
    [/frigidaire/, "Frigidaire"],
    [/bosch/, "Bosch"],
    [/viking/, "Viking"],
    [/\bjenn[-\s]?air\b|jennair/, "JennAir"],
    [/monogram/, "Monogram"],
    [/kitchenaid|kitchen\s+aid/, "KitchenAid"],
    [/dacor/, "Dacor"],
    [/bertazzoni/, "Bertazzoni"],
    [/fisher\s*(?:&|and)?\s*paykel/, "Fisher and Paykel"],
    [/la\s+cornue/, "La Cornue"],
    [/electrolux/, "Electrolux"],
    [/whirlpool/, "Whirlpool"],
    [/maytag/, "Maytag"],
    [/samsung/, "Samsung"],
    [/\blg\b/, "LG"],
    [/amana/, "Amana"]
  ];
  for (const [re, label] of brandPatterns) {
    if (re.test(t)) return label;
  }
  return "";
}

function isApplianceIssueContext(text) {
  const t = normalizedText(text || "");
  if (!t) return false;
  if (detectNamedApplianceBrand(text)) return true;
  const item = detectServiceItem(text);
  if (item && item.category === "appliance") return true;
  return containsAny(t, [
    "appliance", "appliances", "refrigerator", "fridge", "freezer", "ice maker", "icemaker",
    "dishwasher", "oven", "range", "cooktop", "stove", "washer", "washing machine",
    "dryer", "microwave", "garbage disposal", "disposal", "wine cooler", "wine fridge"
  ]);
}

function isApplianceSchedulingOrServiceLead(text) {
  const raw = cleanForSpeech(text || "");
  const t = normalizedText(raw);
  if (!t || !isApplianceIssueContext(raw)) return false;
  if (isServiceCapabilityQuestion(raw)) return false;
  const schedulingLike = containsAny(t, [
    "schedule", "scheduling", "book", "booking", "appointment", "service call", "call out", "come out",
    "dispatch", "technician", "repair", "fixed", "look at", "check on", "take a look",
    "need someone", "need somebody", "set up", "setup"
  ]);
  const problemLike =
    hasSpecificProblemDetail(raw) ||
    containsAny(t, [
      "not working", "stopped working", "won't", "wont", "isn't", "isnt", "broken", "noise", "noisy",
      "not cooling", "not heating", "not draining", "leak", "error code", "display",
      "need service", "needs service", "need repair", "needs repair", "service appointment",
      "have a problem", "having a problem", "something wrong"
    ]);
  return schedulingLike || problemLike;
}

function shouldSuppressHomeLeakEmergencyForApplianceIssue(text) {
  if (!IS_APPLIANCE_VERTICAL) return false;
  const item = detectServiceItem(text || "");
  return Boolean(item && item.category === "appliance");
}

function applianceCoverageCaptured(caller) {
  return Boolean(caller && caller.applianceCoverage && String(caller.applianceCoverage).trim());
}

function applianceTypeOrBrandCaptured(caller) {
  if (!caller) return false;
  return Boolean(caller.applianceBrand || caller.applianceTypeDetail);
}

function applianceSymptomCapturedForMerged(caller, mergedIssueText) {
  if (!caller) return false;
  if (caller.applianceSymptomCaptured) return true;
  return hasSpecificProblemDetail(mergedIssueText || caller.issue || "");
}

function applianceDetailSlotsComplete(caller) {
  const merged = caller.applianceIntakeMergedIssue || caller.issue || "";
  return (
    applianceTypeOrBrandCaptured(caller) &&
    applianceCoverageCaptured(caller) &&
    applianceSymptomCapturedForMerged(caller, merged)
  );
}

function harvestApplianceDetailSlots(caller, text) {
  if (!caller || !text) return;
  const raw = cleanForSpeech(text || "");
  const t = normalizedText(raw);
  const brand = detectNamedApplianceBrand(raw);
  if (brand) caller.applianceBrand = brand;

  const item = detectServiceItem(raw);
  if (item && item.category === "appliance") {
    caller.applianceTypeDetail = caller.applianceTypeDetail || item.label;
  }

  if (!caller.applianceTypeDetail && containsAny(t, ["built in", "built-in", "column", "combo", "panel ready"])) {
    caller.applianceTypeDetail = caller.applianceTypeDetail || "built-in appliance";
  }

  if (
    containsAny(t, [
      "under warranty", "still under warranty", "factory warranty", "manufacturer warranty",
      "warranty service", "warranty visit", "covered under warranty", "in warranty"
    ])
  ) {
    caller.applianceCoverage = "warranty";
  }
  if (containsAny(t, ["extended warranty", "service plan", "home warranty", "protection plan"])) {
    caller.applianceCoverage = caller.applianceCoverage || "extended_or_plan";
  }
  if (
    containsAny(t, [
      "billable", "pay out of pocket", "out of pocket", "not covered", "no warranty",
      "expired warranty", "not under warranty", "private pay"
    ])
  ) {
    caller.applianceCoverage = "billable";
  }
  if (containsAny(t, ["not sure", "dont know", "do not know", "unsure", "no idea"])) {
    caller.applianceCoverage = caller.applianceCoverage || "unknown";
  }

  if (hasSpecificProblemDetail(raw)) {
    caller.applianceSymptomCaptured = true;
  }
}

function mergeApplianceIntakeIntoIssue(caller) {
  if (!caller) return;
  const parts = [];
  if (caller.applianceBrand) parts.push(caller.applianceBrand);
  if (caller.applianceTypeDetail) parts.push(`type: ${caller.applianceTypeDetail}`);
  const cov = caller.applianceCoverage;
  let covLabel = "";
  if (cov === "warranty") covLabel = "manufacturer warranty";
  else if (cov === "extended_or_plan") covLabel = "extended warranty / plan";
  else if (cov === "billable") covLabel = "billable / out-of-pocket";
  else if (cov === "unknown") covLabel = "coverage unclear";
  if (covLabel) parts.push(covLabel);

  const mergedBits = parts.join(" · ").trim();
  const base = cleanForSpeech(caller.issue || "");
  if (mergedBits) {
    caller.issue = base ? `${base} — Appliance intake: ${mergedBits}` : `Appliance intake: ${mergedBits}`;
  }
  afterIssueCaptured(caller);
}

function buildNextApplianceDetailQuestion(caller) {
  const merged = caller.applianceIntakeMergedIssue || caller.issue || "";
  harvestApplianceDetailSlots(caller, merged);

  if (!applianceTypeOrBrandCaptured(caller)) {
    const pool = [
      "Tell me a bit about the unit—the appliance type, and the brand or model if you know it.",
      "What kind of appliance are we working with, and what brand or model is it?",
      "Help me picture it—what appliance is it, and do you happen to know the brand or model?"
    ];
    const i = nextPromptIndex(caller, "applianceAskTypeBrandIndex");
    return pool[i % pool.length];
  }

  if (!applianceSymptomCapturedForMerged(caller, merged)) {
    const pool = [
      "What's going on with it—walk me through what you're noticing, even if it's small stuff.",
      "When it acts up, what does it do—or not do—that made you call?",
      "What's the day-to-day symptom—noises, temperatures, error codes, anything like that?"
    ];
    const i = nextPromptIndex(caller, "applianceAskSymptomIndex");
    return pool[i % pool.length];
  }

  if (!applianceCoverageCaptured(caller)) {
    const pool = [
      "Is this still under manufacturer warranty, or are you expecting more of a billable service visit?",
      "Should I note this as warranty-covered work, or standard billable service?",
      "Are we thinking warranty route with the manufacturer, or out-of-pocket service?"
    ];
    const i = nextPromptIndex(caller, "applianceAskCoverageIndex");
    return pool[i % pool.length];
  }

  return "What's going on with it—walk me through what you're noticing, even if it's small stuff.";
}

function shouldOfferApplianceDetailPass(caller) {
  if (!IS_APPLIANCE_VERTICAL) return false;
  if (!caller || caller.leadType !== "service" || caller.emergencyAlert) return false;
  if (caller.issueIsCapabilityQuestion) return false;
  return isApplianceSchedulingOrServiceLead(caller.issue || "");
}

function tryBeginApplianceServiceIntake(ws, caller) {
  if (!shouldOfferApplianceDetailPass(caller)) return false;
  harvestApplianceDetailSlots(caller, caller.issue || "");
  caller.applianceIntakeMergedIssue = cleanForSpeech(caller.issue || "");
  if (applianceDetailSlotsComplete(caller)) return false;

  caller.lastStep = "appliance_service_intake";
  const openerPool = [
    "Sure—let's grab a few appliance details so the technician shows up prepared.",
    "Absolutely—we can help with that. Let me pull together a little detail on the appliance side.",
    "Okay—let's get a quick picture of the appliance so nothing gets missed."
  ];
  const oi = nextPromptIndex(caller, "applianceIntakeOpenerIndex");
  const opener = openerPool[oi % openerPool.length];
  sendText(ws, `${opener} ${buildNextApplianceDetailQuestion(caller)}`);
  return true;
}

function finalizeApplianceIntakeTurn(caller, spokenText) {
  caller.applianceIntakeMergedIssue = combineIssueContextAndDetail(caller.applianceIntakeMergedIssue || caller.issue || "", spokenText || "");
  harvestApplianceDetailSlots(caller, caller.applianceIntakeMergedIssue);
  caller.issue = caller.applianceIntakeMergedIssue;
}

function buildApplianceLeadIssueAcknowledgement(caller) {
  const brand = detectNamedApplianceBrand(caller.issue || "");
  if (brand) return `Absolutely—we can help get your ${brand} taken care of.`;
  return "Absolutely—we can help get this taken care of.";
}

function proceedToContactCollectionAfterApplianceIntake(ws, caller) {
  mergeApplianceIntakeIntoIssue(caller);
  caller.applianceIntakeMergedIssue = "";

  if (isRefrigeratorEmergencyCandidate(caller.issue) && !caller.emergencyAlert) {
    caller.lastStep = "refrigerator_emergency_choice";
    sendText(ws, buildRefrigeratorEmergencyPrompt(caller));
    return;
  }

  if (isCookingAppliancePriorityCandidate(caller.issue) && !caller.emergencyAlert) {
    caller.lastStep = "appliance_priority_choice";
    sendText(ws, buildCookingPriorityPrompt(caller));
    return;
  }

  if (isUrgentNonEmergencyRequest(caller.issue) && !caller.emergencyAlert) {
    markUrgent(caller);
    const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
    const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildUrgentPostIssueSpellingPreamble(caller)) : "";
    if (spellingPrompt) {
      sendText(ws, spellingPrompt);
      return;
    }
    caller.lastStep = nextStep;
    sendText(ws, buildUrgentIntakePrompt(caller));
    return;
  }

  if (isLeakLikeIssue(caller.issue) && !caller.emergencyAlert && !shouldSuppressHomeLeakEmergencyForApplianceIssue(caller.issue)) {
    if (!caller.fullName) {
      caller.pendingNameNextStep = "leak_emergency_choice";
      caller.lastStep = "ask_name";
      sendText(ws, buildMissingNameAfterIssuePrompt(caller));
      return;
    }
    const spLeak = maybeQueueFirstNameSpelling(caller, "leak_emergency_choice", buildIssueAcknowledgement(caller));
    if (spLeak) {
      sendText(ws, spLeak);
      return;
    }
    caller.lastStep = "leak_emergency_choice";
    sendText(ws, `${buildIssueAcknowledgement(caller)} Do you want me to mark this as an emergency?`);
    return;
  }

  const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
  if (caller.emergencyAlert) {
    caller.lastStep = nextStep;
    sendText(ws, buildEmergencyIntakePrompt(caller));
    return;
  }

  const preamble = caller.firstName
    ? `Thank you, ${caller.firstName}. Perfect—I have what we need on the appliance.`
    : "Perfect—I have what we need on the appliance.";
  const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, preamble) : "";
  if (spellingPrompt) {
    sendText(ws, spellingPrompt);
    return;
  }
  caller.lastStep = nextStep;
  if (caller.fullName) {
    if (hasFullName(caller.fullName)) {
      sendText(ws, `${preamble} ${buildPhoneIntakePromptFragment(caller)}`);
      return;
    }
    sendText(ws, `${preamble} Before I go any further, can I get your last name as well?`);
    return;
  }
  sendText(ws, `${preamble} Can I start by getting your full name, please?`);
}

function isServiceCapabilityQuestion(text) {
  const raw = cleanForSpeech(text || "");
  const t = normalizedText(raw);
  const namedBrand = detectNamedApplianceBrand(text);
  if (!t || (t.length < 8 && !(namedBrand && t.length >= 5))) return false;
  if (isHardEmergency(text)) return false;
  if (isDemoIntent(text)) return false;

  const soundsLikeActiveProblem =
    containsAny(t, [
      "burst pipe", "flooding", "flooded", "gushing", "sewage backup", "sewer backup", "no heat", "no ac",
      "no a c", "no cooling", "no hot water", "spark", "smoke", "fire"
    ]) || (isLeakLikeIssue(text) && containsAny(t, ["leak", "leaking", "drip", "dripping"]));
  if (soundsLikeActiveProblem) return false;
  if (hasSpecificProblemDetail(text)) return false;

  if (/^\s*i\s+need\s+/i.test(raw) && !/\b(if|whether)\b/.test(t)) return false;
  if (/\b(my|our)\s+(toilet|faucet|sink|water heater|drain|drains|pipe|pipes|shower|tub|ceiling|basement)\b/.test(t)) {
    return false;
  }

  const genericTrade = containsAny(t, [
    "plumb", "plumbing", "plumber",
    "hvac", "furnace", "air conditioning", "air conditioner",
    "electrical", "electrician", "wiring",
    "roofing", "roofer",
    "contractor", "contracting",
    "reno", "renovation", "renovate", "renovating", "remodel", "remodeling",
    "new build", "new construction",
    "appliance", "appliances", "refrigerator", "fridge", "freezer", "dishwasher", "oven", "range", "cooktop", "stove"
  ]);

  const trades = genericTrade || Boolean(namedBrand);

  const asksScope = containsAny(t, [
    "do you", "does your", "can you", "could you", "would you", "are you able", "will you",
    "do you guys", "do y'all", "do yall",
    "wondering if", "wondering whether", "wanted to know if", "want to know if",
    "calling to see if", "check if you", "checking if you", "find out if you",
    "to know if you", "know if you",
    "take on", "you handle", "you work on",
    "offer ", "provides ", "provide ",
    "looking for someone", "looking for a plumber", "looking for an electrician",
    "looking for a company", "any chance you"
  ]) || /\bdo\s+y'?all\s+do\b/.test(t);

  if (!trades) return false;
  if (!asksScope) {
    if (!t.includes("?")) return false;
    if (!genericTrade && !namedBrand) return false;
    const hasScopeKeyword = containsAny(t, [
      "repair", "repairs", "service", "services", "work", "new build", "construction",
      "reno", "renovation", "remodel", "install", "installation", "appliance", "equip"
    ]);
    if (!hasScopeKeyword && !namedBrand) return false;
  }
  return true;
}

function buildCapabilityIssueSummary(issue) {
  const t = normalizedText(issue || "");
  const brand = detectNamedApplianceBrand(issue);
  if (brand) return `${brand} appliance service inquiry`;
  if (containsAny(t, ["plumb", "plumbing", "plumber"])) {
    if (containsAny(t, ["new build", "new construction"])) return "plumbing for new construction";
    if (containsAny(t, ["renovation", "renovate", "reno", "renos", "remodel", "remodeling"])) {
      return "plumbing for remodeling or renovation";
    }
    if (containsAny(t, ["repair", "repairs"])) return "plumbing repairs";
    return "plumbing services";
  }
  if (containsAny(t, ["hvac", "furnace", "air conditioning", "air conditioner"]) || (t.includes("heating") && t.includes("cooling"))) {
    return "HVAC services";
  }
  if (containsAny(t, ["electrical", "electrician", "wiring"])) return "electrical services";
  if (containsAny(t, ["roof", "roofing", "roofer"])) return "roofing services";
  if (containsAny(t, ["contractor", "contracting", "new build", "new construction", "renovation", "remodel"])) {
    return "contracting or construction services";
  }
  return "your service question";
}

function buildCapabilityAcknowledgement(caller) {
  const t = normalizedText(caller.issue || "");
  const brand = detectNamedApplianceBrand(caller.issue || "");
  if (brand) {
    return `Yes, we service ${brand} appliances, including repairs and installation.`;
  }
  if (containsAny(t, ["plumb", "plumbing", "plumber"])) {
    const repair = containsAny(t, ["repair", "repairs"]);
    const newBuild = containsAny(t, ["new build", "new construction"]);
    const reno = containsAny(t, ["renovation", "renovate", "reno", "renos", "remodel", "remodeling"]);
    if (newBuild && reno && repair) return "Yes, we handle plumbing for new construction, renovations, and repairs.";
    if (newBuild && reno) return "Yes, we handle plumbing for new construction and for renovation work.";
    if (newBuild && repair) return "Yes, we handle plumbing for new construction and for repairs.";
    if (reno && repair) return "Yes, we handle plumbing repairs and plumbing for renovation work.";
    if (newBuild) return "Yes, we handle plumbing for new construction projects.";
    if (reno) return "Yes, we handle plumbing for remodeling and renovation work.";
    if (repair) return "Yes, we handle plumbing repairs.";
    return "Yes, we handle plumbing work, including repairs, new construction, and renovation projects.";
  }
  if (containsAny(t, ["hvac", "furnace", "air conditioning", "air conditioner"]) || (t.includes("heating") && t.includes("cooling"))) {
    return "Yes, we handle HVAC work.";
  }
  if (containsAny(t, ["electrical", "electrician", "wiring"])) {
    return "Yes, we handle electrical work.";
  }
  if (containsAny(t, ["roof", "roofing", "roofer"])) {
    return "Yes, we handle roofing work.";
  }
  if (containsAny(t, ["contractor", "contracting", "new build", "new construction", "renovation", "remodel"])) {
    return "Yes, we take on that type of work.";
  }
  return "Yes, we should be able to help with that.";
}

function buildQuoteIntakeOpener(caller) {
  if (!caller.issueIsCapabilityQuestion) return "Absolutely.";
  return `${buildCapabilityAcknowledgement(caller)} I can help get a quote request set up.`;
}

function buildQuoteFollowupAckLine(caller) {
  if (caller.issueIsCapabilityQuestion) {
    return `${buildCapabilityAcknowledgement(caller)} I have ${caller.issueSummary} noted for the team.`;
  }
  return `Absolutely. I have ${caller.issueSummary}.`;
}








function detectServiceItem(issue) {
  const text = normalizedText(issue)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();








  const items = [
    { pattern: /\b(refrigerator|refrigerators|fridge|fridges|freezer|freezers)\b/, label: "refrigerator", prompt: "your refrigerator", category: "appliance" },
    { pattern: /\b(dishwasher|dish washer|dishdrawer|dish drawer)\b/, label: "dishwasher", prompt: "your dishwasher", category: "appliance" },
    { pattern: /\b(oven|wall oven|double oven)\b/, label: "oven", prompt: "your oven", category: "appliance" },
    { pattern: /\b(cooktop|cook top)\b/, label: "cooktop", prompt: "your cooktop", category: "appliance" },
    { pattern: /\b(range)\b/, label: "range", prompt: "your range", category: "appliance" },
    { pattern: /\b(stove|stovetop|stove top|burner|burners)\b/, label: "stove", prompt: "your stove", category: "appliance" },
    { pattern: /\b(washer|washing machine)\b/, label: "washer", prompt: "your washer", category: "appliance" },
    { pattern: /\b(dryer|clothes dryer)\b/, label: "dryer", prompt: "your dryer", category: "appliance" },
    { pattern: /\b(microwave|built in microwave)\b/, label: "microwave", prompt: "your microwave", category: "appliance" },
    { pattern: /\b(garbage disposal|disposal)\b/, label: "garbage disposal", prompt: "your garbage disposal", category: "appliance" },
    // "faucet" is commonly misrecognized by STT as "facet" / "faucit" / "fawcett".
    { pattern: /\b(faucet|faucets|tap|taps|facet|faucit|fawcett)\b/, label: "faucet", prompt: "your faucet", category: "fixture" },
    { pattern: /\b(sink)\b/, label: "sink", prompt: "your sink", category: "fixture" },
    { pattern: /\b(toilet)\b/, label: "toilet", prompt: "your toilet", category: "fixture" },
    { pattern: /\b(water heater)\b/, label: "water heater", prompt: "your water heater", category: "fixture" },
    { pattern: /\b(home filter|house filter|water filter|whole house filter|whole-house filter|filtration system|filter housing)\b/, label: "home water filter", prompt: "your home water filter", category: "fixture" }
  ];








  for (const item of items) {
    if (item.pattern.test(text)) return item;
  }
  return null;
}








function hasSpecificProblemDetail(issue) {
  const text = normalizedText(issue);
  return containsAny(text, [
    "not working", "isn't working", "isnt working", "stopped working", "won't work", "wont work",
    "not cooling", "isn't cooling", "isnt cooling", "not heating", "isn't heating", "isnt heating",
    "not drying", "isn't drying", "isnt drying", "not draining", "won't drain", "wont drain",
    "not turning on", "won't turn on", "wont turn on", "not starting", "won't start", "wont start",
    "not igniting", "not making ice", "not producing ice", "making too much ice", "overproducing",
    "won't stop", "wont stop", "stopped", "broken", "cracked", "loose", "leak", "leaking",
    "drip", "dripping", "clog", "clogged", "overflow", "overflowing", "backed up", "backing up",
    "making noise", "noisy", "noise", "sparking", "smoke", "smoking", "burning smell", "gas smell",
    "water everywhere", "flooding", "freezing", "too warm", "too hot", "pilot", "not flushing",
    "running constantly", "not responding", "burner", "burners"
  ]);
}








function detectMissingProblemItem(issue) {
  const item = detectServiceItem(issue);
  if (!item) return null;
  if (hasSpecificProblemDetail(issue)) return null;
  if (isQuoteIntent(issue) || isDemoIntent(issue) || isHardEmergency(issue) || isLeakLikeIssue(issue)) return null;
  return item;
}








function combineItemAndDetail(item, detail) {
  const safeItem = cleanForSpeech(item || "");
  const safeDetail = cleanForSpeech(detail || "");
  return `${safeItem} ${safeDetail}`.trim();
}








function buildApplianceIssueSummary(issue, item) {
  const t = normalizedText(issue);
  if (!item || item.category !== "appliance") return "";
  if (
    (item.label === "stove" || item.label === "range" || item.label === "cooktop") &&
    containsAny(t, ["burner", "burners"])
  ) {
    if (containsAny(t, ["not igniting", "won't ignite", "wont ignite"])) {
      return `a ${item.label} burner that won't ignite`;
    }
    if (containsAny(t, ["not turning on", "won't turn on", "wont turn on"])) {
      return `a ${item.label} burner that isn't turning on`;
    }
  }
  if (item.label === "oven" && containsAny(t, ["not heating", "isn't heating", "isnt heating"])) return "an oven that is not heating properly";
  if (item.label === "refrigerator" && normalizedIssueHasFridgeCoolingProblem(t)) return "a refrigerator that is not cooling";
  if (item.label === "dishwasher" && containsAny(t, ["not draining", "won't drain", "wont drain"])) return "a dishwasher that is not draining";
  if (item.label === "washer" && containsAny(t, ["not draining", "won't drain", "wont drain"])) return "a washer that is not draining";
  if (item.label === "dryer" && containsAny(t, ["not heating", "isn't heating", "isnt heating", "not drying"])) return "a dryer that is not heating properly";
  if (containsAny(t, ["not turning on", "won't turn on", "wont turn on"])) return `a ${item.label} that is not turning on`;
  if (containsAny(t, ["not working", "isn't working", "isnt working", "stopped working"])) return `a ${item.label} that is not working`;
  if (containsAny(t, ["not cooling", "isn't cooling", "isnt cooling"])) return `a ${item.label} that is not cooling`;
  if (containsAny(t, ["not heating", "isn't heating", "isnt heating"])) return `a ${item.label} that is not heating properly`;
  if (containsAny(t, ["not draining", "won't drain", "wont drain"])) return `a ${item.label} that is not draining`;
  if (containsAny(t, ["making noise", "noisy", "noise"])) return `a noisy ${item.label}`;
  if (containsAny(t, ["leak", "leaking", "drip", "dripping"])) return `a leaking ${item.label}`;
  return `an issue with ${item.prompt}`;
}








function buildUnknownIssueSummary(issue) {
  const cleaned = cleanForSpeech(issue || "");
  if (!cleaned) return "the issue you described";
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 77).trim()}...`;
}








function humanizeIssueSummaryForSpeech(summary) {
  return cleanForSpeech(summary || "")
    .replace(/^i think i have\s+/i, "")
    .replace(/^i have\s+/i, "")
    .replace(/^there(?:'s| is)\s+/i, "")
    .replace(/\s+(?:my name is|this is|call me|i am|i'm)\s+[a-z][a-z'\s-]+$/i, "")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bour\b/gi, "your")
    .trim();
}








function buildIssueAcknowledgement(caller) {
  if (caller.issueIsCapabilityQuestion) return buildCapabilityAcknowledgement(caller);
  if (
    IS_APPLIANCE_VERTICAL &&
    !caller.issueIsCapabilityQuestion &&
    isApplianceSchedulingOrServiceLead(caller.issue || "")
  ) {
    return buildApplianceLeadIssueAcknowledgement(caller);
  }
  const summary = humanizeIssueSummaryForSpeech(caller.issueSummary || caller.issue || "that issue");
  if (!summary) return "I'm sorry you're dealing with that.";
  if (isMainLineEmergencyCandidate(caller.issue || "") || normalizedText(summary).includes("broken main")) {
    return `I'm sorry you're dealing with what sounds like ${summary}.`;
  }
  return `I'm sorry you're dealing with ${summary}.`;
}








function isSameAvailabilitySlot(firstDate, firstTime, secondDate, secondTime) {
  return normalizedText(firstDate || "") === normalizedText(secondDate || "")
    && normalizedText(firstTime || "") === normalizedText(secondTime || "");
}








function parseTimeToMinutes(timeText) {
  const safe = cleanForSpeech(timeText || "");
  const match = safe.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return (hour * 60) + minute;
}

function isAllowedCallbackStartTime(timeText) {
  const minutes = parseTimeToMinutes(timeText || "");
  if (minutes === null) return false;
  return minutes >= BUSINESS_DAY_START_MINUTES && minutes <= LATEST_CALLBACK_START_MINUTES;
}

function formatInstantPartsEastern(ts) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const o = {};
  for (const p of fmt.formatToParts(new Date(ts))) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  return { year: o.year, month: o.month, day: o.day, weekday: o.weekday, hour: o.hour, minute: o.minute };
}

function ymdToSpokenServiceDate(yearStr, monthStr, dayStr) {
  const y = Number(yearStr);
  const mo = Number(monthStr);
  const d = Number(dayStr);
  const ref = new Date(Date.UTC(y, mo - 1, d, 17, 0, 0));
  const weekday = ref.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  const monthName = ref.toLocaleDateString("en-US", { month: "long", timeZone: "America/New_York" });
  return `${weekday}, ${monthName} ${d}`;
}

function formatMinutesAsTime12h(totalMinutes) {
  let h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const mer = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${mer}`;
}

/** Soonest offer: max(now + 6h, business open + 6h) on a weekday, and not after latest callback start. */
function computeMinimumAllowedCallbackSpoken() {
  const minMinutesFromMidnight = BUSINESS_DAY_START_MINUTES + MIN_CALLBACK_LEAD_WALL_HOURS * 60;
  let t = Date.now() + MIN_CALLBACK_LEAD_WALL_HOURS * 3600000;
  for (let guard = 0; guard < 500; guard++) {
    const e = formatInstantPartsEastern(t);
    if (e.weekday === "Saturday" || e.weekday === "Sunday") {
      t += 3600000;
      continue;
    }
    const mins = Number(e.hour) * 60 + Number(e.minute);
    const targetMins = Math.max(mins, minMinutesFromMidnight);
    if (targetMins > LATEST_CALLBACK_START_MINUTES) {
      t += 3600000;
      continue;
    }
    return {
      date: ymdToSpokenServiceDate(e.year, e.month, e.day),
      time: formatMinutesAsTime12h(targetMins)
    };
  }
  return null;
}

function compareSpokenCallbackSlots(dateA, timeA, dateB, timeB) {
  const a = parseCallbackDateAndTimeToLocal(dateA || "", timeA || "");
  const b = parseCallbackDateAndTimeToLocal(dateB || "", timeB || "");
  if (!a || !b) return 0;
  if (a.startLocal < b.startLocal) return -1;
  if (a.startLocal > b.startLocal) return 1;
  return 0;
}

function isLateDayPreferenceRequest(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return containsAny(t, [
    "after 4 30", "after 430", "after four thirty", "after 5", "after five",
    "5 pm", "5 00 pm", "five pm", "five o clock", "five oclock",
    "close to 5", "close to five", "as close to 5 as possible", "as close to five as possible",
    "as late as possible", "late in the day", "as late in the day as possible"
  ]);
}

function buildLateDayFallbackPrompt(caller) {
  const variants = [
    "Our office closes at 5:00, but I can add a note that you're hoping for a call as late in the day as possible, or as close to 5:00 as we can get.",
    "We close at 5:00, so I can't promise a 5:00 callback, but I can absolutely note that you'd prefer as late in the day as possible.",
    "Our office closes at 5:00, but I can put that in the notes and ask for someone to call you as close to 5:00 as possible."
  ];
  const index = nextPromptIndex(caller, "lateDayPromptIndex");
  return `${variants[index % variants.length]} Would you like me to note that, or would you prefer an earlier callback time?`;
}

function addLateDayPreferenceNote(caller) {
  const preferredDate = caller.pendingLateDayDate || caller.appointmentDate || caller.requestedDate || "";
  const note = preferredDate
    ? `Late-day preference: caller is hoping for a callback on ${preferredDate} as close to 5:00 PM as possible.`
    : "Late-day preference: caller is hoping for a callback as close to 5:00 PM as possible.";
  if ((caller.notes || "").includes("Late-day preference:")) return;
  caller.notes = caller.notes ? `${caller.notes} ${note}` : note;
}

function finalizeLateDayPreference(caller) {
  addLateDayPreferenceNote(caller);
  if (!caller.appointmentDate) {
    caller.appointmentDate = caller.pendingLateDayDate || caller.requestedDate || caller.appointmentDate || "";
  }
  caller.appointmentTime = "as close to 5:00 PM as possible";
  caller.status = "scheduled_pending_confirmation";
  caller.calendarSlotConfirmed = false;
}

function offeredAvailabilityNeedsLateDayFallback(availability) {
  return Boolean(availability && availability.time && !isAllowedCallbackStartTime(availability.time));
}









function matchesAlternateAvailabilityRequest(rawText, currentDate, currentTime, offeredDate, offeredTime) {
  if (isSameAvailabilitySlot(offeredDate, offeredTime, currentDate, currentTime)) return false;




  const lowered = normalizedText(rawText || "");
  if (containsAny(lowered, ["later that day", "later the same day", "later in the afternoon", "later that afternoon", "later that morning", "anything later", "something later"])) {
    if (normalizedText(offeredDate || "") !== normalizedText(currentDate || "")) return false;
    const currentMinutes = parseTimeToMinutes(currentTime);
    const offeredMinutes = parseTimeToMinutes(offeredTime);
    if (currentMinutes === null || offeredMinutes === null) return false;
    return offeredMinutes > currentMinutes;
  }




  if (containsAny(lowered, ["next day", "the next day", "following day", "day after"])) {
    const nextDay = shiftSpokenDateText(currentDate, 1);
    if (nextDay) return normalizedText(offeredDate || "") === normalizedText(nextDay);
    return normalizedText(offeredDate || "") !== normalizedText(currentDate || "");
  }




  return true;
}








function buildExplicitAlternateAvailabilityQuery(dateText, timeText, rawText = "") {
  const safeDate = cleanForSpeech(dateText || "");
  const safeTime = cleanForSpeech(timeText || "");
  const intentText = normalizedText(rawText || "");




  if (!safeDate) return "";
  if (containsAny(intentText, ["later that day", "later the same day", "later in the afternoon", "later that afternoon", "anything later", "something later"])) {
    return `next available callback later than ${safeTime} on ${safeDate}`;
  }
  if (containsAny(intentText, ["next day", "the next day", "following day", "day after"])) {
    const shiftedDate = shiftSpokenDateText(safeDate, 1);
    return shiftedDate ? `next available callback on ${shiftedDate}` : `next available callback after ${safeDate} at ${safeTime}`;
  }
  return `next available callback after ${safeDate} at ${safeTime}`;
}








function buildAlternateAvailabilityOffer(caller, requestedText, availability, previousDate, previousTime, usedNextDayFallback = false) {
  const phrase = spokenAvailabilityPhrase(availability.date, availability.time);
  const lowered = normalizedText(requestedText || "");
  const sameDayAsPrevious = normalizedText(availability.date || "") === normalizedText(previousDate || "");




  if (usedNextDayFallback) {
    return `I don't have anything later that day open, but I do have ${phrase} available. Would you like me to schedule that callback instead?`;
  }




  if (containsAny(lowered, ["later that day", "later the same day", "later in the afternoon", "later that afternoon", "anything later", "something later"])) {
    if (sameDayAsPrevious) {
      return `Yes — I do have ${availability.time} available that same day. Would you like me to schedule that callback instead?`;
    }
    return `I don't have anything later that day open, but I do have ${phrase} available. Would you like me to schedule that callback instead?`;
  }




  if (containsAny(lowered, ["next day", "the next day", "following day", "day after"])) {
    return `I don't have the same day option open, but I do have ${phrase} available. Would you like me to schedule that callback instead?`;
  }




  return `I don't have that exact option open, but I do have ${phrase} available. Would you like me to schedule that callback instead?`;
}








function isMainLineEmergencyCandidate(text) {
  const t = normalizedText(text);
  const yardLike = containsAny(t, ["yard", "front yard", "back yard", "outside", "front lawn", "back lawn"]);
  const mainLike = containsAny(t, [
    "water main", "main line", "main leak", "main broke", "main broken", "main popped",
    "main in my yard", "main in the yard", "water line", "service line", "broken line", "burst line"
  ]) || (containsAny(t, ["main", "line", "water"]) && yardLike);
  const severeLike = containsAny(t, ["popped", "burst", "broke", "broken", "busted", "just busted", "water coming up", "water coming out", "leak", "leaking", "gushing", "pouring"]);
  return mainLike && severeLike;
}








function isOutsideWaterLossEmergency(text) {
  const t = normalizedText(text);
  if (!t) return false;




  const frontYardLike = containsAny(t, ["front yard", "front lawn"]);
  const yardLike = containsAny(t, ["yard", "front yard", "back yard", "front lawn", "back lawn", "outside"]);
  const poolLike = containsAny(t, [
    "pooling", "water pooling", "standing water", "water standing", "water in the yard",
    "water coming up", "water bubbling", "bubbling", "water bubbling up"
  ]);
  const meterLike = containsAny(t, [
    "water meter leak", "meter leak", "leak at the meter", "leaking at the meter",
    "leak by the meter", "water meter"
  ]) && containsAny(t, ["leak", "leaking", "gushing", "pouring", "broken", "busted", "pooling", "water coming up"]);
  const outsideLeakLike = yardLike && containsAny(t, ["leak", "leaking", "gushing", "pouring", "water coming up", "pooling", "standing water"])
    && !containsAny(t, ["faucet", "spigot", "hose bib", "hose bibb", "sprinkler"]);




  return meterLike || (frontYardLike && poolLike) || outsideLeakLike;
}








function isHardEmergency(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "burst", "burst pipe", "flooding", "flooded", "sewer", "sewage", "gas leak", "no water",
    "gushing", "pouring", "water everywhere", "water coming through the ceiling", "ceiling pouring", "water is pouring"
  ]) || isMainLineEmergencyCandidate(t) || isOutsideWaterLossEmergency(t);
}








function isLeakLikeIssue(text) {
  const t = normalizedText(text);
  if (containsAny(t, ["leak", "leaking", "drip", "dripping"])) return true;
  if (containsAny(t, ["water coming", "coming in through", "coming through", "water in your", "water in my", "water through"])) {
    if (containsAny(t, ["ceiling", "roof", "attic", "wall", "basement", "window", "floor"])) return true;
  }
  if ((t.includes("ceiling") || t.includes("roof")) && containsAny(t, ["water", "wet", "rain", "storm", "pouring", "gushing", "coming in", "coming through"])) {
    return true;
  }
  return false;
}








function classifyIssue(issue) {
  const text = normalizedText(issue);
  if (normalizedIssueHasFridgeCoolingProblem(text)) {
    return { summary: "a refrigerator that is not cooling" };
  }
  const serviceItem = detectServiceItem(issue);
  const applianceSummary = buildApplianceIssueSummary(issue, serviceItem);
  if (serviceItem && serviceItem.category === "appliance" && applianceSummary) return { summary: applianceSummary };
  if (serviceItem && serviceItem.category === "fixture" && !hasSpecificProblemDetail(issue)) return { summary: `an issue with ${serviceItem.prompt}` };
  if (isMainLineEmergencyCandidate(text)) {
    if (containsAny(text, ["front yard", "front lawn"])) return { summary: "a main leak in your front yard" };
    if (containsAny(text, ["back yard", "back lawn"])) return { summary: "a main leak in your back yard" };
    if (text.includes("yard")) return { summary: "a main leak in your yard" };
    return { summary: "a possible broken water main" };
  }
  if (isOutsideWaterLossEmergency(text)) {
    if (containsAny(text, ["water meter", "meter"])) return { summary: "a water meter leak" };
    if (containsAny(text, ["front yard", "front lawn"])) return { summary: "a possible water main leak in your front yard" };
    if (containsAny(text, ["back yard", "back lawn"])) return { summary: "a possible water main leak in your back yard" };
    return { summary: "a possible outside water-line leak in your yard" };
  }
  const faucetLike = containsAny(text, ["faucet", "facet", "faucit", "fawcett", "tap"]);
  const kitchenFaucetLike = containsAny(text, ["kitchen faucet", "kitchen facet", "kitchen tap"]);
  const bathroomFaucetLike = containsAny(text, ["bathroom faucet", "bathroom facet", "bathroom tap"]);
  if (kitchenFaucetLike && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaky kitchen faucet" };
  if (bathroomFaucetLike && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaky bathroom faucet" };
  if ((faucetLike || text.includes("sink")) && containsAny(text, ["leak", "drip", "dripping"])) return { summary: text.includes("sink") ? "a leaking sink" : "a leaking faucet" };
  if (text.includes("water heater") && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaking water heater" };
  if (containsAny(text, ["home filter", "house filter", "water filter", "whole house filter", "whole-house filter", "filtration system", "filter housing"]) && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaking home water filter" };
  if (text.includes("roof") && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a roof leak" };
  if (
    text.includes("ceiling") &&
    containsAny(text, ["leak", "drip", "dripping", "pouring", "gushing", "coming in", "coming through", "water coming"])
  ) {
    return { summary: "a ceiling leak" };
  }
  if (containsAny(text, ["clog", "clogged", "drain"])) return { summary: "a clogged drain" };
  if (containsAny(text, ["flood", "flooding", "flooded"])) return { summary: "flooding" };
  if (containsAny(text, ["burst pipe"])) return { summary: "a burst pipe" };
  if (containsAny(text, ["sewer", "sewage"])) return { summary: "a sewer backup" };
  if (containsAny(text, ["gas leak"])) return { summary: "a gas leak" };
  if (containsAny(text, ["no water"])) return { summary: "no water service" };
  if (containsAny(text, ["leak", "leaking", "drip", "dripping"])) return { summary: "a water leak" };
  return { summary: buildUnknownIssueSummary(issue) };
}








function parseSpokenDateText(dateText) {
  const raw = cleanForSpeech(dateText || "");
  const m = raw.match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})$/i);
  if (!m) return null;
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  return { weekday: m[1], month: months[m[2].toLowerCase()], day: Number(m[3]) };
}








function shiftSpokenDateText(dateText, daysToAdd = 0) {
  const parsed = parseSpokenDateText(dateText);
  if (!parsed) return "";
  const current = currentEasternParts();
  let year = Number(current.year);
  const candidateThisYear = new Date(Date.UTC(year, parsed.month - 1, parsed.day));
  const today = new Date(Date.UTC(year, Number(current.month) - 1, Number(current.day)));
  if (candidateThisYear < today) year += 1;
  const shifted = new Date(Date.UTC(year, parsed.month - 1, parsed.day));
  shifted.setUTCDate(shifted.getUTCDate() + Number(daysToAdd || 0));
  const weekday = shifted.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = shifted.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const day = shifted.getUTCDate();
  return `${weekday}, ${month} ${day}`;
}








function spokenAvailabilityPhrase(dateText, timeText) {
  const parsed = parseSpokenDateText(dateText);
  if (!parsed) return `${dateText} at ${timeText}`;
  const current = currentEasternParts();
  const year = Number(current.year);
  const currentDate = new Date(Date.UTC(year, Number(current.month) - 1, Number(current.day)));
  const offeredDate = new Date(Date.UTC(year, parsed.month - 1, parsed.day));
  const diffDays = Math.round((offeredDate - currentDate) / 86400000);
  if (diffDays === 0) return `today at ${timeText}`;
  if (diffDays === 1) return `tomorrow at ${timeText}`;
  return `${dateText} at ${timeText}`;
}








function detectTimePreference(text) {
  const t = normalizedText(text);
  if (containsAny(t, ["morning", "mornings", "early morning"])) return "morning";
  if (containsAny(t, ["afternoon", "afternoons", "later in the day"])) return "afternoon";
  if (containsAny(t, ["evening", "evenings", "tonight"])) return "evening";
  if (containsAny(t, ["any time", "anytime", "whenever"])) return "anytime";
  return "";
}








function isSpecificTime(text) {
  const t = normalizedText(text);
  const numericTime = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(t) || /\b\d{1,2}:\d{2}\b/i.test(t);
  const namedTime = /\b(noon|midnight)\b/i.test(t);
  const spokenClock = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(o[' ]?clock|thirty|fifteen|forty[- ]?five)?\b/i.test(t);
  const spokenParts = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(in\s+the\s+morning|in\s+the\s+afternoon|in\s+the\s+evening)\b/i.test(t);
  const halfPast = /\bhalf\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(t);
  const atBareHour = /\b(?:at|@)\s+\d{1,2}\b/.test(t) || /\b(?:at|@)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(t);
  const aroundBareHour = /\b(?:around|about|like|near)\s+\d{1,2}\b/.test(t)
    || /\b(?:around|about|like|near)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(t);
  return numericTime || namedTime || spokenClock || spokenParts || halfPast || atBareHour || aroundBareHour;
}








function isFirstAvailableRequest(text) {
  const t = normalizedText(text);
  return containsAny(t, FIRST_AVAILABLE_PHRASES);
}








function isAlternateAvailabilityRequest(text) {
  const t = normalizedText(text);
  return containsAny(t, ALT_SLOT_PHRASES);
}








function isRepeatTimeRequest(text) {
  const t = normalizedText(text);
  return containsAny(t, REPEAT_TIME_PHRASES);
}








function wantsOfficeCallback(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "have someone call me", "have somebody call me", "call me back", "callback",
    "just have the office call", "office can call", "have the office call",
    "someone from the office can call", "somebody from the office can call"
  ]);
}








function looksLikeAddressCorrection(text) {
  const t = normalizedText(text);
  if (!t) return false;
  if (isAffirmative(t) || isNegative(t)) return false;




  const startsLikeCorrection = /^((no\s+wait)|(actually)|(it s)|(its)|(it is)|(wait)|(sorry))\b/.test(t);
  const confirmationish = /^(it\s+is|it s|its|that\s+is|that s|thats)\s+(yes|yeah|yep|yup|correct|right)$/i.test(t);
  const hasAddressSignals = /\d/.test(t)
    || containsAny(t, [
      "street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "dr",
      "boulevard", "blvd", "court", "ct", "circle", "cir", "way", "highway", "hwy",
      "parkway", "pkwy", "suite", "unit", "apartment", "apt", "city"
    ]);




  if (confirmationish) return false;
  if (hasAddressSignals) return true;
  if (startsLikeCorrection && t.split(/\s+/).filter(Boolean).length >= 2) return true;
  return false;
}








function extractDatePart(text) {
  const value = cleanForSpeech(text || "");
  if (!value) return "";

  // Explicit month/day like "April 22", "April 22nd", "Apr 22", optionally with year.
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthAbbrevs = {
    jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
    jul: "July", aug: "August", sep: "September", sept: "September", oct: "October", nov: "November", dec: "December"
  };
  const monthDayMatch = value.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i
  );
  if (monthDayMatch) {
    const rawMonth = monthDayMatch[1].toLowerCase();
    const month = monthAbbrevs[rawMonth] || toTitleCase(rawMonth);
    const day = String(Number(monthDayMatch[2]));
    const year = monthDayMatch[3] ? String(Number(monthDayMatch[3])) : "";
    return year ? `${month} ${day} ${year}` : `${month} ${day}`;
  }

  // Numeric formats like 4/22, 04-22, 4/22/2026, 04-22-26.
  const numericMatch = value.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numericMatch) {
    const mm = Number(numericMatch[1]);
    const dd = Number(numericMatch[2]);
    const yyyyRaw = numericMatch[3] ? String(numericMatch[3]) : "";
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const month = monthNames[mm - 1];
      const year = yyyyRaw
        ? (yyyyRaw.length === 2 ? `20${yyyyRaw}` : `${Number(yyyyRaw)}`)
        : "";
      return year ? `${month} ${dd} ${year}` : `${month} ${dd}`;
    }
  }

  const relativeMatch = value.match(/\b(today|tomorrow|next week|this week)\b/i);
  if (relativeMatch) return cleanForSpeech(relativeMatch[1]);

  const qualifiedWeekdayMatch = value.match(/\b(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (qualifiedWeekdayMatch) {
    return `${toTitleCase(qualifiedWeekdayMatch[1])} ${toTitleCase(qualifiedWeekdayMatch[2])}`;
  }

  const weekdayMatch = value.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) return toTitleCase(weekdayMatch[1]);

  if (/\b(?:in\s+)?two\s+weeks\b/i.test(value)) return "in two weeks";
  if (/\b(?:in\s+)?three\s+weeks\b/i.test(value)) return "in three weeks";
  if (/\b(?:in\s+)?(?:a|one)\s+week\b/i.test(value)) return "in one week";
  const inWeeks = value.match(/\b(?:in\s+)?(\d{1,2})\s+weeks?\b/i);
  if (inWeeks) {
    const w = Number(inWeeks[1]);
    if (w >= 1 && w <= 52) return `in ${w} weeks`;
  }
  const inDays = value.match(/\b(?:in\s+)?(\d{1,3})\s+days?\b/i);
  if (inDays) {
    const d = Number(inDays[1]);
    if (d >= 1 && d <= 120) return `in ${d} days`;
  }

  return "";
}

function resolveRequestedDateToSpokenDate(dateText) {
  const raw = cleanForSpeech(dateText || "");
  if (!raw) return "";

  // Already in the canonical spoken format we use elsewhere.
  if (parseSpokenDateText(raw)) return raw;

  const current = currentEasternParts();
  const todayUtc = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day)));

  const weekdayIndex = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
  };

  const formatUtcToSpoken = (dt) => {
    const weekday = dt.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const month = dt.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    const day = dt.getUTCDate();
    return `${weekday}, ${month} ${day}`;
  };

  const lowered = raw.toLowerCase();
  if (lowered === "today") return formatUtcToSpoken(todayUtc);
  if (lowered === "tomorrow") {
    const dt = new Date(todayUtc.getTime());
    dt.setUTCDate(dt.getUTCDate() + 1);
    return formatUtcToSpoken(dt);
  }

  const inDaysMatch = lowered.match(/^in\s+(\d{1,3})\s+days?$/);
  if (inDaysMatch) {
    const n = Math.min(Number(inDaysMatch[1]) || 0, 120);
    if (n > 0) {
      const dt = new Date(todayUtc.getTime());
      dt.setUTCDate(dt.getUTCDate() + n);
      return formatUtcToSpoken(dt);
    }
  }

  const inWeeksMatch = lowered.match(/^in\s+(\d{1,2})\s+weeks?$/);
  if (inWeeksMatch) {
    const w = Math.min(Number(inWeeksMatch[1]) || 0, 52);
    if (w > 0) {
      const dt = new Date(todayUtc.getTime());
      dt.setUTCDate(dt.getUTCDate() + w * 7);
      return formatUtcToSpoken(dt);
    }
  }

  if (
    lowered === "in one week" ||
    lowered === "one week" ||
    lowered === "a week" ||
    lowered === "in a week"
  ) {
    const dt = new Date(todayUtc.getTime());
    dt.setUTCDate(dt.getUTCDate() + 7);
    return formatUtcToSpoken(dt);
  }

  if (lowered === "in two weeks" || lowered === "two weeks") {
    const dt = new Date(todayUtc.getTime());
    dt.setUTCDate(dt.getUTCDate() + 14);
    return formatUtcToSpoken(dt);
  }

  if (lowered === "in three weeks" || lowered === "three weeks") {
    const dt = new Date(todayUtc.getTime());
    dt.setUTCDate(dt.getUTCDate() + 21);
    return formatUtcToSpoken(dt);
  }

  if (lowered === "next week" || lowered === "the following week") {
    const dt = new Date(todayUtc.getTime());
    dt.setUTCDate(dt.getUTCDate() + 7);
    return formatUtcToSpoken(dt);
  }

  const qualifiedWeekday = raw.match(/^(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  const plainWeekday = raw.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  if (qualifiedWeekday || plainWeekday) {
    const qualifier = qualifiedWeekday ? qualifiedWeekday[1].toLowerCase() : "";
    const weekday = (qualifiedWeekday ? qualifiedWeekday[2] : plainWeekday[1]).toLowerCase();
    const target = weekdayIndex[weekday];
    const todayIdx = todayUtc.getUTCDay();
    let delta = (target - todayIdx + 7) % 7;

    // "Tuesday" should mean the next occurrence (not "today" if today is Tuesday).
    if (!qualifier && delta === 0) delta = 7;
    // "this Tuesday" can be today if today is Tuesday.
    if (qualifier === "this") {
      // keep delta as-is
    }
    // "next Tuesday" should always be at least 7 days ahead.
    if (qualifier === "next") {
      delta = (delta === 0 ? 7 : delta) + 7;
    }

    const dt = new Date(todayUtc.getTime());
    dt.setUTCDate(dt.getUTCDate() + delta);
    return formatUtcToSpoken(dt);
  }

  // Month day (optionally with year) like "April 22" or "April 22 2026".
  const monthDay = raw.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s+(\d{4}))?$/i);
  if (monthDay) {
    const months = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
    };
    let year = monthDay[3] ? Number(monthDay[3]) : Number(current.year);
    const month = months[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    let candidate = new Date(Date.UTC(year, month - 1, day));
    if (!monthDay[3] && candidate < todayUtc) {
      year += 1;
      candidate = new Date(Date.UTC(year, month - 1, day));
    }
    return formatUtcToSpoken(candidate);
  }

  return raw;
}

function extractSpecificTimeText(text) {
  const value = cleanForSpeech(text || "");
  if (!value) return "";

  const numericMatch = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (numericMatch) {
    const hour = String(Number(numericMatch[1]));
    const minute = numericMatch[2] || "00";
    const meridiem = numericMatch[3].toUpperCase();
    return `${hour}:${minute} ${meridiem}`;
  }

  const namedMatch = value.match(/\b(noon|midnight)\b/i);
  if (namedMatch) return cleanForSpeech(namedMatch[1]).toLowerCase();

  const hourWords = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
  };
  const atWordHour = value.match(/\b(?:at|@)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i);
  if (atWordHour) {
    const tailWord = value.slice(atWordHour.index + atWordHour[0].length);
    if (!/^\s*[ap]\.?\s*m\.?\b/i.test(tailWord)) {
      const h = hourWords[atWordHour[1].toLowerCase()];
      if (h >= 1 && h <= 11) return `${h}:00 PM`;
      if (h === 12) return `12:00 PM`;
    }
  }

  const bareAtHour = value.match(/\b(?:at|@)\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (bareAtHour) {
    const tail = value.slice(bareAtHour.index + bareAtHour[0].length);
    if (!/^\s*[ap]\.?\s*m\.?\b/i.test(tail)) {
      const h = Number(bareAtHour[1]);
      const minute = bareAtHour[2] ? String(Number(bareAtHour[2])).padStart(2, "0") : "00";
      if (h >= 1 && h <= 11) return `${h}:${minute} PM`;
      if (h === 12) return `12:${minute} PM`;
    }
  }

  const aroundDigit = value.match(/\b(?:around|about|like|near|maybe)\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (aroundDigit) {
    const tailA = value.slice(aroundDigit.index + aroundDigit[0].length);
    if (!/^\s*[ap]\.?\s*m\.?\b/i.test(tailA)) {
      const h = Number(aroundDigit[1]);
      const minute = aroundDigit[2] ? String(Number(aroundDigit[2])).padStart(2, "0") : "00";
      if (h >= 1 && h <= 11) return `${h}:${minute} PM`;
      if (h === 12) return `12:${minute} PM`;
    }
  }

  const aroundWord = value.match(/\b(?:around|about|like|near)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i);
  if (aroundWord) {
    const tailW = value.slice(aroundWord.index + aroundWord[0].length);
    if (!/^\s*[ap]\.?\s*m\.?\b/i.test(tailW)) {
      const h = hourWords[aroundWord[1].toLowerCase()];
      if (h >= 1 && h <= 11) return `${h}:00 PM`;
      if (h === 12) return `12:00 PM`;
    }
  }

  return "";
}

function hasExplicitSchedulingRequest(text) {
  return Boolean(extractDatePart(text) || extractSpecificTimeText(text) || detectTimePreference(text));
}








function buildAvailabilityRawQuery(rawText, existingDate = "", existingTime = "") {
  const raw = cleanForSpeech(rawText || "");
  if (!raw) return "";
  const t = normalizedText(raw);
  if (containsAny(t, ["later that day", "later the same day", "later that afternoon", "later in the afternoon"]) && existingDate) {
    return `${raw} on ${existingDate}${existingTime ? ` after ${existingTime}` : ""}`;
  }
  if (containsAny(t, ["next day", "the next day", "following day", "day after"]) && existingDate) {
    const shiftedDate = shiftSpokenDateText(existingDate, 1);
    if (shiftedDate) return `${raw} on ${shiftedDate}`;
  }
  return raw;
}








function parseAvailabilityRequest(text, existingDate = "", existingTime = "") {
  const raw = cleanForSpeech(text || "");
  let requestedDate = extractDatePart(raw);
  const requestedExactTime = extractSpecificTimeText(raw);
  const requestedTimePreference = requestedExactTime || detectTimePreference(raw);
  if (!requestedDate && existingDate && isAlternateAvailabilityRequest(raw)) requestedDate = existingDate;
  const requestedDateResolved = resolveRequestedDateToSpokenDate(requestedDate || existingDate || "");
  const rawQuery = buildAvailabilityRawQuery(raw, requestedDateResolved || existingDate, existingTime);
  return {
    rawQuery,
    requestedDate: requestedDate || existingDate || "",
    requestedDateResolved,
    requestedTimePreference,
    requestedExactTime
  };
}








function addMinutesToLocalDateTime(localDateTime, minutesToAdd) {
  const [datePart, timePart] = String(localDateTime || "").split("T");
  if (!datePart || !timePart) return "";
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutesToAdd);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mi = String(dt.getUTCMinutes()).padStart(2, "0");
  const ss = String(dt.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}








function parseCallbackDateAndTimeToLocal(dateText, timeText) {
  const safeDate = cleanForSpeech(dateText || "");
  const safeTime = cleanForSpeech(timeText || "");
  const dateMatch = safeDate.match(/^(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})$/i);
  const timeMatch = safeTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!dateMatch || !timeMatch) return null;
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  const current = currentEasternParts();
  let year = Number(current.year);
  const month = months[dateMatch[1].toLowerCase()];
  const day = Number(dateMatch[2]);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  const currentDateOnly = `${current.year}-${current.month}-${current.day}`;
  const candidateDateOnly = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (candidateDateOnly < currentDateOnly) year += 1;
  const startLocal = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const endLocal = addMinutesToLocalDateTime(startLocal, 30);
  return { startLocal, endLocal };
}








function nextPromptIndex(caller, key) {
  const current = Number.isInteger(caller[key]) ? caller[key] : 0;
  caller[key] = current + 1;
  return current;
}








function buildCalendarLookupPrompt(caller, rawText, mode = "general") {
  const firstAvailablePrompts = [
    "Okay, I'm looking at the calendar now and checking for the first available date for you.",
    "Okay, I'm looking at the calendar now and checking for the first available date for you.",
    "Okay, I'm looking at the calendar now and checking for the first available date for you."
  ];








  const specificDatePrompts = [
    "Alright, let me see if that slot is available.",
    "Let me see if that time is open.",
    "Let me check whether that slot is available."
  ];








  const alternatePrompts = [
    "Let's see what else I have available.",
    "Let me see what I have later that day.",
    "Alright, let me see what else is open."
  ];








  const generalPrompts = [
    "Let me see what's available.",
    "I already have the calendar up. Let me see what's available.",
    "Let me take a look and see what I have open."
  ];








  let options = generalPrompts;
  if (mode === "first_available" || isFirstAvailableRequest(rawText)) options = firstAvailablePrompts;
  else if (mode === "alternate" || isAlternateAvailabilityRequest(rawText)) options = alternatePrompts;
  else if (mode === "specific_date" || extractDatePart(rawText)) options = specificDatePrompts;








  const index = nextPromptIndex(caller, "calendarPromptIndex");
  return options[index % options.length];
}








function detectCalendarLookupMode(rawText = "") {
  if (isFirstAvailableRequest(rawText)) return "first_available";
  if (isAlternateAvailabilityRequest(rawText)) return "alternate";
  if (extractDatePart(rawText) || isSpecificTime(rawText) || detectTimePreference(rawText)) return "specific_date";
  return "general";
}








function announceCalendarLookup(ws, caller, rawText = "", explicitMode = "") {
  const mode = explicitMode || detectCalendarLookupMode(rawText);
  sendText(ws, buildCalendarLookupPrompt(caller, rawText, mode), { remember: false });
}








function buildSchedulingChoicePrompt(caller) {
  const variants = [
    "Do you have a date in mind, or can I schedule the first available?",
    "Would you like to give me a date, or can I schedule the first available?",
    "Do you have a specific date in mind, or can I schedule the first available?",
    "If you already know a day that works, we can start there—or I can look for the first open slot.",
    "Some folks have a day picked out already, and some just want the soonest opening—either one works."
  ];




  const index = nextPromptIndex(caller, "scheduleChoicePromptIndex");
  return variants[index % variants.length];
}








function buildCallbackOfferPrompt(caller, dateText, timeText) {
  const phrase = spokenAvailabilityPhrase(dateText, timeText);
  const variants = [
    `I have ${phrase} available. Can I go ahead and schedule that callback for you?`,
    `Alright, I have ${phrase} available. Would you like me to schedule that callback?`,
    `I've got ${phrase} available. Can I go ahead and book that callback for you?`
  ];








  const index = nextPromptIndex(caller, "callbackOfferIndex");
  return variants[index % variants.length];
}








function getOrCreateCaller(key) {
  if (!callerStore[key]) {
    callerStore[key] = {
      sessionKey: key,
      callSid: "",
      phone: "",
      fullName: "",
      firstName: "",
      companyName: "",
      callbackNumber: "",
      callbackConfirmed: null,
      address: "",
      issue: "",
      issueSummary: "",
      issueIsCapabilityQuestion: false,
      urgency: "normal",
      emergencyAlert: false,
      leadType: "service",
      projectType: "",
      timeline: "",
      proposalDeadline: "",
      demoEmail: "",
      projectScopeNotes: "",
      notes: "",
      status: "new_lead",
      appointmentDate: "",
      appointmentTime: "",
      requestedDate: "",
      requestedTimePreference: "",
      pendingOfferedDate: "",
      pendingOfferedTime: "",
      pendingAvailabilityQuery: "",
      calendarSlotConfirmed: false,
      bookingSent: false,
      bookingSending: false,
      makeSent: false,
      makeSending: false,
      demoFollowupRequested: false,
      demoFollowupSent: false,
      demoFollowupSending: false,
      lastStep: "ask_issue",
      pendingNameNextStep: "",
      nameSpellingConfirmed: false,
      pendingIssueItem: "",
      pendingIssuePrompt: "",
      pendingPromptText: "",
      pendingLateDayDate: "",
      pendingUpdatedContactFirstName: "",
      pendingUpdatedContactFullName: "",
      resumeStepAfterPhoneUpdate: "",
      pendingLeadResubmission: false,
      repeatPromptIndex: 0,
      promptBuffer: "",
      pendingGreetingPrompt: "",
      greetingContinuationTimer: null,
      demoFollowupContactName: "",
      demoFollowupCallbackNumber: "",
      demoFollowupEmail: "",
      additionalIssues: [],
      calendarPromptIndex: 0,
      scheduleChoicePromptIndex: 0,
      callbackOfferIndex: 0,
      lateDayPromptIndex: 0,
      alexEmotionalTone: "neutral",
      alexEmpathyPrefixCount: 0,
      alexAssistantTurnCount: 0,
      alexPlayfulLeadIns: 0,
      techNotesVariantIndex: 0,
      quoteNotesVariantIndex: 0,
      addressRequestPromptIndex: 0,
      applianceBrand: "",
      applianceTypeDetail: "",
      applianceCoverage: "",
      applianceSymptomCaptured: false,
      applianceIntakeMergedIssue: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
  callerStore[key].updatedAt = new Date().toISOString();
  return callerStore[key];
}








function isPhoneCaptureStep(step = "") {
  return new Set([
    "confirm_phone",
    "get_new_phone",
    "capture_updated_callback_number",
    "ask_demo_followup_phone"
  ]).has(step);
}

function isFreeformSpeechStep(step = "") {
  return new Set([
    "ask_issue",
    "ask_issue_again",
    "ask_item_issue_detail",
    "appliance_service_intake",
    "ask_notes"
  ]).has(step);
}

function isLikelyMidThought(text = "") {
  const safe = cleanSpeechText(text || "").toLowerCase();
  if (!safe) return false;
  if (/[,:;\-]\s*$/.test(safe)) return true;
  if (/\b(and|or|but|so|because|that|which|with|for|to|about|on|at|in|of|um|uh)\s*$/.test(safe)) return true;
  return false;
}

function promptFinalizeDelayForCaller(caller, fallbackMs = PROMPT_FINALIZE_TIMEOUT_MS, bufferedText = "") {
  if (!caller) return fallbackMs;
  if (isPhoneCaptureStep(caller.lastStep)) {
    return PHONE_PROMPT_FINALIZE_TIMEOUT_MS;
  }
  if (caller.lastStep === "ask_issue" || caller.lastStep === "ask_issue_again") {
    const base = OPENER_PROMPT_FINALIZE_TIMEOUT_MS;
    return isLikelyMidThought(bufferedText) ? base + MID_THOUGHT_EXTRA_MS : base;
  }
  if (isFreeformSpeechStep(caller.lastStep)) {
    const base = FREEFORM_PROMPT_FINALIZE_TIMEOUT_MS;
    return isLikelyMidThought(bufferedText) ? base + MID_THOUGHT_EXTRA_MS : base;
  }
  return fallbackMs;
}


function isGreetingOnlyPrompt(text = "") {
  const safe = cleanSpeechText(text || "");
  if (!safe) return false;
  return /^(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)\s*,?\s*(?:alex)?[.!?]*$/i.test(safe);
}

function clearGreetingContinuationTimer(caller) {
  if (!caller || !caller.greetingContinuationTimer) return;
  clearTimeout(caller.greetingContinuationTimer);
  caller.greetingContinuationTimer = null;
}

function shouldHoldGreetingForContinuation(caller, completePrompt = "") {
  if (!caller) return false;
  if (!(caller.lastStep === "ask_issue" || caller.lastStep === "ask_issue_again")) return false;
  return isGreetingOnlyPrompt(completePrompt);
}

function scheduleGreetingContinuationGrace(ws, caller, greetingText) {
  if (!caller) return;
  clearGreetingContinuationTimer(caller);
  caller.pendingGreetingPrompt = cleanSpeechText(greetingText || "");
  caller.greetingContinuationTimer = setTimeout(async () => {
    if (!ws || ws.readyState !== 1) return;
    const currentCaller = getOrCreateCaller(ws.sessionKey);
    currentCaller.greetingContinuationTimer = null;
    const pendingGreeting = cleanSpeechText(currentCaller.pendingGreetingPrompt || "");
    currentCaller.pendingGreetingPrompt = "";
    if (!pendingGreeting) return;
    if (cleanSpeechText(currentCaller.promptBuffer || "")) {
      currentCaller.promptBuffer = `${pendingGreeting}${currentCaller.promptBuffer ? " " + currentCaller.promptBuffer : ""}`;
      try {
        await processBufferedPrompt(ws, currentCaller);
      } catch (err) {
        console.error("[PROMPT FINALIZE ERROR]", err && err.message);
        sendText(ws, "I'm sorry, something went wrong. Could you say that again?");
      }
      return;
    }
    try {
      await handlePrompt(ws, currentCaller, pendingGreeting);
    } catch (err) {
      console.error("[GREETING CONTINUATION ERROR]", err && err.message);
      sendText(ws, "I'm sorry, something went wrong. Could you say that again?");
    }
  }, Math.max(200, GREETING_CONTINUATION_GRACE_MS));
}




function lightlyPaceText(text) {
  const safe = cleanForSpeech(text || "");
  if (!safe) return "";
  return safe
    .replace(/\b(Alright|Okay|Perfect|Absolutely)\. /g, "$1, ")
    .replace(/\b(Thank you)\. /g, "$1, ")
    .trim();
}








function sendText(ws, text, options = {}) {
  if (!ws || ws.readyState !== 1) return;
  const caller = ws.sessionKey ? getOrCreateCaller(ws.sessionKey) : null;
  if (caller && options.remember !== false) {
    caller.pendingPromptText = cleanForSpeech(text || "");
  }
  let message = String(text || "");
  if (caller && options.raw !== true && options.tone !== false) {
    caller.alexAssistantTurnCount = (caller.alexAssistantTurnCount || 0) + 1;
    message = applyAlexConversationalToneLayer(caller, message, options);
  }
  const pacedText = options.raw === true ? message : lightlyPaceText(message);


  const now = Date.now();
  const baseDelay = Number.isFinite(options.delayMs) ? options.delayMs : RESPONSE_THINK_DELAY_MS;
  const afterPreviousMs = Number.isFinite(options.afterPreviousMs) ? options.afterPreviousMs : 120;
  const nextAvailable = typeof ws._nextSendAt === "number" ? ws._nextSendAt : now;
  const sendAt = Math.max(now + baseDelay, nextAvailable + afterPreviousMs);
  ws._nextSendAt = sendAt;


  setTimeout(() => {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({
        type: "text",
        token: pacedText,
        last: true,
        interruptible: options.interruptible !== false,
        preemptible: options.preemptible === true
      }));
    } catch (err) {
      console.error("[WS SEND ERROR]", err && err.message);
    }
  }, Math.max(0, sendAt - now));
}






function clearPromptFinalizeTimer(caller) {
  if (!caller || !caller.promptFinalizeTimer) return;
  clearTimeout(caller.promptFinalizeTimer);
  caller.promptFinalizeTimer = null;
}




async function processBufferedPrompt(ws, caller, fallbackText = "") {
  if (!caller || caller.processingPrompt) return false;


  clearPromptFinalizeTimer(caller);
  const completePrompt = cleanSpeechText(caller.promptBuffer || fallbackText || "");
  if (!completePrompt) return false;


  caller.promptBuffer = "";
  if (shouldHoldGreetingForContinuation(caller, completePrompt)) {
    scheduleGreetingContinuationGrace(ws, caller, completePrompt);
    return true;
  }


  caller.processingPrompt = true;
  try {
    await handlePrompt(ws, caller, completePrompt);
    return true;
  } catch (err) {
    console.error("[HANDLE PROMPT ERROR]", err && err.message, err && err.stack);
    sendText(ws, "I'm sorry, something went wrong on my side. Could you say that once more?");
    return true;
  } finally {
    caller.processingPrompt = false;
    if (cleanSpeechText(caller.promptBuffer || "")) {
      schedulePromptFinalize(ws, caller, promptFinalizeDelayForCaller(caller, 200, caller.promptBuffer || ""));
    }
  }
}




function schedulePromptFinalize(ws, caller, delayMs) {
  delayMs = promptFinalizeDelayForCaller(caller, delayMs ?? PROMPT_FINALIZE_TIMEOUT_MS, caller && caller.promptBuffer ? caller.promptBuffer : "");
  if (!caller) return;


  clearPromptFinalizeTimer(caller);
  const generation = (Number(caller.promptProcessGeneration) || 0) + 1;
  caller.promptProcessGeneration = generation;


  caller.promptFinalizeTimer = setTimeout(async () => {
    if (!ws || ws.readyState !== 1) return;
    const currentCaller = getOrCreateCaller(ws.sessionKey);
    if (currentCaller.promptProcessGeneration !== generation) return;
    if (!cleanSpeechText(currentCaller.promptBuffer || "")) return;
    try {
      await processBufferedPrompt(ws, currentCaller);
    } catch (err) {
      console.error("[PROMPT FINALIZE ERROR]", err.message);
    }
  }, Math.max(150, delayMs));
}






function estimateSpeechDurationMs(text) {
  const safe = cleanForSpeech(text || "");
  if (!safe) return 0;








  const commaCount = (safe.match(/[,;:]/g) || []).length;
  const stopCount = (safe.match(/[.!?]/g) || []).length;
  const estimated = 1800 + (safe.length * 58) + (commaCount * 200) + (stopCount * 320);








  return Math.max(CLOSE_SESSION_MIN_MS, Math.min(CLOSE_SESSION_MAX_MS, estimated));
}








function closeSession(ws, text) {
  if (text) sendText(ws, text, { interruptible: false, preemptible: false, remember: false });
  setTimeout(() => {
    try { ws.close(); } catch (err) {}
  }, text ? estimateSpeechDurationMs(text) : 0);
}








function queueBackgroundTask(label, taskFn) {
  setTimeout(async () => {
    try {
      await taskFn();
    } catch (err) {
      console.error(`[${label} BACKGROUND ERROR]`, err.message);
    }
  }, 0);
}








function buildMakePayload(caller) {
  const leadType = caller.leadType || (caller.emergencyAlert ? "emergency" : "service");
  let notes = caller.notes || "";








  if (leadType === "quote") {
    const quoteNotes = [];
    if (caller.timeline) quoteNotes.push(`Project timeline or start date: ${caller.timeline}`);
    const scope = caller.projectScopeNotes || "";
    if (scope) quoteNotes.push(`Project scope: ${scope}`);
    if (caller.proposalDeadline) quoteNotes.push(`Quote or proposal deadline: ${caller.proposalDeadline}`);
    if (caller.demoEmail) quoteNotes.push(`Email address: ${caller.demoEmail}`);
    if (notes) quoteNotes.push(`Additional notes: ${notes}`);
    notes = quoteNotes.join(" | ");
  }








  if (Array.isArray(caller.additionalIssues) && caller.additionalIssues.length) {
    const joined = caller.additionalIssues.join(" | ");
    notes = notes ? `${notes} | Additional issues: ${joined}` : `Additional issues: ${joined}`;
  }








  return {
    leadType,
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    companyName: caller.companyName || "",
    phone: caller.phone || "",
    callbackNumber: caller.callbackNumber || caller.phone || "",
    callbackConfirmed: caller.callbackConfirmed === true,
    address: caller.address || "",
    issue: caller.issue || caller.projectType || "",
    issueSummary: caller.issueSummary || caller.projectType || "",
    urgency: caller.urgency || "normal",
    emergencyAlert: caller.emergencyAlert === true,
    projectType: caller.projectType || "",
    applianceType: [caller.applianceBrand, caller.applianceTypeDetail].filter(Boolean).join(" · ") || "",
    applianceWarranty:
      caller.applianceCoverage === "warranty"
        ? "Manufacturer warranty"
        : caller.applianceCoverage === "extended_or_plan"
          ? "Extended warranty / plan"
          : caller.applianceCoverage === "billable"
            ? "Billable / out-of-pocket"
            : caller.applianceCoverage === "unknown"
              ? "Coverage unknown"
              : "",
    timeline: caller.timeline || "",
    proposalDeadline: caller.proposalDeadline || "",
    demoEmail: caller.demoEmail || "",
    notes,
    status: caller.status || "new_lead",
    appointmentDate: caller.appointmentDate || "",
    appointmentTime: caller.appointmentTime || "",
    source: "AI Receptionist",
    timestamp: new Date().toISOString()
  };
}
















function shouldSendToMake(caller) {
  if (caller.leadType === "quote") return Boolean(caller.fullName && (caller.callbackNumber || caller.phone) && caller.projectType);
  if (caller.leadType === "demo") return Boolean(caller.fullName && (caller.callbackNumber || caller.phone || caller.demoEmail));
  return Boolean(caller.fullName && (caller.callbackNumber || caller.phone) && caller.issueSummary);
}








function postJsonToWebhook(webhookUrl, payload, label, timeoutMs = WEBHOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(payload);
      const url = new URL(webhookUrl);
      const options = {
        hostname: url.hostname,
        path: `${url.pathname}${url.search || ""}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        }
      };








      let settled = false;
      const finalize = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };








      const req = https.request(options, (webhookRes) => {
        let body = "";
        webhookRes.on("data", (chunk) => { body += chunk; });
        webhookRes.on("end", () => {
          console.log(`[${label}] Status: ${webhookRes.statusCode}`);
          finalize({ statusCode: webhookRes.statusCode, body });
        });
      });








      req.setTimeout(timeoutMs, () => {
        console.error(`[${label} TIMEOUT] ${timeoutMs}ms`);
        req.destroy(new Error("Request timed out"));
        finalize(null);
      });








      req.on("error", (err) => {
        console.error(`[${label} ERROR]`, err.message);
        finalize(null);
      });








      req.write(data);
      req.end();
    } catch (err) {
      console.error(`[${label} ERROR]`, err.message);
      resolve(null);
    }
  });
}








async function sendLeadToMake(caller, force = false) {
  if (!shouldSendToMake(caller)) return;
  if (caller.makeSending) {
    if (force) caller.pendingLeadResubmission = true;
    return;
  }
  if (!force && caller.makeSent) return;

  caller.makeSending = true;
  const result = await postJsonToWebhook(MAKE_WEBHOOK_URL, buildMakePayload(caller), "MAKE", SUBMISSION_TIMEOUT_MS);
  caller.makeSending = false;
  if (result && result.statusCode >= 200 && result.statusCode < 300) {
    caller.makeSent = true;
  }

  if (caller.pendingLeadResubmission) {
    caller.pendingLeadResubmission = false;
    caller.makeSent = false;
    queueBackgroundTask("MAKE RESUBMIT", async () => {
      await sendLeadToMake(caller, true);
    });
  }
}








function buildBookingPayload(caller) {
  if (!caller.calendarSlotConfirmed || !caller.appointmentDate || !caller.appointmentTime) return null;
  if (!isAllowedCallbackStartTime(caller.appointmentTime)) return null;
  const slotTimes = parseCallbackDateAndTimeToLocal(caller.appointmentDate, caller.appointmentTime);
  if (!slotTimes) return null;
  return {
    action: "create_callback_booking",
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    companyName: caller.companyName || "",
    phone: caller.phone || "",
    callbackNumber: caller.callbackNumber || caller.phone || "",
    issueSummary: caller.issueSummary || "",
    address: caller.address || "",
    leadType: caller.leadType || "service",
    notes: caller.notes || "",
    appointmentDate: caller.appointmentDate || "",
    appointmentTime: caller.appointmentTime || "",
    bookingStartDateTimeLocal: slotTimes.startLocal,
    bookingEndDateTimeLocal: slotTimes.endLocal,
    start: slotTimes.startLocal,
    end: slotTimes.endLocal,
    source: "AI Receptionist"
  };
}








async function sendBookingToMake(caller) {
  if (caller.bookingSent || caller.bookingSending) return;
  const payload = buildBookingPayload(caller);
  if (!payload) {
    console.warn("[BOOKING SKIPPED]", JSON.stringify({
      calendarSlotConfirmed: caller.calendarSlotConfirmed,
      appointmentDate: caller.appointmentDate || "",
      appointmentTime: caller.appointmentTime || "",
      fullName: caller.fullName || "",
      callbackNumber: caller.callbackNumber || caller.phone || ""
    }));
    return;
  }
  console.log("[BOOKING PAYLOAD]", JSON.stringify(payload));
  caller.bookingSending = true;
  const result = await postJsonToWebhook(BOOKING_WEBHOOK_URL, payload, "BOOKING", SUBMISSION_TIMEOUT_MS);
  caller.bookingSending = false;
  if (result && result.statusCode >= 200 && result.statusCode < 300) {
    caller.bookingSent = true;
  } else {
    console.error("[BOOKING FAILED]", result ? result.statusCode : "no response");
  }
}








async function submitPrimaryLeadAndBooking(caller, options = {}) {
  await sendLeadToMake(caller, options.forceLead === true);
  await sendBookingToMake(caller);
}








function queuePrimaryLeadAndBooking(caller, options = {}) {
  queueBackgroundTask("PRIMARY SUBMIT", async () => {
    await submitPrimaryLeadAndBooking(caller, options);
  });
}








function buildDemoFollowupPayload(caller) {
  const fullName = caller.demoFollowupContactName || caller.fullName || "";
  const firstName = getFirstName(fullName) || caller.firstName || "";
  const callbackNumber = caller.demoFollowupCallbackNumber || caller.callbackNumber || caller.phone || "";
  const demoEmail = caller.demoFollowupEmail || caller.demoEmail || "";








  let notes = "Interested in a Blue Caller Automation follow-up after testing the demo line.";
  if (caller.issueSummary) notes += ` Original demo scenario: ${caller.issueSummary}.`;
  if (caller.notes) notes += ` Original notes: ${caller.notes}`;








  return {
    leadType: "demo",
    fullName,
    firstName,
    phone: callbackNumber,
    callbackNumber,
    callbackConfirmed: true,
    address: caller.address || "",
    issue: "demo follow-up request",
    issueSummary: "demo follow-up request",
    urgency: "normal",
    emergencyAlert: false,
    projectType: "",
    applianceType: "",
    applianceWarranty: "",
    timeline: "",
    proposalDeadline: "",
    demoEmail,
    notes: notes.trim(),
    status: "demo_followup_request",
    appointmentDate: "",
    appointmentTime: "",
    source: "AI Receptionist",
    timestamp: new Date().toISOString()
  };
}








async function sendDemoFollowupToMake(caller) {
  if (caller.demoFollowupSent || caller.demoFollowupSending) return;
  const payload = buildDemoFollowupPayload(caller);
  if (!payload.fullName || (!payload.phone && !payload.demoEmail)) return;
  caller.demoFollowupSending = true;
  const result = await postJsonToWebhook(MAKE_WEBHOOK_URL, payload, "DEMO FOLLOWUP", SUBMISSION_TIMEOUT_MS);
  caller.demoFollowupSending = false;
  if (result && result.statusCode >= 200 && result.statusCode < 300) {
    caller.demoFollowupSent = true;
  }
}








function queueDemoFollowupSubmission(caller) {
  queueBackgroundTask("DEMO FOLLOWUP SUBMIT", async () => {
    await sendDemoFollowupToMake(caller);
  });
}




function closeAfterDemoFollowup(ws, caller) {
  queuePrimaryLeadAndBooking(caller);
  closeSession(ws, buildDemoCloseMessage());
}








function parseAvailabilityWebhookBody(body) {
  try {
    const parsed = JSON.parse(body || "{}");
    let date = cleanForSpeech(
      parsed.date
        || parsed.nextAvailableDate
        || parsed.callbackDate
        || parsed.appointmentDate
        || parsed.slotDate
        || parsed.startDate
        || ""
    );
    let time = cleanForSpeech(
      parsed.time
        || parsed.nextAvailableTime
        || parsed.callbackTime
        || parsed.appointmentTime
        || parsed.slotTime
        || parsed.startTime
        || ""
    );
    if ((!date || !time) && Array.isArray(parsed.slots) && parsed.slots.length) {
      const s = parsed.slots[0] || {};
      date = date || cleanForSpeech(s.date || s.startDate || s.slotDate || "");
      time = time || cleanForSpeech(s.time || s.startTime || s.slotTime || "");
    }
    if (!date || !time) {
      console.error(
        "[CALENDAR CHECK] Missing date or time in JSON. Keys:",
        Object.keys(parsed).join(","),
        "snippet:",
        String(body).slice(0, 350)
      );
      return null;
    }
    return { date, time };
  } catch (err) {
    console.error("[CALENDAR CHECK PARSE ERROR]", err.message, String(body).slice(0, 200));
    return null;
  }
}

async function checkCalendarAvailability(caller, requestDetails = {}, options = {}) {
  const skipMinLead = options.skipMinLeadEnforcement === true;
  const minSpoken = !skipMinLead && ENFORCE_MIN_CALLBACK_LEAD ? computeMinimumAllowedCallbackSpoken() : null;

  const payloadObject = {
    action: "check_availability",
    phone: caller.phone,
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    issueSummary: caller.issueSummary || caller.projectType || "",
    address: caller.address || "",
    requestedDate: requestDetails.requestedDateResolved || requestDetails.requestedDate || caller.requestedDate || "",
    requestedTimePreference: requestDetails.requestedTimePreference || caller.requestedTimePreference || "",
    requestedExactTime: requestDetails.requestedExactTime || "",
    requestedAfterTime: requestDetails.requestedAfterTime || requestDetails.requestedExactTime || "",
    availabilityMode: requestDetails.mode || "",
    avoidDate: requestDetails.avoidDate || "",
    avoidTime: requestDetails.avoidTime || "",
    currentOfferedDate: caller.pendingOfferedDate || "",
    currentOfferedTime: caller.pendingOfferedTime || "",
    availabilityQuery: requestDetails.rawQuery || caller.pendingAvailabilityQuery || "",
    currentDateLocal: currentDateInEastern(),
    currentDateTimeLocal: currentDateTimeInEastern(),
    earliestCallbackDate: minSpoken ? minSpoken.date : "",
    earliestCallbackTime: minSpoken ? minSpoken.time : ""
  };








  const retryableHttp = (code) => [500, 502, 503, 504, 408].includes(Number(code) || 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await sleep(750);
    const result = await postJsonToWebhook(AVAILABILITY_WEBHOOK_URL, payloadObject, "CALENDAR CHECK", AVAILABILITY_TIMEOUT_MS);
    if (!result || result.body == null || result.body === "") {
      console.error("[CALENDAR CHECK] Empty response from webhook", { attempt });
      if (attempt < 2) continue;
      console.error("[CALENDAR CHECK] Payload sent:", JSON.stringify(payloadObject).slice(0, 900));
      return null;
    }
    const code = Number(result.statusCode) || 0;
    if (code < 200 || code >= 300) {
      console.error("[CALENDAR CHECK] Non-success HTTP", code, String(result.body).slice(0, 400), { attempt });
      if (attempt < 2 && retryableHttp(code)) continue;
      console.error(
        "[CALENDAR CHECK] Make scenario error — open the scenario execution log in Make.com. Payload:",
        JSON.stringify(payloadObject).slice(0, 900)
      );
      return null;
    }
    const slot = parseAvailabilityWebhookBody(result.body);
    if (slot) {
      if (!minSpoken || compareSpokenCallbackSlots(slot.date, slot.time, minSpoken.date, minSpoken.time) >= 0) {
        return slot;
      }
      const bump = {
        ...requestDetails,
        requestedDate: "",
        requestedDateResolved: minSpoken.date,
        requestedAfterTime: minSpoken.time,
        requestedExactTime: "",
        mode: requestDetails.mode || "",
        rawQuery: `${cleanForSpeech(requestDetails.rawQuery || "callback availability")} on or after ${minSpoken.date} at or after ${minSpoken.time}`,
        avoidDate: slot.date,
        avoidTime: slot.time
      };
      const retried = await checkCalendarAvailability(caller, bump, { skipMinLeadEnforcement: true });
      if (retried && compareSpokenCallbackSlots(retried.date, retried.time, minSpoken.date, minSpoken.time) >= 0) {
        return retried;
      }
      console.warn("[CALENDAR] Webhook returned slots before minimum lead; using computed earliest offer", { slot, minSpoken, retried });
      return { date: minSpoken.date, time: minSpoken.time };
    }
    console.error("[CALENDAR CHECK] HTTP 200 but missing date/time fields:", String(result.body).slice(0, 400));
    return null;
  }
  return null;
}








async function findAlternateAvailability(caller, rawText, currentDate, currentTime) {
  const baseRequest = parseAvailabilityRequest(rawText, currentDate, currentTime);
  const firstAttempt = {
    ...baseRequest,
    requestedDate: baseRequest.requestedDate || currentDate || "",
    requestedAfterTime: currentTime || "",
    mode: "alternate_same_day",
    avoidDate: currentDate || "",
    avoidTime: currentTime || "",
    rawQuery: baseRequest.rawQuery || buildExplicitAlternateAvailabilityQuery(currentDate, currentTime, rawText)
  };




  let availability = await checkCalendarAvailability(caller, firstAttempt);
  if (availability && matchesAlternateAvailabilityRequest(rawText, currentDate, currentTime, availability.date, availability.time)) {
    return { availability, usedNextDayFallback: false };
  }




  const retryAttempt = {
    ...firstAttempt,
    rawQuery: buildExplicitAlternateAvailabilityQuery(currentDate, currentTime, rawText)
  };




  availability = await checkCalendarAvailability(caller, retryAttempt);
  if (availability && matchesAlternateAvailabilityRequest(rawText, currentDate, currentTime, availability.date, availability.time)) {
    return { availability, usedNextDayFallback: false };
  }




  const nextDay = shiftSpokenDateText(currentDate, 1);
  if (!nextDay) return null;




  const nextDayAttempt = {
    requestedDate: nextDay,
    requestedTimePreference: baseRequest.requestedTimePreference || "",
    requestedAfterTime: "",
    mode: "alternate_next_day_fallback",
    avoidDate: currentDate || "",
    avoidTime: currentTime || "",
    rawQuery: `next available callback on ${nextDay}`
  };




  availability = await checkCalendarAvailability(caller, nextDayAttempt);
  if (availability && !isSameAvailabilitySlot(availability.date, availability.time, currentDate, currentTime)) {
    if (normalizedText(availability.date || "") === normalizedText(currentDate || "")) {
      if (matchesAlternateAvailabilityRequest(rawText, currentDate, currentTime, availability.date, availability.time)) {
        return { availability, usedNextDayFallback: false };
      }
    } else {
      return { availability, usedNextDayFallback: true };
    }
  }




  return null;
}








function markStandardService(caller) {
  caller.emergencyAlert = false;
  caller.urgency = "normal";
  caller.leadType = "service";
  caller.status = "new_lead";
}








function markEmergency(caller) {
  caller.emergencyAlert = true;
  caller.urgency = "emergency";
  caller.leadType = "emergency";
  caller.status = "new_emergency";
}








function buildEmergencyIntakePrompt(caller) {
  const acknowledgement = buildIssueAcknowledgement(caller);
  const withName = caller.firstName ? `${caller.firstName}, ` : "";
  const leadIn = `${withName}${acknowledgement} I'm here to help, and I'm going to get this marked as an emergency so our service team can review it right away. I just need to get some information from you.`;


  if (caller.fullName) {
    if (hasFullName(caller.fullName)) {
      return `${leadIn} ${buildPhoneIntakePromptFragment(caller)}`;
    }
    return `${leadIn} Before I go any further, can I get your last name as well?`;
  }


  return `${acknowledgement} I'm here to help, and I'm going to get this marked as an emergency so our service team can review it right away. I just need to get some information from you. Can I start by getting your full name, please?`;
}








function isScheduleOfferAcceptance(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (isNegative(t)) return false;


  return containsAny(t, [
    "that ll work", "thatll work", "that will work",
    "yeah that ll work", "yeah thatll work", "yeah that will work",
    "yes that ll work", "yes thatll work", "yes that will work",
    "sure that works", "sure that ll work", "sure thatll work",
    "yep that ll work", "yep thatll work", "yup that ll work", "yup thatll work",
    "works for me", "that works for me", "that should work for me"
  ]) || isAffirmative(t);
}










function afterIssueCaptured(caller) {
  caller.issueIsCapabilityQuestion = false;
  if (caller.issue && isServiceCapabilityQuestion(caller.issue)) {
    caller.issueIsCapabilityQuestion = true;
  }








  if (isDemoIntent(caller.issue)) {
    caller.leadType = "demo";
    caller.status = "demo_request";
    caller.issueSummary = "demo request";
    return;
  }








  if (isQuoteIntent(caller.issue)) {
    caller.leadType = "quote";
    caller.projectType = classifyProjectType(caller.issue);
    caller.issueSummary = caller.issueIsCapabilityQuestion
      ? buildCapabilityIssueSummary(caller.issue)
      : caller.projectType;
    caller.status = "quote_request";
    return;
  }

  if (isHardEmergency(caller.issue)) {
    markEmergency(caller);
    return;
  }

  if (caller.issueIsCapabilityQuestion) {
    caller.issueSummary = buildCapabilityIssueSummary(caller.issue);
  } else {
    caller.issueSummary = classifyIssue(caller.issue).summary;
  }
  markStandardService(caller);
}








function buildNextPrompt(caller) {
  if (caller.lastStep === "ask_name") {
    const variants = [
      "Can I start by getting your full name, please?",
      "To start, can I get your full name?",
      "Who should I list as the contact—full first and last name?"
    ];
    const i = nextPromptIndex(caller, "askNameNextPromptIndex");
    return variants[i % variants.length];
  }








  if (caller.lastStep === "ask_last_name") {
    return `Thank you, ${caller.firstName}. Can I get your last name as well?`;
  }








  if (caller.lastStep === "confirm_phone") {
    return `Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`;
  }








  if (caller.lastStep === "ask_address") {
    return buildAddressRequestPrompt(caller);
  }








  if (caller.lastStep === "confirm_address") {
    return `Great, let me make sure I have this right. You said ${formatAddressForConfirmation(caller.address)}. Is that correct?`;
  }








  if (caller.lastStep === "schedule_or_callback") {
    return buildSchedulingChoicePrompt(caller);
  }








  return "How can I help you?";
}








function buildAIContext(caller) {
  return {
    current_step: caller.lastStep || "",
    is_browser: isBrowserCaller(caller),
    existing_phone: caller.callbackNumber || caller.phone || "",
    address: caller.address || "",
    offered_date: caller.pendingOfferedDate || "",
    offered_time: caller.pendingOfferedTime || "",
    lead_type: caller.leadType || "",
    issue_summary: caller.issueSummary || "",
    first_name: caller.firstName || "",
    full_name: caller.fullName || "",
    company_name: caller.companyName || "",
    alex_emotional_tone: caller.alexEmotionalTone || "neutral"
  };
}








async function safeAIInterpret(label, interpreterFn, text, context) {
  try {
    return await Promise.race([
      Promise.resolve().then(() => interpreterFn(text, context)),
      new Promise((resolve) => setTimeout(() => resolve(null), AI_INTERPRETER_TIMEOUT_MS))
    ]);
  } catch (err) {
    console.error(`[${label} ERROR]`, err.message);
    return null;
  }
}


function applyExtractedName(caller, fullName, firstName = "") {
  const safeFullName = cleanForSpeech(fullName || "");
  const safeFirstName = cleanForSpeech(firstName || "");




  if (safeFullName) {
    caller.fullName = safeFullName;
    caller.firstName = getFirstName(safeFullName) || safeFirstName || caller.firstName || "";
    caller.nameSpellingConfirmed = false;
    return;
  }




  if (safeFirstName) {
    caller.firstName = safeFirstName;
    caller.fullName = caller.fullName || safeFirstName;
    caller.nameSpellingConfirmed = false;
  }
}








function normalizePhoneForStorage(value) {
  const raw = cleanForSpeech(value || "");
  let d = extractPhoneDigits(raw || "");
  const brute = raw.replace(/\D/g, "");

  const correctedTail = normalizedText(extractPhoneCorrectionFocusTail(raw || "")) !== normalizedText(raw || "");

  if (!d && brute.length >= 7 && brute.length <= 11) {
    if (!(brute.length > 10 && looksLexicallyLikeAddressFragmentNearDigits(raw))) {
      d = brute;
    }
  }

  if (!d && brute.length >= 12 && brute.length <= 15) {
    if (!looksLexicallyLikeAddressFragmentNearDigits(raw) || correctedTail) {
      d = brute.slice(-10);
    }
  }

  if (!d) return cleanForSpeech(raw);

  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length > 10) return d.slice(-10);

  return d;
}








function sendAddressReadBackOrIncomplete(ws, caller, options = {}) {
  const preambleRaw = typeof options.preamble === "string" ? options.preamble.trim() : "";
  const trailingSpace = preambleRaw && !/[.!?;:,\-—]$/.test(preambleRaw) ? " " : "";
  const chk = analyzeUsServiceAddressCompleteness(caller.address || "");
  if (!chk.ok) {
    caller.lastStep = "ask_address";
    const incomplete = buildIncompleteAddressPrompt(caller, chk.missing);
    const summarized = formatAddressForConfirmation(caller.address || "");
    const refChunk =
      summarized.length >= 6 ? ` So far I have ${summarized}.` : "";
    sendText(ws, `${preambleRaw ? `${preambleRaw}${trailingSpace}` : ""}${incomplete}${refChunk}`);
    return;
  }
  caller.lastStep = "confirm_address";
  sendText(ws, `Great, let me make sure I have this right. You said ${formatAddressForConfirmation(caller.address)}. Is that correct?`);
}

function sendAfterAddressConfirmed(ws, caller) {
  if (caller.leadType === "quote") {
    caller.lastStep = "ask_project_timeline";
    sendText(ws, "What is the projected timeline or anticipated start date for this project?");
    return;
  }
  if (caller.leadType === "demo") {
    caller.lastStep = "ask_demo_email_optional";
    sendText(ws, "Would you like to include an email address as well?");
    return;
  }
  if (caller.emergencyAlert) {
    caller.lastStep = "ask_notes";
    sendText(ws, buildTechnicianNotesPrompt(caller));
    return;
  }
  caller.lastStep = "schedule_or_callback";
  sendText(ws, buildSchedulingChoicePrompt(caller));
}

async function finalizeAddressConfirmationAndAdvance(ws, caller) {
  sendAfterAddressConfirmed(ws, caller);
}








function confirmAndAdvancePhone(ws, caller) {
  caller.callbackConfirmed = true;
  if (!callerHasHarvestableServiceAddress(caller)) {
    caller.lastStep = "ask_address";
    sendText(ws, buildAddressRequestPrompt(caller));
    return;
  }
  sendAddressReadBackOrIncomplete(ws, caller);
}

const FLEX_CONTACT_INTAKE_STEPS = new Set([
  "ask_name",
  "ask_last_name",
  "confirm_phone"
]);

function stripLikelyPhoneFragmentsForNameParsing(raw) {
  let s = cleanForSpeech(raw || "");
  if (!s) return "";
  s = s.replace(/\b1[-.\s]?(?:\(\s*)?(\d{3})(?:\s*\))?\s*[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g, " ");
  s = s.replace(/\b(?:\(\s*)?(\d{3})(?:\s*\))?\s*[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g, " ");
  return s.replace(/\s+/g, " ").replace(/^(?:and|also|uh|um)\s+/i, "").trim();
}

function extractTenDigitUsPhoneFromUtterance(text) {
  const digits = extractPhoneDigits(text || "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return "";
}

function tryParseFlexibleBundledFullName(text) {
  const stripped = stripLikelyPhoneFragmentsForNameParsing(text);
  if (!stripped) return "";
  let candidate = extractIntroFullNameCandidate(stripped);
  if (candidate && hasFullName(candidate)) return candidate;
  const parts = stripped.split(/\s*(?:,|(?:\s+and\s+))\s*/i).map((p) => cleanForSpeech(p)).filter(Boolean);
  for (const part of parts) {
    const seg = stripLikelyPhoneFragmentsForNameParsing(part);
    const n = parseFullNameFromSpeech(seg);
    if (n && hasFullName(n)) return n;
  }
  const whole = parseFullNameFromSpeech(stripped);
  if (whole && hasFullName(whole)) return whole;
  return "";
}

function flexContactHarvestPreamble(kind) {
  const pools = {
    both: [
      "Okay, I caught both of those.",
      "Got it—I have both noted.",
      "Perfect, thanks—that tracks."
    ],
    phone_only: [
      "I heard a callback number, so I will hang on to that.",
      "Got the number.",
      "Thanks—I saved that number."
    ],
    name_at_phone: [
      "Thanks, I have your name.",
      "Got your name down."
    ]
  };
  const list = pools[kind] || pools.both;
  return list[Math.floor(Math.random() * list.length)];
}

function applyFlexibleContactHarvest(ws, caller, text) {
  if (!FLEX_CONTACT_INTAKE_STEPS.has(caller.lastStep)) return false;

  if (caller.lastStep === "confirm_phone") {
    const it = normalizeIntentText(text);
    if (isAffirmative(text) || isNegative(text) || isPhoneCorrection(text)) return false;
    if (it === "yes" || it === "yeah" || it === "yep" || it === "correct" || it === "right" || it === "that s right" || it === "thats right") {
      return false;
    }
  }

  const phone10 = extractTenDigitUsPhoneFromUtterance(text);
  const hasPhoneChunk = Boolean(phone10);

  let nameGuess = tryParseFlexibleBundledFullName(text);
  if (!nameGuess && caller.lastStep === "ask_last_name" && caller.firstName) {
    const remainder = stripLikelyPhoneFragmentsForNameParsing(text);
    const glued = parseFullNameFromSpeech(`${caller.firstName} ${remainder}`.trim());
    if (glued && hasFullName(glued)) nameGuess = glued;
    else {
      const last = parseLastNameResponse(remainder);
      if (last) {
        const combo = `${caller.firstName} ${last}`.trim();
        if (hasFullName(combo)) nameGuess = combo;
      }
    }
  }

  let changed = false;
  let phoneAdded = false;
  let nameAdded = false;

  if ((caller.lastStep === "ask_name" || caller.lastStep === "ask_last_name") && hasPhoneChunk) {
    const next = normalizePhoneForStorage(phone10);
    if (next && next !== String(caller.callbackNumber || "")) {
      caller.callbackNumber = next;
      phoneAdded = true;
      changed = true;
    }
  }

  if (caller.lastStep === "ask_name") {
    if (nameGuess && hasFullName(nameGuess) && nameGuess !== (caller.fullName || "")) {
      caller.fullName = nameGuess;
      caller.firstName = getFirstName(nameGuess);
      caller.nameSpellingConfirmed = false;
      nameAdded = true;
      changed = true;
    }
  } else if (caller.lastStep === "ask_last_name") {
    if (nameGuess && hasFullName(nameGuess) && nameGuess !== (caller.fullName || "")) {
      caller.fullName = nameGuess;
      caller.firstName = getFirstName(nameGuess);
      caller.nameSpellingConfirmed = false;
      nameAdded = true;
      changed = true;
    }
  } else if (caller.lastStep === "confirm_phone" && nameGuess && hasFullName(nameGuess) && !hasFullName(caller.fullName || "")) {
    caller.fullName = nameGuess;
    caller.firstName = getFirstName(nameGuess);
    caller.nameSpellingConfirmed = false;
    nameAdded = true;
    changed = true;
  }

  if (!changed) return false;

  let flexPreamble = "";
  if (phoneAdded && nameAdded) flexPreamble = flexContactHarvestPreamble("both");
  else if (phoneAdded) flexPreamble = flexContactHarvestPreamble("phone_only");
  else if (nameAdded && caller.lastStep === "confirm_phone") flexPreamble = flexContactHarvestPreamble("name_at_phone");

  if (!hasFullName(caller.fullName || "")) {
    if (caller.lastStep === "ask_name" || !caller.firstName) {
      caller.lastStep = "ask_name";
      sendText(ws, phoneAdded && !nameAdded
        ? `${flexPreamble} Who am I speaking with—your full name?`
        : `${flexPreamble} What name should I put on the service request?`);
      return true;
    }
    caller.lastStep = "ask_last_name";
    if (phoneAdded && !nameAdded) {
      sendText(ws, `${flexPreamble} And your last name?`);
    } else {
      sendText(ws, `${flexPreamble} Can I get your last name as well?`);
    }
    return true;
  }

  const nextStep = resolvePhoneIntakeStep(caller);
  const spelling = maybeQueueFirstNameSpelling(caller, nextStep, flexPreamble);
  if (spelling) {
    sendText(ws, spelling);
    return true;
  }
  caller.pendingNameNextStep = "";
  caller.lastStep = nextStep;
  const phoneLine = flexPreamble
    ? `${flexPreamble} ${buildPhoneIntakePromptFragment(caller)}`
    : buildPhoneIntakePromptFragment(caller);
  sendText(ws, phoneLine);
  return true;
}

async function handlePrompt(ws, caller, speech) {
  const text = cleanSpeechText(speech || "");
  console.log("[PROMPT RECEIVED]", JSON.stringify({ step: caller.lastStep, text }));
  if (!text) {
    sendText(ws, "I'm sorry, I didn't catch that. Could you say that again?");
    return;
  }

  updateCallerEmotionalTone(caller, text);

  if (isShortCourtesyResponse(text)) {
    const resumePrompt = buildResumePromptForCurrentStep(caller);
    sendText(ws, resumePrompt ? `You're welcome. ${resumePrompt}` : "You're welcome.");
    return;
  }

  if ((caller.lastStep === "ask_issue" || caller.lastStep === "ask_issue_again") && isHowAreYouOnly(text)) {
    caller.lastStep = "ask_issue_again";
    sendText(ws, "I'm doing well, thank you. How can I help you today?");
    return;
  }

  if (isPricingQuestion(text)) {
    sendText(ws, pricingResponse());
    return;
  }

  if (isHumanAgentRequest(text) || isAiIdentityQuestion(text)) {
    const ack = buildAutomatedServiceAcknowledgement(caller, text);
    const resume = buildResumePromptForCurrentStep(caller);
    sendText(ws, resume ? `${ack} ${resume}` : ack);
    return;
  }








  if (isRepeatRequest(text)) {
    const repeatPrompt = buildRepeatPrompt(caller);
    if (repeatPrompt) {
      sendText(ws, repeatPrompt);
      return;
    }
    sendText(ws, "I'm sorry, could you say that again?");
    return;
  }




  const postIntakeSteps = new Set([
    "ask_notes",
    "offer_demo_followup",
    "confirm_demo_followup_info",
    "ask_demo_followup_contact_name",
    "ask_demo_followup_phone",
    "ask_demo_followup_email_optional",
    "capture_demo_followup_email",
    "final_question",
    "confirm_address",
    "ask_address",
    "schedule_or_callback",
    "ask_appointment_day",
    "ask_appointment_time",
    "confirm_first_available",
    "late_day_preference_choice",
    "ask_project_timeline",
    "ask_project_scope",
    "ask_proposal_deadline",
    "ask_quote_email_optional",
    "capture_quote_email",
    "ask_demo_email_optional",
    "capture_demo_email"
  ]);


  if (postIntakeSteps.has(caller.lastStep) && isPostIntakeContactUpdateIntent(text)) {
    caller.resumeStepAfterPhoneUpdate = caller.lastStep;
    clearPendingUpdatedContactName(caller);
    const mayHaveEmbeddedName =
      isChangeContactPersonIntent(text) ||
      /\b(name|names|person|contact name|spouse|wife|husband)\b/i.test(text || "");
    const extractedUpdatedName = mayHaveEmbeddedName ? extractUpdatedContactNameFromSpeech(text) : "";
    if (extractedUpdatedName) {
      if (hasFullName(extractedUpdatedName)) {
        caller.pendingUpdatedContactFullName = extractedUpdatedName;
      } else {
        caller.pendingUpdatedContactFirstName = getFirstName(extractedUpdatedName) || extractedUpdatedName;
      }
    }
    caller.lastStep = "capture_updated_callback_number";
    sendText(ws, "No problem. What is the best contact number to use instead?");
    return;
  }

  if (applyFlexibleContactHarvest(ws, caller, text)) {
    return;
  }

  switch (caller.lastStep) {
    case "ask_issue": {
      let parsed = null;
      const strippedOpeningText = stripSocialLeadIn(text);
      const workingOpeningText = strippedOpeningText !== text ? strippedOpeningText : text;
      if (!workingOpeningText && isHowAreYouOnly(text)) {
        caller.lastStep = "ask_issue_again";
        sendText(ws, "Doing well, thanks for asking. What can I do for you today?");
        return;
      }
      const strongLocalOpeningParse = extractStrongLocalNameAndIssue(workingOpeningText);
      const localOpeningParse = strongLocalOpeningParse || extractOpeningNameAndIssue(workingOpeningText);
      if (localOpeningParse && localOpeningParse.name && localOpeningParse.issueText) {
        parsed = localOpeningParse;
        console.log(strongLocalOpeningParse ? "[STRONG LOCAL OPENING PARSE]" : "[LOCAL OPENING PARSE]", JSON.stringify({
          step: caller.lastStep,
          input: workingOpeningText,
          full_name: localOpeningParse.name || "",
          issue_text: localOpeningParse.issueText || ""
        }));
      }
      const localNameOnlyIntro = Boolean(localOpeningParse && localOpeningParse.name && !cleanForSpeech(localOpeningParse.issueText || ""));
      if (!parsed && localNameOnlyIntro && !looksLikeIssueText(workingOpeningText)) {
        caller.fullName = localOpeningParse.name;
        caller.firstName = getFirstName(localOpeningParse.name);
        caller.nameSpellingConfirmed = false;
        if (localOpeningParse.companyName) caller.companyName = localOpeningParse.companyName;
        caller.lastStep = "ask_issue_again";
        sendText(ws, caller.firstName ? `Thanks, ${caller.firstName}. What can I help you with today?` : "What can I help you with today?");
        return;
      }

      if (!parsed && AI_INTERPRETER_ENABLED) {
        const extractedOpening = await safeAIInterpret("AI OPENING", extractOpeningTurn, workingOpeningText, buildAIContext(caller));
        console.log("[AI OPENING RESULT]", JSON.stringify({
          step: caller.lastStep,
          input: workingOpeningText,
          intent: extractedOpening?.intent || "",
          full_name: extractedOpening?.full_name || "",
          first_name: extractedOpening?.first_name || "",
          issue_text: extractedOpening?.issue_text || ""
        }));
        if (extractedOpening && extractedOpening.intent && extractedOpening.intent !== "unclear") {
          applyExtractedName(caller, extractedOpening.full_name, extractedOpening.first_name);




          if (extractedOpening.intent === "social_greeting_only" || extractedOpening.intent === "name_only") {
            caller.lastStep = "ask_issue_again";
            if (caller.firstName) {
              sendText(ws, `Thanks, ${caller.firstName}. What can I help you with today?`);
            } else {
              sendText(ws, "What can I help you with today?");
            }
            return;
          }




          if (extractedOpening.issue_text) {
            parsed = {
              name: extractedOpening.full_name || null,
              issueText: extractedOpening.issue_text
            };
          }
        }

        const aiOpeningReturnedNothing = extractedOpening && !extractedOpening.intent && !extractedOpening.full_name && !extractedOpening.first_name && !extractedOpening.issue_text;
        if (aiOpeningReturnedNothing && isHowAreYouOnly(text)) {
          caller.lastStep = "ask_issue_again";
          sendText(ws, "Doing well, thanks for asking. What can I do for you today?");
          return;
        }
      }




      if (!parsed) {
        parsed = localOpeningParse || extractOpeningNameAndIssue(workingOpeningText);
      }




      if (!parsed.name) {
        const introFull = extractIntroFullNameCandidate(workingOpeningText);
        if (introFull) parsed.name = introFull;
      }




      if (parsed.name) {
        caller.fullName = parsed.name;
        caller.firstName = getFirstName(parsed.name);
        caller.nameSpellingConfirmed = false;
      }
      if (parsed.companyName) {
        caller.companyName = parsed.companyName;
      }
      if (!parsed.issueText) {
        caller.lastStep = "ask_issue_again";
        if (workingOpeningText !== text) {
          sendText(ws, "I'm doing well, thank you. How can I help you today?");
        } else {
          sendText(ws, "I'm sorry, I didn't quite catch the problem. Could you briefly tell me what is going on?");
        }
        return;
      }
      if (isGenericEmergencyIssue(parsed.issueText)) {
        caller.issue = "";
        caller.issueSummary = "";
        caller.issueIsCapabilityQuestion = false;
        caller.lastStep = "ask_issue_again";
        sendText(ws, caller.fullName
          ? `I'm sorry you're dealing with that, ${caller.firstName}. What exactly is going on so I can note the emergency correctly?`
          : "I'm sorry you're dealing with that. What exactly is going on so I can note the emergency correctly?");
        return;
      }
      caller.issue = normalizeGenericServiceIssue(parsed.issueText);
      afterIssueCaptured(caller);
      tryHarvestPhoneFromUtterance(caller, workingOpeningText);
      tryHarvestPhoneFromUtterance(caller, text);
      tryHarvestAddressFromUtterance(caller, workingOpeningText);
      tryHarvestAddressFromUtterance(caller, text);
      const missingProblemItem = detectMissingProblemItem(caller.issue);
      if (missingProblemItem) {
        caller.pendingIssueItem = missingProblemItem.label;
        caller.pendingIssuePrompt = missingProblemItem.prompt;
        caller.lastStep = "ask_item_issue_detail";
        sendText(ws, `What seems to be going on with ${missingProblemItem.prompt}?`);
        return;
      }

      if (tryBeginApplianceServiceIntake(ws, caller)) {
        return;
      }








      if (caller.leadType === "demo") {
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        sendText(ws, caller.fullName
          ? hasFullName(caller.fullName)
            ? `Absolutely. ${buildPhoneIntakePromptFragment(caller)}`
            : `Absolutely. Before I go any further, can I get your last name as well?`
          : "Absolutely. Can I start by getting your full name, please?");
        return;
      }








      if (caller.leadType === "quote") {
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        sendText(ws, caller.fullName
          ? hasFullName(caller.fullName)
            ? `${buildQuoteIntakeOpener(caller)} ${buildPhoneIntakePromptFragment(caller)}`
            : `${buildQuoteIntakeOpener(caller)} Before I go any further, can I get your last name as well?`
          : `${buildQuoteIntakeOpener(caller)} Can I start by getting your full name, please?`);
        return;
      }
      if (isRefrigeratorEmergencyCandidate(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "refrigerator_emergency_choice";
        sendText(ws, buildRefrigeratorEmergencyPrompt(caller));
        return;
      }

      if (isCookingAppliancePriorityCandidate(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "appliance_priority_choice";
        sendText(ws, buildCookingPriorityPrompt(caller));
        return;
      }

      if (isUrgentNonEmergencyRequest(caller.issue) && !caller.emergencyAlert) {
        markUrgent(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildUrgentPostIssueSpellingPreamble(caller)) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildUrgentIntakePrompt(caller));
        return;
      }










      if (isLeakLikeIssue(caller.issue) && !caller.emergencyAlert && !shouldSuppressHomeLeakEmergencyForApplianceIssue(caller.issue)) {
        if (!caller.fullName) {
          caller.pendingNameNextStep = "leak_emergency_choice";
          caller.lastStep = "ask_name";
          sendText(ws, buildMissingNameAfterIssuePrompt(caller));
          return;
        }
        const spLeak = maybeQueueFirstNameSpelling(caller, "leak_emergency_choice", buildIssueAcknowledgement(caller));
        if (spLeak) {
          sendText(ws, spLeak);
          return;
        }
        caller.lastStep = "leak_emergency_choice";
        sendText(ws, `${buildIssueAcknowledgement(caller)} Do you want me to mark this as an emergency?`);
        return;
      }








      const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
      if (caller.emergencyAlert) {
        caller.lastStep = nextStep;
        sendText(ws, buildEmergencyIntakePrompt(caller));
        return;
      }
      const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildStandardPostIssueSpellingPreamble(caller)) : "";
      if (spellingPrompt) {
        sendText(ws, spellingPrompt);
        return;
      }
      caller.lastStep = nextStep;
      sendText(ws, buildStandardIntakePrompt(caller));
      return;
    }








    case "ask_issue_again": {
      const strippedFollowupText = stripSocialLeadIn(text);
      const workingFollowupText = strippedFollowupText !== text ? strippedFollowupText : text;
      if (!workingFollowupText) {
        sendText(ws, "Doing well, thanks for asking. What can I do for you today?");
        return;
      }
      if (isGenericEmergencyIssue(workingFollowupText)) {
        sendText(ws, "I understand this is urgent. What exactly is going on so I can note the emergency correctly?");
        return;
      }
      caller.issue = normalizeGenericServiceIssue(workingFollowupText);
      afterIssueCaptured(caller);
      tryHarvestPhoneFromUtterance(caller, workingFollowupText);
      tryHarvestPhoneFromUtterance(caller, text);
      tryHarvestAddressFromUtterance(caller, workingFollowupText);
      tryHarvestAddressFromUtterance(caller, text);
      const missingProblemItem = detectMissingProblemItem(caller.issue);
      if (missingProblemItem) {
        caller.pendingIssueItem = missingProblemItem.label;
        caller.pendingIssuePrompt = missingProblemItem.prompt;
        caller.lastStep = "ask_item_issue_detail";
        sendText(ws, `What seems to be going on with ${missingProblemItem.prompt}?`);
        return;
      }
      if (tryBeginApplianceServiceIntake(ws, caller)) {
        return;
      }
      if (caller.leadType === "demo") {
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, caller.fullName
          ? hasFullName(caller.fullName)
            ? `Absolutely. I have ${caller.issueSummary}. ${buildPhoneIntakePromptFragment(caller)}`
            : `Thank you, ${caller.firstName}. ${buildServiceIntakeLeadIn(caller)} Can I get your last name as well?`
          : "Absolutely. Can I start by getting your full name, please?");
        return;
      }
      if (caller.leadType === "quote") {
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, caller.fullName
          ? hasFullName(caller.fullName)
            ? `${buildQuoteFollowupAckLine(caller)} ${buildPhoneIntakePromptFragment(caller)}`
            : caller.issueIsCapabilityQuestion
              ? `Thank you, ${caller.firstName}. ${buildCapabilityAcknowledgement(caller)} ${buildServiceIntakeLeadIn(caller)} Can I get your last name as well?`
              : `Thank you, ${caller.firstName}. ${buildServiceIntakeLeadIn(caller)} Can I get your last name as well?`
          : `${buildQuoteIntakeOpener(caller)} Can I start by getting your full name, please?`);
        return;
      }
      if (isRefrigeratorEmergencyCandidate(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "refrigerator_emergency_choice";
        sendText(ws, buildRefrigeratorEmergencyPrompt(caller));
        return;
      }

      if (isCookingAppliancePriorityCandidate(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "appliance_priority_choice";
        sendText(ws, buildCookingPriorityPrompt(caller));
        return;
      }

      if (isUrgentNonEmergencyRequest(caller.issue) && !caller.emergencyAlert) {
        markUrgent(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildUrgentPostIssueSpellingPreamble(caller)) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildUrgentIntakePrompt(caller));
        return;
      }


      if (isLeakLikeIssue(caller.issue) && !caller.emergencyAlert && !shouldSuppressHomeLeakEmergencyForApplianceIssue(caller.issue)) {
        if (!caller.fullName) {
          caller.pendingNameNextStep = "leak_emergency_choice";
          caller.lastStep = "ask_name";
          sendText(ws, buildMissingNameAfterIssuePrompt(caller));
          return;
        }
        const spLeak = maybeQueueFirstNameSpelling(caller, "leak_emergency_choice", buildIssueAcknowledgement(caller));
        if (spLeak) {
          sendText(ws, spLeak);
          return;
        }
        caller.lastStep = "leak_emergency_choice";
        sendText(ws, `${buildIssueAcknowledgement(caller)} Do you want me to mark this as an emergency?`);
        return;
      }
      const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
      if (caller.emergencyAlert) {
        caller.lastStep = nextStep;
        sendText(ws, buildEmergencyIntakePrompt(caller));
        return;
      }
      const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildStandardPostIssueSpellingPreamble(caller)) : "";
      if (spellingPrompt) {
        sendText(ws, spellingPrompt);
        return;
      }
      caller.lastStep = nextStep;
      sendText(ws, caller.fullName
        ? hasFullName(caller.fullName)
          ? `Thank you, ${caller.firstName}. ${caller.issueIsCapabilityQuestion ? `${buildCapabilityAcknowledgement(caller)} I have ${caller.issueSummary} noted. ` : `I have ${caller.issueSummary}. `}${buildServiceIntakeLeadIn(caller)} ${buildPhoneIntakePromptFragment(caller)}`
          : `Thank you, ${caller.firstName}. ${caller.issueIsCapabilityQuestion ? `${buildCapabilityAcknowledgement(caller)} ` : ""}${buildServiceIntakeLeadIn(caller)} Can I get your last name as well?`
        : `${caller.issueIsCapabilityQuestion ? `${buildCapabilityAcknowledgement(caller)} ` : ""}${buildServiceIntakeLeadIn(caller)} Can I start by getting your full name, please?`);
      return;
    }








    case "ask_item_issue_detail": {
      caller.issue = combineIssueContextAndDetail(caller.issue || caller.pendingIssueItem, text);
      caller.issueSummary = classifyIssue(caller.issue).summary;
      caller.issueIsCapabilityQuestion = Boolean(caller.issue) && isServiceCapabilityQuestion(caller.issue);
      caller.pendingIssueItem = "";
      caller.pendingIssuePrompt = "";
      if (isHardEmergency(caller.issue)) {
        markEmergency(caller);
      } else {
        markStandardService(caller);
      }
      if (tryBeginApplianceServiceIntake(ws, caller)) {
        return;
      }
      if (isRefrigeratorEmergencyCandidate(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "refrigerator_emergency_choice";
        sendText(ws, buildRefrigeratorEmergencyPrompt(caller));
        return;
      }

      if (isCookingAppliancePriorityCandidate(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "appliance_priority_choice";
        sendText(ws, buildCookingPriorityPrompt(caller));
        return;
      }

      if (isUrgentNonEmergencyRequest(caller.issue) && !caller.emergencyAlert) {
        markUrgent(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildUrgentPostIssueSpellingPreamble(caller)) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildUrgentIntakePrompt(caller));
        return;
      }






      if (isLeakLikeIssue(caller.issue) && !caller.emergencyAlert && !shouldSuppressHomeLeakEmergencyForApplianceIssue(caller.issue)) {
        if (!caller.fullName) {
          caller.pendingNameNextStep = "leak_emergency_choice";
          caller.lastStep = "ask_name";
          sendText(ws, buildMissingNameAfterIssuePrompt(caller));
          return;
        }
        const spLeak = maybeQueueFirstNameSpelling(caller, "leak_emergency_choice", buildIssueAcknowledgement(caller));
        if (spLeak) {
          sendText(ws, spLeak);
          return;
        }
        caller.lastStep = "leak_emergency_choice";
        sendText(ws, `${buildIssueAcknowledgement(caller)} Do you want me to mark this as an emergency?`);
        return;
      }




      const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
      if (caller.emergencyAlert) {
        caller.lastStep = nextStep;
        sendText(ws, buildEmergencyIntakePrompt(caller));
        return;
      }
      const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep, buildStandardPostIssueSpellingPreamble(caller)) : "";
      if (spellingPrompt) {
        sendText(ws, spellingPrompt);
        return;
      }
      caller.lastStep = nextStep;
      sendText(ws, buildStandardIntakePrompt(caller));
      return;
    }








    case "appliance_service_intake": {
      finalizeApplianceIntakeTurn(caller, text);
      tryHarvestPhoneFromUtterance(caller, text);
      tryHarvestAddressFromUtterance(caller, text);
      if (applianceDetailSlotsComplete(caller)) {
        proceedToContactCollectionAfterApplianceIntake(ws, caller);
        return;
      }
      sendText(ws, buildNextApplianceDetailQuestion(caller));
      return;
    }

    case "leak_emergency_choice": {
      if (isNegative(text)) {
        markStandardService(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, caller.fullName
          ? hasFullName(caller.fullName)
            ? isBrowserCaller(caller)
              ? `Alright, ${caller.firstName}. I've got this as a standard service request. I just need to gather a few details from you. ${buildPhoneIntakePromptFragment(caller)}`
              : `Alright, ${caller.firstName}. I've got this as a standard service request. I just need to gather a few details from you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
            : `Alright, ${caller.firstName}. I've got this as a standard service request. Before I go any further, can I get your last name as well?`
          : "Alright. I've got this as a standard service request. I just need to gather a few details from you. Can I start with your full name?");
        return;
      }








      if (isAffirmative(text)) {
        markEmergency(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, caller.fullName
          ? hasFullName(caller.fullName)
            ? isBrowserCaller(caller)
              ? `Alright, ${caller.firstName}. I'm going to mark this as an emergency so our service team can review it right away. ${buildPhoneIntakePromptFragment(caller)}`
              : `Alright, ${caller.firstName}. I'm going to mark this as an emergency so our service team can review it right away. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
            : `Alright, ${caller.firstName}. I'm going to mark this as an emergency so our service team can review it right away. Before I go any further, can I get your last name as well?`
          : "Alright. I'm going to mark this as an emergency so our service team can review it right away. Can I start with your full name?");
        return;
      }








      sendText(ws, "Do you want me to mark this as an emergency?");
      return;
    }








    case "refrigerator_emergency_choice": {
      if (isAffirmative(text) || containsAny(normalizeIntentText(text), ["emergency", "mark it as an emergency", "mark this as an emergency"])) {
        markEmergency(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildEmergencyIntakePromptAfterPriorAck(caller));
        return;
      }

      const nt = normalizeIntentText(text);
      const wantsStandardAfterEmergencyQuestion =
        isNegative(text) ||
        containsAny(nt, ["standard service", "normal service", "regular service", "not an emergency", "no emergency"]);
      const wantsUrgentNotEmergency = isUrgentSelection(text);

      if (wantsStandardAfterEmergencyQuestion && !wantsUrgentNotEmergency) {
        markStandardService(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildStandardIntakePromptAfterPriorSeverityAck(caller));
        return;
      }

      if (wantsUrgentNotEmergency) {
        markUrgent(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildUrgentIntakePromptAfterPriorAck(caller));
        return;
      }

      sendText(ws, buildRefrigeratorEmergencyPrompt(caller));
      return;
    }


    case "appliance_priority_choice": {
      const ntCook = normalizeIntentText(text);

      if (containsAny(ntCook, ["emergency", "mark it as an emergency", "mark this as an emergency"])) {
        markEmergency(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildEmergencyIntakePromptAfterPriorAck(caller));
        return;
      }

      if (isNegative(text) || containsAny(ntCook, ["normal", "standard", "regular service"])) {
        markStandardService(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildStandardIntakePromptAfterCookingPriorityAck(caller));
        return;
      }

      if (isUrgentSelection(text)) {
        markUrgent(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildUrgentIntakePromptAfterPriorAck(caller));
        return;
      }

      if (isAffirmative(text)) {
        markEmergency(caller);
        const nextStep = caller.fullName ? (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name") : "ask_name";
        const spellingPrompt = caller.fullName ? maybeQueueFirstNameSpelling(caller, nextStep) : "";
        if (spellingPrompt) {
          sendText(ws, spellingPrompt);
          return;
        }
        caller.lastStep = nextStep;
        sendText(ws, buildEmergencyIntakePromptAfterPriorAck(caller));
        return;
      }

      sendText(ws, buildCookingPriorityPrompt(caller));
      return;
    }


    case "late_day_preference_choice": {
      const normalized = normalizeIntentText(text);
      if (isAffirmative(text) || containsAny(normalized, ["note that", "as close to 5", "as close to five", "as late as possible", "late in the day", "that works", "that is fine", "thats fine"])) {
        finalizeLateDayPreference(caller);
        caller.lastStep = "ask_notes";
        sendText(ws, `Got it. I'll note that you'd prefer a callback as close to 5:00 as possible. ${buildTechnicianNotesPrompt(caller)}`);
        return;
      }

      if (isNegative(text) || containsAny(normalized, ["earlier", "something earlier", "different time", "another time"])) {
        caller.lastStep = caller.appointmentDate || caller.requestedDate ? "ask_appointment_time" : "ask_appointment_day";
        sendText(ws, caller.lastStep === "ask_appointment_time" ? "No problem. What earlier callback time works better for you?" : "No problem. What day works better for a callback?");
        return;
      }

      sendText(ws, buildLateDayFallbackPrompt(caller));
      return;
    }


    case "ask_name": {
      const parsedName = parseFullNameFromSpeech(text);
      if (!parsedName) {
        const speech = humanizeIssueSummaryForSpeech(caller.issueSummary || "").trim();
        const hasIssueContext = speech && speech.length >= 6;
        if (hasIssueContext && !caller.fullName) {
          const variants = [
            `Sorry, I missed the name part—could you tell me your full first and last name? I've already noted ${speech}.`,
            `I caught the detail on ${speech}, but I still need who I'm reaching. What's your full name—first and last?`,
            `Thanks for that—we still need contact info. What's your complete first and last name? I'll match it up with ${speech}.`
          ];
          const j = nextPromptIndex(caller, "askNameParseRetryIndex");
          sendText(ws, variants[j % variants.length]);
          return;
        }
        sendText(ws, "I'm sorry, I didn't quite catch that. What's your full name—first and last?");
        return;
      }
      caller.fullName = parsedName;
      caller.firstName = getFirstName(parsedName);
      caller.nameSpellingConfirmed = false;
      const companyName = extractCompanyNameFromSpeech(text);
      if (companyName) caller.companyName = companyName;
      const resumeStep = caller.pendingNameNextStep || "";
      const nextStep = hasFullName(parsedName)
        ? (resumeStep || resolvePhoneIntakeStep(caller))
        : "ask_last_name";
      const spellingPrompt = maybeQueueFirstNameSpelling(caller, nextStep);
      if (spellingPrompt) {
        sendText(ws, spellingPrompt);
        return;
      }
      if (!hasFullName(parsedName)) {
        caller.pendingNameNextStep = resumeStep || "";
        caller.lastStep = "ask_last_name";
        sendText(ws, `Thank you, ${caller.firstName}. Can I get your last name as well?`);
        return;
      }
      caller.pendingNameNextStep = "";
      if (resumeStep) {
        caller.lastStep = resumeStep;
        const resumePrompt = buildResumePromptForCurrentStep(caller);
        if (resumePrompt) {
          sendText(ws, resumePrompt);
          return;
        }
      }
      caller.lastStep = resolvePhoneIntakeStep(caller);
      sendText(ws, buildPhoneIntakePromptFragment(caller));
      return;
    }








    case "ask_first_name_spelling": {
      const spelledFirstName = normalizeSpelledFirstName(text, caller.firstName || "");
      const remainingParts = cleanForSpeech(caller.fullName || "").split(/\s+/).filter(Boolean).slice(1).join(" ");
      caller.firstName = spelledFirstName || caller.firstName;
      caller.fullName = remainingParts ? `${caller.firstName} ${toTitleCase(remainingParts)}` : caller.firstName;
      caller.nameSpellingConfirmed = true;
      const nextStep = caller.pendingNameNextStep || (hasFullName(caller.fullName) ? resolvePhoneIntakeStep(caller) : "ask_last_name");
      caller.pendingNameNextStep = "";
      if (nextStep === "ask_last_name") {
        caller.lastStep = "ask_last_name";
        sendText(ws, "Thank you. Can I get your last name as well?");
        return;
      }
      if (nextStep === "leak_emergency_choice") {
        caller.lastStep = "leak_emergency_choice";
        sendText(ws, "Do you want me to mark this as an emergency?");
        return;
      }
      caller.lastStep = resolvePhoneIntakeStep(caller);
      sendText(ws, callerHasReachablePhoneDigits(caller)
        ? `Thank you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
        : buildPhoneIntakePromptFragment(caller));
      return;
    }








    case "ask_last_name": {
      const resumeStep = caller.pendingNameNextStep || "";
      let possibleFullName = parseFullNameFromSpeech(`${caller.firstName} ${text}`);
      if (!possibleFullName || !hasFullName(possibleFullName)) {
        const parsedLastName = parseLastNameResponse(text);
        if (parsedLastName) {
          possibleFullName = `${caller.firstName} ${parsedLastName}`;
        }
      }
      if (!possibleFullName || !hasFullName(possibleFullName)) {
        sendText(ws, "I'm sorry, I didn't quite catch the last name. Could you please repeat it?");
        return;
      }
      caller.fullName = possibleFullName;
      caller.firstName = getFirstName(possibleFullName);
      const spellingPrompt = maybeQueueFirstNameSpelling(caller, resumeStep || resolvePhoneIntakeStep(caller));
      if (spellingPrompt) {
        sendText(ws, spellingPrompt);
        return;
      }
      caller.pendingNameNextStep = "";
      if (resumeStep) {
        caller.lastStep = resumeStep;
        const resumePrompt = buildResumePromptForCurrentStep(caller);
        if (resumePrompt) {
          sendText(ws, resumePrompt);
          return;
        }
      }
      caller.lastStep = resolvePhoneIntakeStep(caller);
      sendText(ws, buildPhoneIntakePromptFragment(caller));
      return;
    }
    case "confirm_phone": {
      if (isBrowserCaller(caller) && !(caller.callbackNumber || caller.phone)) {
        caller.callbackConfirmed = false;
        caller.lastStep = "get_new_phone";
        sendText(ws, buildBrowserCallbackPrompt());
        return;
      }

      if (isLikelyPhoneNumberResponse(text)) {
        caller.callbackNumber = normalizePhoneForStorage(text);
        confirmAndAdvancePhone(ws, caller);
        return;
      }

      if (isAffirmative(text)) {
        confirmAndAdvancePhone(ws, caller);
        return;
      }

      if (isPhoneCorrection(text) || isNegative(text)) {
        caller.callbackConfirmed = false;
        caller.lastStep = "get_new_phone";
        sendText(ws, "No problem. What is your best contact number?");
        return;
      }

      if (AI_INTERPRETER_ENABLED) {
        const phoneDecision = await safeAIInterpret("AI PHONE", interpretPhoneStep, text, buildAIContext(caller));
        if (phoneDecision && phoneDecision.intent && phoneDecision.intent !== "unclear") {
          if (phoneDecision.intent === "provide_new_phone_number" && phoneDecision.phone_number) {
            caller.callbackNumber = normalizePhoneForStorage(phoneDecision.phone_number);
            confirmAndAdvancePhone(ws, caller);
            return;
          }

          if (phoneDecision.intent === "request_phone_change" || phoneDecision.intent === "reject_phone" || phoneDecision.intent === "yes_waiting_for_number") {
            caller.callbackConfirmed = false;
            caller.lastStep = "get_new_phone";
            sendText(ws, "No problem. What is your best contact number?");
            return;
          }

          if (phoneDecision.intent === "confirm_existing_phone") {
            confirmAndAdvancePhone(ws, caller);
            return;
          }
        }
      }

      confirmAndAdvancePhone(ws, caller);
      return;
    }
    case "get_new_phone": {
      if (isLikelyPhoneNumberResponse(text)) {
        caller.callbackNumber = normalizePhoneForStorage(text);
        confirmAndAdvancePhone(ws, caller);
        return;
      }

      if (isAffirmative(text)) {
        caller.callbackConfirmed = false;
        sendText(ws, "Alright. What is your best contact number?");
        return;
      }

      if (AI_INTERPRETER_ENABLED) {
        const phoneDecision = await safeAIInterpret("AI PHONE", interpretPhoneStep, text, buildAIContext(caller));
        if (phoneDecision && phoneDecision.intent && phoneDecision.intent !== "unclear") {
          if (phoneDecision.intent === "provide_new_phone_number" && phoneDecision.phone_number) {
            caller.callbackNumber = normalizePhoneForStorage(phoneDecision.phone_number);
            confirmAndAdvancePhone(ws, caller);
            return;
          }

          if (phoneDecision.intent === "confirm_existing_phone" && (caller.callbackNumber || caller.phone)) {
            confirmAndAdvancePhone(ws, caller);
            return;
          }

          if (phoneDecision.intent === "yes_waiting_for_number") {
            caller.callbackConfirmed = false;
            sendText(ws, "Alright. What is your best contact number?");
            return;
          }

          if (phoneDecision.intent === "request_phone_change" || phoneDecision.intent === "reject_phone") {
            caller.callbackConfirmed = false;
            sendText(ws, "No problem. What is your best contact number?");
            return;
          }
        }
      }

      caller.callbackConfirmed = false;
      sendText(ws, isBrowserCaller(caller)
        ? "I'm sorry, I still need a good callback number. What number should I use?"
        : "I'm sorry, I still need a callback number. What is the best number to reach you?");
      return;
    }







    case "capture_updated_callback_number": {
      if (!isLikelyPhoneNumberResponse(text)) {
        sendText(ws, "I'm sorry, I still need the updated callback number. What is the best number to use instead?");
        return;
      }
      caller.callbackNumber = normalizePhoneForStorage(text);
      caller.callbackConfirmed = true;


      if (caller.pendingUpdatedContactFullName) {
        caller.fullName = caller.pendingUpdatedContactFullName;
        caller.firstName = getFirstName(caller.fullName);
        clearPendingUpdatedContactName(caller);
        afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
        return;
      }


      if (caller.pendingUpdatedContactFirstName) {
        const existingLastName = extractLastNameFromFullName(caller.fullName || "");
        if (existingLastName) {
          caller.lastStep = "confirm_same_last_name_after_contact_change";
          sendText(ws, `Got it. Should I use ${caller.pendingUpdatedContactFirstName} ${existingLastName} as the contact name?`);
          return;
        }
        caller.lastStep = "capture_updated_contact_last_name";
        sendText(ws, `Got it. Can I get ${caller.pendingUpdatedContactFirstName}'s last name as well?`);
        return;
      }


      caller.lastStep = "confirm_contact_person_after_phone_change";
      sendText(ws, "Got it. Should the contact person stay the same, or would you like me to change that as well?");
      return;
    }




    case "confirm_contact_person_after_phone_change": {
      if (
        isKeepSameContactPerson(text) ||
        (isAffirmative(text) && !isChangeContactPersonIntent(text) && !extractUpdatedContactNameFromSpeech(text))
      ) {
        clearPendingUpdatedContactName(caller);
        afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: false });
        return;
      }


      const extractedUpdatedName = extractUpdatedContactNameFromSpeech(text);
      if (extractedUpdatedName) {
        if (hasFullName(extractedUpdatedName)) {
          caller.fullName = extractedUpdatedName;
          caller.firstName = getFirstName(extractedUpdatedName);
          clearPendingUpdatedContactName(caller);
          afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
          return;
        }
        caller.pendingUpdatedContactFirstName = getFirstName(extractedUpdatedName) || extractedUpdatedName;
        const existingLastName = extractLastNameFromFullName(caller.fullName || "");
        if (existingLastName) {
          caller.lastStep = "confirm_same_last_name_after_contact_change";
          sendText(ws, `Got it. Should I use ${caller.pendingUpdatedContactFirstName} ${existingLastName} as the contact name?`);
          return;
        }
        caller.lastStep = "capture_updated_contact_last_name";
        sendText(ws, `Got it. Can I get ${caller.pendingUpdatedContactFirstName}'s last name as well?`);
        return;
      }


      if (isChangeContactPersonIntent(text)) {
        caller.lastStep = "capture_updated_contact_name";
        sendText(ws, "No problem. What name should I use instead?");
        return;
      }


      const parsedName = parseFullNameFromSpeech(text);
      if (parsedName) {
        if (hasFullName(parsedName)) {
          caller.fullName = parsedName;
          caller.firstName = getFirstName(parsedName);
          clearPendingUpdatedContactName(caller);
          afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
          return;
        }
        caller.pendingUpdatedContactFirstName = getFirstName(parsedName) || parsedName;
        const existingLastName = extractLastNameFromFullName(caller.fullName || "");
        if (existingLastName) {
          caller.lastStep = "confirm_same_last_name_after_contact_change";
          sendText(ws, `Got it. Should I use ${caller.pendingUpdatedContactFirstName} ${existingLastName} as the contact name?`);
          return;
        }
        caller.lastStep = "capture_updated_contact_last_name";
        sendText(ws, `Got it. Can I get ${caller.pendingUpdatedContactFirstName}'s last name as well?`);
        return;
      }


      sendText(ws, "I just want to make sure I have that right. Should the contact person stay the same, or would you like me to change that as well?");
      return;
    }




    case "capture_updated_contact_name": {
      const parsedName = extractUpdatedContactNameFromSpeech(text) || parseFullNameFromSpeech(text);
      if (!parsedName) {
        sendText(ws, "I'm sorry, I didn't quite catch the name. What name should I use instead?");
        return;
      }
      if (hasFullName(parsedName)) {
        caller.fullName = parsedName;
        caller.firstName = getFirstName(parsedName);
        clearPendingUpdatedContactName(caller);
        afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
        return;
      }
      caller.pendingUpdatedContactFirstName = getFirstName(parsedName) || parsedName;
      const existingLastName = extractLastNameFromFullName(caller.fullName || "");
      if (existingLastName) {
        caller.lastStep = "confirm_same_last_name_after_contact_change";
        sendText(ws, `Got it. Should I use ${caller.pendingUpdatedContactFirstName} ${existingLastName} as the contact name?`);
        return;
      }
      caller.lastStep = "capture_updated_contact_last_name";
      sendText(ws, `Got it. Can I get ${caller.pendingUpdatedContactFirstName}'s last name as well?`);
      return;
    }




    case "confirm_same_last_name_after_contact_change": {
      const existingLastName = extractLastNameFromFullName(caller.fullName || "");
      if (existingLastName && (isAffirmative(text) || isSameLastNameResponse(text))) {
        caller.fullName = `${caller.pendingUpdatedContactFirstName} ${existingLastName}`.trim();
        caller.firstName = getFirstName(caller.fullName);
        clearPendingUpdatedContactName(caller);
        afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
        return;
      }
      if (isNegative(text)) {
        caller.lastStep = "capture_updated_contact_last_name";
        sendText(ws, `No problem. What is ${caller.pendingUpdatedContactFirstName}'s last name?`);
        return;
      }
      caller.lastStep = "capture_updated_contact_last_name";
      sendText(ws, `No problem. What is ${caller.pendingUpdatedContactFirstName}'s last name?`);
      return;
    }




    case "capture_updated_contact_last_name": {
      const existingLastName = extractLastNameFromFullName(caller.fullName || "");
      if (existingLastName && isSameLastNameResponse(text)) {
        caller.fullName = `${caller.pendingUpdatedContactFirstName} ${existingLastName}`.trim();
        caller.firstName = getFirstName(caller.fullName);
        clearPendingUpdatedContactName(caller);
        afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
        return;
      }
      const cleanedLastNameText = cleanForSpeech(text)
        .replace(/\b(as well|too|also)\b/gi, "")
        .trim();
      const parsedLastName = parseLastNameResponse(cleanedLastNameText);
      if (!parsedLastName) {
        sendText(ws, "I'm sorry, I didn't quite catch the last name. Could you repeat it for me?");
        return;
      }
      caller.fullName = `${caller.pendingUpdatedContactFirstName} ${parsedLastName}`.trim();
      caller.firstName = getFirstName(caller.fullName);
      caller.pendingUpdatedContactFirstName = "";
      afterCallbackDetailsUpdated(ws, caller, { nameAlsoUpdated: true });
      return;
    }




    case "ask_address": {
      caller.address = extractBestDispatchAddressCandidate(
        mergeIncrementalServiceAddress(caller.address || "", text)
      );
      sendAddressReadBackOrIncomplete(ws, caller);
      return;
    }








    case "confirm_address": {
      if (isAffirmative(text) || isAddressConfirmation(text)) {
        if (!callerHasCompleteUsServiceAddress(caller)) {
          const chk = analyzeUsServiceAddressCompleteness(caller.address || "");
          caller.lastStep = "ask_address";
          sendText(ws, buildIncompleteAddressPrompt(caller, chk.missing));
          return;
        }
        await finalizeAddressConfirmationAndAdvance(ws, caller);
        return;
      }
      if (isNegative(text)) {
        caller.address = "";
        caller.lastStep = "ask_address";
        sendText(ws, caller.leadType === "quote" ? "I'm sorry about that. Let's try it again. What is the project address?" : "I'm sorry about that. Let's try it again. What is the service address?");
        return;
      }
      if (looksLikeAddressCorrection(text)) {
        caller.address = extractBestDispatchAddressCandidate(
          mergeIncrementalServiceAddress(caller.address || "", text)
        );
        sendAddressReadBackOrIncomplete(ws, caller);
        return;
      }




      if (AI_INTERPRETER_ENABLED) {
        const addressDecision = await safeAIInterpret("AI ADDRESS", interpretAddressStep, text, buildAIContext(caller));
        if (addressDecision && addressDecision.intent && addressDecision.intent !== "unclear") {
          if (addressDecision.intent === "confirm_address") {
            if (!callerHasCompleteUsServiceAddress(caller)) {
              const chk = analyzeUsServiceAddressCompleteness(caller.address || "");
              caller.lastStep = "ask_address";
              sendText(ws, buildIncompleteAddressPrompt(caller, chk.missing));
              return;
            }
            await finalizeAddressConfirmationAndAdvance(ws, caller);
            return;
          }
          if (addressDecision.intent === "reject_address") {
            caller.address = "";
            caller.lastStep = "ask_address";
            sendText(ws, caller.leadType === "quote" ? "I'm sorry about that. Let's try it again. What is the project address?" : "I'm sorry about that. Let's try it again. What is the service address?");
            return;
          }
          if (addressDecision.intent === "correct_address" && addressDecision.corrected_address) {
            caller.address = extractBestDispatchAddressCandidate(
              mergeIncrementalServiceAddress(
                caller.address || "",
                normalizeAddressInput(addressDecision.corrected_address)
              )
            );
            sendAddressReadBackOrIncomplete(ws, caller);
            return;
          }
        }
      }




      sendText(ws, `I just need a yes or no — is ${formatAddressForConfirmation(caller.address)} correct?`);
      return;
    }








    case "ask_project_timeline": {
      caller.timeline = cleanForSpeech(text);
      caller.lastStep = "ask_project_scope";
      sendText(ws, "Can you give me a quick idea of what all you'd like done?");
      return;
    }








    case "ask_project_scope": {
      caller.projectScopeNotes = normalizeProjectScopeNotes(text);
      caller.lastStep = "ask_proposal_deadline";
      sendText(ws, "Is there a deadline you're working with for the estimate or proposal?");
      return;
    }








    case "ask_proposal_deadline": {
      if (!isNegative(text)) caller.proposalDeadline = cleanForSpeech(text);
      caller.lastStep = "ask_quote_email_optional";
      sendText(ws, "Would you like to include an email address with this quote request as well?");
      return;
    }








    case "ask_quote_email_optional": {
      if (isEmailAddAcceptance(text)) {
        caller.lastStep = "capture_quote_email";
        sendText(ws, "Alright, go ahead and spell that out for me.");
        return;
      }
      if (!isNegative(text) && text.includes("@")) {
        caller.demoEmail = cleanForSpeech(text);
      }
      caller.lastStep = "ask_notes";
      sendText(ws, buildTechnicianNotesPrompt(caller));
      return;
    }








    case "capture_quote_email": {
      caller.demoEmail = cleanForSpeech(text);
      caller.lastStep = "ask_notes";
      sendText(ws, buildTechnicianNotesPrompt(caller));
      return;
    }








    case "ask_demo_email_optional": {
      if (isEmailAddAcceptance(text)) {
        caller.lastStep = "capture_demo_email";
        sendText(ws, "Alright, go ahead and spell that out for me.");
        return;
      }
      if (!isNegative(text) && text.includes("@")) {
        caller.demoEmail = cleanForSpeech(text);
      }
      caller.lastStep = "ask_notes";
      sendText(ws, "Before I submit this demo request, are there any notes or details you'd like me to add?");
      return;
    }








    case "capture_demo_email": {
      caller.demoEmail = cleanForSpeech(text);
      caller.lastStep = "ask_notes";
      sendText(ws, "Before I submit this demo request, are there any notes or details you'd like me to add?");
      return;
    }








    case "schedule_or_callback": {
      if (isFirstAvailableRequest(text)) {
        const requestDetails = parseAvailabilityRequest(text, caller.requestedDate, caller.pendingOfferedTime);
        caller.requestedDate = requestDetails.requestedDate;
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery;
        announceCalendarLookup(ws, caller, text, "first_available");
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback request, and someone from the office will reach out to confirm the exact callback time. " + buildTechnicianNotesPrompt(caller));
          return;
        }
        if (offeredAvailabilityNeedsLateDayFallback(availability)) {
          caller.pendingLateDayDate = availability.date;
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }

      if (hasExplicitSchedulingRequest(text)) {
        const requestDetails = parseAvailabilityRequest(text, caller.requestedDate, caller.pendingOfferedTime);
        caller.requestedDate = requestDetails.requestedDate || caller.requestedDate || "";
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        announceCalendarLookup(ws, caller, text, "specific_date");
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback preference, and someone from the office will reach out to confirm the exact callback time. " + buildTechnicianNotesPrompt(caller));
          return;
        }
        if (offeredAvailabilityNeedsLateDayFallback(availability)) {
          caller.pendingLateDayDate = availability.date;
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }

      if (wantsOfficeCallback(text)) {
        caller.status = "callback_requested";
        caller.lastStep = "ask_notes";
        sendText(ws, "Alright. Someone from the office will call you to arrange the next available time. " + buildTechnicianNotesPrompt(caller));
        return;
      }

      caller.lastStep = "ask_appointment_day";
      sendText(ws, "What day works best for you?");
      return;
    }








    case "ask_appointment_day": {
      const requestDetails = parseAvailabilityRequest(text, caller.requestedDate, caller.pendingOfferedTime);
      if (isLateDayPreferenceRequest(text)) {
        caller.requestedDate = requestDetails.requestedDate || caller.requestedDate || "";
        caller.appointmentDate = requestDetails.requestedDate || caller.appointmentDate || caller.requestedDate || "";
        caller.pendingLateDayDate = requestDetails.requestedDate || caller.appointmentDate || "";
        caller.lastStep = "late_day_preference_choice";
        sendText(ws, buildLateDayFallbackPrompt(caller));
        return;
      }
      if (requestDetails.requestedDate || requestDetails.requestedTimePreference || requestDetails.requestedExactTime || isSpecificTime(text) || isFirstAvailableRequest(text)) {
        caller.requestedDate = requestDetails.requestedDate || cleanForSpeech(text);
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        announceCalendarLookup(ws, caller, text);
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback request, and someone from the office will reach out to confirm the exact callback time. " + buildTechnicianNotesPrompt(caller));
          return;
        }
        if (offeredAvailabilityNeedsLateDayFallback(availability)) {
          caller.pendingLateDayDate = availability.date;
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }
      caller.appointmentDate = cleanForSpeech(text);
      caller.lastStep = "ask_appointment_time";
      sendText(ws, "What callback time works best for you?");
      return;
    }








    case "ask_appointment_time": {
      if (isLateDayPreferenceRequest(text)) {
        caller.pendingLateDayDate = caller.appointmentDate || caller.requestedDate || "";
        caller.lastStep = "late_day_preference_choice";
        sendText(ws, buildLateDayFallbackPrompt(caller));
        return;
      }
      if (isFirstAvailableRequest(text) || isAlternateAvailabilityRequest(text) || hasExplicitSchedulingRequest(text) || isSpecificTime(text) || detectTimePreference(text)) {
        const requestDetails = parseAvailabilityRequest(text, caller.appointmentDate, caller.pendingOfferedTime);
        caller.requestedDate = requestDetails.requestedDate || caller.appointmentDate;
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        announceCalendarLookup(ws, caller, text);
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.appointmentTime = detectTimePreference(text) || cleanForSpeech(text);
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback preference, and someone from the office will reach out to confirm the exact callback time. " + buildTechnicianNotesPrompt(caller));
          return;
        }
        if (offeredAvailabilityNeedsLateDayFallback(availability)) {
          caller.pendingLateDayDate = availability.date || caller.appointmentDate || "";
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }
      caller.appointmentTime = cleanForSpeech(text);
      caller.status = "scheduled_pending_confirmation";
      caller.calendarSlotConfirmed = false;
      caller.lastStep = "ask_notes";
      sendText(ws, `Okay, I have your requested callback time noted for ${caller.appointmentDate} at ${caller.appointmentTime}. Someone from our office will call you to confirm the details. ${buildTechnicianNotesPrompt(caller)}`);
      return;
    }








    case "confirm_first_available": {
      if (isRepeatTimeRequest(text)) {
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }

      if (isLateDayPreferenceRequest(text)) {
        caller.pendingLateDayDate = caller.pendingOfferedDate || caller.requestedDate || "";
        caller.lastStep = "late_day_preference_choice";
        sendText(ws, buildLateDayFallbackPrompt(caller));
        return;
      }

      if (isScheduleOfferAcceptance(text)) {
        if (!isAllowedCallbackStartTime(caller.pendingOfferedTime)) {
          caller.pendingLateDayDate = caller.pendingOfferedDate || caller.requestedDate || "";
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.appointmentDate = caller.pendingOfferedDate;
        caller.appointmentTime = caller.pendingOfferedTime;
        caller.status = "scheduled";
        caller.calendarSlotConfirmed = true;
        caller.lastStep = "ask_notes";
        sendText(ws, buildTechnicianNotesPrompt(caller));
        return;
      }


      if (hasExplicitSchedulingRequest(text) || isSpecificTime(text) || detectTimePreference(text)) {
        const requestDetails = parseAvailabilityRequest(text, caller.pendingOfferedDate, caller.pendingOfferedTime);
        caller.requestedDate = requestDetails.requestedDate || caller.pendingOfferedDate;
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        announceCalendarLookup(ws, caller, text, "specific_date");
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback preference, and someone from the office will reach out to confirm the exact callback time. " + buildTechnicianNotesPrompt(caller));
          return;
        }
        if (offeredAvailabilityNeedsLateDayFallback(availability)) {
          caller.pendingLateDayDate = availability.date || caller.pendingOfferedDate || caller.requestedDate || "";
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }




      if (AI_INTERPRETER_ENABLED) {
        const schedulingDecision = await safeAIInterpret("AI SCHEDULING", interpretSchedulingStep, text, buildAIContext(caller));
        if (schedulingDecision && schedulingDecision.intent && schedulingDecision.intent !== "unclear") {
          if (schedulingDecision.intent === "accept_offered_time") {
            if (!isAllowedCallbackStartTime(caller.pendingOfferedTime)) {
              caller.pendingLateDayDate = caller.pendingOfferedDate || caller.requestedDate || "";
              caller.lastStep = "late_day_preference_choice";
              sendText(ws, buildLateDayFallbackPrompt(caller));
              return;
            }
            caller.appointmentDate = caller.pendingOfferedDate;
            caller.appointmentTime = caller.pendingOfferedTime;
            caller.status = "scheduled";
            caller.calendarSlotConfirmed = true;
            caller.lastStep = "ask_notes";
            sendText(ws, buildTechnicianNotesPrompt(caller));
            return;
          }




          if (schedulingDecision.intent === "reject_offered_time") {
            caller.lastStep = "ask_appointment_day";
            sendText(ws, "No problem. What day works better for a callback?");
            return;
          }




          if (schedulingDecision.intent === "request_office_callback") {
            caller.status = "callback_requested";
            caller.lastStep = "ask_notes";
            sendText(ws, "Alright. Someone from the office will call you to arrange the next available time. " + buildTechnicianNotesPrompt(caller));
            return;
          }




          if (schedulingDecision.intent === "request_alternate_time") {
            const previousDate = caller.pendingOfferedDate;
            const previousTime = caller.pendingOfferedTime;
            caller.pendingAvailabilityQuery = cleanForSpeech(text);
            announceCalendarLookup(ws, caller, text, "alternate");
            const alternateResult = await findAlternateAvailability(caller, text, previousDate, previousTime);
            if (!alternateResult || !alternateResult.availability) {
              sendText(ws, "I wasn't able to pull a different opening right now. Someone from the office will reach out to confirm the exact callback time.");
              caller.status = "callback_requested";
              caller.lastStep = "ask_notes";
              sendText(ws, buildTechnicianNotesPrompt(caller));
              return;
            }
            if (offeredAvailabilityNeedsLateDayFallback(alternateResult.availability)) {
              caller.pendingLateDayDate = alternateResult.availability.date || previousDate || caller.requestedDate || "";
              caller.lastStep = "late_day_preference_choice";
              sendText(ws, buildLateDayFallbackPrompt(caller));
              return;
            }
            caller.pendingOfferedDate = alternateResult.availability.date;
            caller.pendingOfferedTime = alternateResult.availability.time;
            sendText(ws, buildAlternateAvailabilityOffer(caller, text, alternateResult.availability, previousDate, previousTime, alternateResult.usedNextDayFallback));
            return;
          }




          if (schedulingDecision.intent === "request_first_available") {
            sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
            return;
          }
        }
      }




      if (isAlternateAvailabilityRequest(text)) {
        const previousDate = caller.pendingOfferedDate;
        const previousTime = caller.pendingOfferedTime;
        caller.pendingAvailabilityQuery = cleanForSpeech(text);
        announceCalendarLookup(ws, caller, text, "alternate");
        const alternateResult = await findAlternateAvailability(caller, text, previousDate, previousTime);
        if (!alternateResult || !alternateResult.availability) {
          sendText(ws, "I wasn't able to pull a different opening right now. Someone from the office will reach out to confirm the exact callback time.");
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, buildTechnicianNotesPrompt(caller));
          return;
        }
        if (offeredAvailabilityNeedsLateDayFallback(alternateResult.availability)) {
          caller.pendingLateDayDate = alternateResult.availability.date || previousDate || caller.requestedDate || "";
          caller.lastStep = "late_day_preference_choice";
          sendText(ws, buildLateDayFallbackPrompt(caller));
          return;
        }
        caller.pendingOfferedDate = alternateResult.availability.date;
        caller.pendingOfferedTime = alternateResult.availability.time;
        sendText(ws, buildAlternateAvailabilityOffer(caller, text, alternateResult.availability, previousDate, previousTime, alternateResult.usedNextDayFallback));
        return;
      }




      if (isAffirmative(text)) {
        caller.appointmentDate = caller.pendingOfferedDate;
        caller.appointmentTime = caller.pendingOfferedTime;
        caller.status = "scheduled";
        caller.calendarSlotConfirmed = true;
        caller.lastStep = "ask_notes";
        sendText(ws, buildTechnicianNotesPrompt(caller));
        return;
      }




      if (isNegative(text)) {
        caller.lastStep = "ask_appointment_day";
        sendText(ws, "No problem. What day works better for a callback?");
        return;
      }




      sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
      return;
    }








    case "ask_notes": {
      const cleanedNotesText = cleanForSpeech(text);
      const substantiveTechNote = looksLikeSubstantiveTechNoteIntent(text);
      const decliningTechNotes =
        !substantiveTechNote &&
        (isDecliningTechnicianNotes(text) || isEndCallPhrase(text));
      const hadNotes = Boolean(cleanedNotesText) && !decliningTechNotes;
      if (hadNotes) caller.notes = cleanedNotesText;








      queuePrimaryLeadAndBooking(caller);








      if (caller.leadType === "demo") {
        closeAfterDemoFollowup(ws, caller);
        return;
      }

      caller.lastStep = "final_question";
      sendText(ws, `${buildPostNotesTransition(caller, hadNotes)} ${buildFinalSubmissionPrompt(caller)}`);
      return;
    }








    case "offer_demo_followup": {
      if (isDemoFollowupAcceptance(text)) {
        caller.demoFollowupRequested = true;
        caller.lastStep = "confirm_demo_followup_info";
        sendText(ws, "Okay, should I use the contact information you already gave me?");
        return;
      }


      if (isNegative(text) || isEndCallPhrase(text)) {
        caller.demoFollowupRequested = false;
        closeAfterDemoFollowup(ws, caller);
        return;
      }


      sendText(ws, "Would you like for me to have one of our team members call you to discuss how this could help your company?");
      return;
    }




    case "confirm_demo_followup_info": {
      if (isUseSameContactInfo(text) || isAffirmative(text)) {
        caller.demoFollowupContactName = caller.fullName || "";
        caller.demoFollowupCallbackNumber = caller.callbackNumber || caller.phone || "";
        caller.demoFollowupEmail = caller.demoEmail || caller.demoFollowupEmail || "";








        if (caller.demoFollowupEmail) {
          queueDemoFollowupSubmission(caller);
          closeAfterDemoFollowup(ws, caller);
          return;
        }








        caller.lastStep = "ask_demo_followup_email_optional";
        sendText(ws, "Would you like to include an email address as well?");
        return;
      }








      if (isNegative(text)) {
        caller.lastStep = "ask_demo_followup_contact_name";
        sendText(ws, "What is a good contact name?");
        return;
      }








      sendText(ws, "Okay, should I use the contact information you already gave me?");
      return;
    }








    case "ask_demo_followup_contact_name": {
      const parsedName = parseFullNameFromSpeech(text);
      if (!parsedName) {
        sendText(ws, "I'm sorry, I didn't quite catch the contact name. What is a good contact name?");
        return;
      }
      caller.demoFollowupContactName = parsedName;
      caller.lastStep = "ask_demo_followup_phone";
      sendText(ws, "What about a phone number?");
      return;
    }








    case "ask_demo_followup_phone": {
      caller.demoFollowupCallbackNumber = cleanForSpeech(text);
      caller.lastStep = "ask_demo_followup_email_optional";
      sendText(ws, "Would you like to include an email address as well?");
      return;
    }








    case "ask_demo_followup_email_optional": {
      if (isEmailAddAcceptance(text)) {
        caller.lastStep = "capture_demo_followup_email";
        sendText(ws, "Alright, go ahead and spell that out for me.");
        return;
      }
      if (!isNegative(text) && text.includes("@")) {
        caller.demoFollowupEmail = cleanForSpeech(text);
      }
      queueDemoFollowupSubmission(caller);
      closeAfterDemoFollowup(ws, caller);
      return;
    }








    case "capture_demo_followup_email": {
      caller.demoFollowupEmail = cleanForSpeech(text);
      queueDemoFollowupSubmission(caller);
      closeAfterDemoFollowup(ws, caller);
      return;
    }








    case "final_question": {
      if (isPricingQuestion(text)) {
        sendText(ws, `${pricingResponse()} ${buildFinalSubmissionPrompt(caller)}`);
        return;
      }








      if (isFinalQuestionWrapUpAnswer(text)) {
        queuePrimaryLeadAndBooking(caller);
        closeSession(ws, buildFinalSubmissionClose(caller));
        return;
      }








      appendAdditionalIssue(caller, text);
      caller.makeSent = false;
      queuePrimaryLeadAndBooking(caller, { forceLead: true });
      sendText(ws, `${buildAcknowledgeAdditionalFinalIssue(caller)} ${buildFinalSubmissionPrompt(caller)}`);
      return;
    }








    default: {
      caller.lastStep = "ask_issue";
      sendText(ws, "Please go ahead and tell me what is going on.");
      return;
    }
  }
}
















function serveBrowserCallingIndex(res) {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.send(`Server is running - ${APP_VERSION}`);
}








function buildBrowserCallingIdentity(req) {
  const requested = cleanForSpeech(req.query.identity || "");
  if (requested) return requested.replace(/[^\w.-]/g, "").slice(0, 64) || "browser-user";
  return "browser-user";
}








function createBrowserCallingToken(identity) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
    return null;
  }
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
    identity,
    ttl: 3600
  });
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: false
  }));
  return token.toJwt();
}








function verifyTwilioRequest(req) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return true;
  try {
    const signature = req.headers["x-twilio-signature"];
    const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    const host = req.get("host") || "";
    const pathAndQuery = String(req.originalUrl || req.url || "").split("#")[0];
    const url = `${proto}://${host}${pathAndQuery}`;
    const params = req.method === "GET" ? { ...(req.query || {}) } : (req.body || {});
    return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, params);
  } catch (err) {
    console.error("[TWILIO REQUEST VALIDATION ERROR]", err.message);
    return false;
  }
}








app.get("/twilio-token", (req, res) => {
  try {
    const identity = buildBrowserCallingIdentity(req);
    const token = createBrowserCallingToken(identity);
    if (!token) {
      throw new Error("Missing TWILIO_ACCOUNT_SID or browser calling environment variables");
    }
    res.json({ token });
  } catch (err) {
    console.error("TOKEN ERROR:", err);
    res.status(500).send("Token error: " + err.message);
  }
});








app.get("/health", (req, res) => {
  res.send(`Server is running - ${APP_VERSION}`);
});








app.get("/browser-call", (req, res) => {
  return serveBrowserCallingIndex(res);
});








app.get("/pc-call", (req, res) => {
  return serveBrowserCallingIndex(res);
});








app.get("/", (req, res) => {
  return serveBrowserCallingIndex(res);
});








function handleIncomingCall(req, res) {
  if (!verifyTwilioRequest(req)) {
    console.warn("[INCOMING CALL REJECTED]", req.method, req.originalUrl || req.url, {
      queryKeys: Object.keys(req.query || {}),
      bodyKeys: Object.keys(req.body || {})
    });
    return res.status(403).send("Forbidden");
  }








  if (!PUBLIC_BASE_URL) {
    return res.status(500).send("Missing PUBLIC_BASE_URL");
  }








  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.conversationRelay({
    url: `${PUBLIC_BASE_URL.replace(/^http/i, "ws")}/conversation-relay`,
    welcomeGreeting: "Thank you for calling the Blue Caller Automation demo line. This is Alex. How can I help you today?",
    welcomeGreetingInterruptible: "speech",
    language: "en-US",
    ttsProvider: "ElevenLabs",
    elevenlabsTextNormalization: "on",
    interruptible: "speech",
    interruptSensitivity: "low",
    reportInputDuringAgentSpeech: "speech",
    debug: "debugging"
  });








  res.type("text/xml").send(twiml.toString());
}

app.post("/incoming-call", handleIncomingCall);
app.get("/incoming-call", handleIncomingCall);








app.post("/connect-action", (req, res) => {
  res.status(204).send();
});








function isConversationRelayUpgradePath(rawUrl = "") {
  try {
    let s = String(rawUrl || "").trim();
    if (!s) return false;
    if (/^https?:\/\//i.test(s) || /^wss?:\/\//i.test(s)) {
      const u = new URL(s);
      let p = (u.pathname || "/").replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
      return p.toLowerCase() === "/conversation-relay";
    }
    let pathOnly = s.split("?")[0].split("#")[0];
    pathOnly = pathOnly.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
    return pathOnly.toLowerCase() === "/conversation-relay";
  } catch (err) {
    return false;
  }
}





server.on("upgrade", (request, socket, head) => {
  if (!isConversationRelayUpgradePath(request.url)) {
    console.warn("[WS UPGRADE REJECTED]", request.url);
    socket.destroy();
    return;
  }








  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});








wss.on("connection", (ws, request) => {
  const tempKey = crypto.randomUUID();
  ws.sessionKey = tempKey;
  wsBySession.set(tempKey, ws);
  getOrCreateCaller(tempKey);








  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString("utf8"));
      const type = data.type;
      const caller = getOrCreateCaller(ws.sessionKey);








      if (type === "setup") {
        caller.callSid = cleanForSpeech(data.callSid || "");
        caller.phone = cleanForSpeech(data.from || "");
        caller.callbackNumber = isBrowserCaller(caller) ? "" : caller.phone;
        return;
      }








      if (type === "interrupt") {
        if (cleanSpeechText(caller.promptBuffer || "")) {
          schedulePromptFinalize(ws, caller, promptFinalizeDelayForCaller(caller, 250, caller.promptBuffer || ""));
        }
        return;
      }








      if (type === "prompt") {
        if (data.voicePrompt) {
          const pendingGreeting = cleanSpeechText(caller.pendingGreetingPrompt || "");
          if (pendingGreeting) {
            clearGreetingContinuationTimer(caller);
            caller.pendingGreetingPrompt = "";
            caller.promptBuffer = `${pendingGreeting}${caller.promptBuffer ? " " + caller.promptBuffer : ""}`;
          }
          caller.promptBuffer = `${caller.promptBuffer ? caller.promptBuffer + " " : ""}${data.voicePrompt}`;
        }


        if (data.last === false) {
          if (cleanSpeechText(caller.promptBuffer || "")) {
            schedulePromptFinalize(ws, caller, promptFinalizeDelayForCaller(caller, PROMPT_FINALIZE_TIMEOUT_MS, caller.promptBuffer || ""));
          }
          return;
        }


        await processBufferedPrompt(ws, caller, data.voicePrompt || "");
        return;
      }








      if (type === "error") {
        console.error("[CONVERSATIONRELAY ERROR]", data.description || "Unknown error");
        return;
      }








      if (type === "dtmf") {
        return;
      }

      if (type === "info") {
        return;
      }








      console.log("[WS MESSAGE IGNORED]", data);
    } catch (err) {
      console.error("[WS MESSAGE ERROR]", err.message);
      sendText(ws, "I'm sorry, something went wrong. Could you please say that again?");
    }
  });








  ws.on("close", () => {
    const caller = getOrCreateCaller(ws.sessionKey);
    clearPromptFinalizeTimer(caller);
    clearGreetingContinuationTimer(caller);
    caller.pendingGreetingPrompt = "";
    wsBySession.delete(ws.sessionKey);
    setTimeout(() => {
      delete callerStore[ws.sessionKey];
    }, 5000);
  });








  ws.on("error", (err) => {
    console.error("[WS ERROR]", err.message);
  });
});








if (process.env.BLUE_CALLER_TEST_WRAP_UP === "1") {
  const casesPath = path.join(__dirname, "wrap_up_cases.json");
  let cases;
  try {
    cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  } catch (err) {
    console.error("Could not load wrap_up_cases.json:", err.message);
    process.exit(1);
  }

  let passed = 0;
  for (const tc of cases) {
    const got = isFinalQuestionWrapUpAnswer(tc.text);
    const expect = Boolean(tc.expect_wrap_up);
    if (got === expect) {
      passed += 1;
      console.log(`PASS  ${tc.name}`);
    } else {
      console.log(`FAIL  ${tc.name}`);
      console.log(`  - expected wrap_up=${expect} but got ${got} for text: ${JSON.stringify(tc.text)}`);
    }
  }

  console.log(`\nPassed ${passed} of ${cases.length} wrap-up cases.`);
  process.exit(passed === cases.length ? 0 : 1);
}

server.listen(PORT, BIND_HOST, () => {
  console.log(`Server listening on ${BIND_HOST}:${PORT} (${APP_VERSION})`);
});