/*************************************************
 CONVERSATIONRELAY BASELINE V6
 DATE: 2026-04-05 (v6 patch)

 PURPOSE:
 - Separate Twilio ConversationRelay baseline for latency testing
 - Keeps Make.com lead, availability, and booking webhooks
 - Uses Twilio ConversationRelay + Twilio-managed default ElevenLabs voice for lower turn latency
 - Preserves core service / emergency / quote / demo flows
 - Preserves address readback as street + city only
 - Preserves callback wording preferences where practical

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
*************************************************/

console.log("🔥 BLUE CALLER CONVERSATIONRELAY BASELINE V6 LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = "CONVERSATIONRELAY-BASELINE-V6";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";
const AVAILABILITY_WEBHOOK_URL = process.env.AVAILABILITY_WEBHOOK_URL || "https://hook.us2.make.com/c2gnxl52lvw69122ylvb66gksudiw8jb";
const BOOKING_WEBHOOK_URL = process.env.BOOKING_WEBHOOK_URL || "https://hook.us2.make.com/fm94sa7ws2s7kynhskinnu825lr87pn4";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const POST_SUBMIT_FOLLOWUP_ENABLED = String(process.env.POST_SUBMIT_FOLLOWUP_ENABLED || "false").toLowerCase() === "true";

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

function normalizeNameCandidate(rawName) {
  if (!rawName) return "";

  const cleaned = cleanName(rawName).toLowerCase();
  const stopWords = new Set([
    "and", "i", "have", "need", "calling", "about", "with", "for", "regarding",
    "because", "alex", "my", "name", "is", "this", "am", "im", "hi", "hello", "hey"
  ]);
  const blockedNameWords = new Set([
    "not", "no", "issue", "problem", "service", "schedule", "scheduling", "appointment",
    "someone", "heating", "cooling", "draining", "working", "broken", "leaking",
    "stove", "oven", "range", "cooktop", "dishwasher", "refrigerator", "washer",
    "dryer", "microwave", "faucet", "sink", "toilet", "main", "leak"
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

function stripIssueLeadIn(text) {
  if (!text) return "";
  return cleanForSpeech(text)
    .replace(/^(and\s+)?i\s+have\s+/i, "")
    .replace(/^(and\s+)?i\'ve\s+got\s+/i, "")
    .replace(/^(and\s+)?i\s+need\s+/i, "")
    .replace(/^(and\s+)?i\s+would\s+like\s+/i, "")
    .replace(/^(and\s+)?i\'?d\s+like\s+/i, "")
    .replace(/^(and\s+)?i\s+want\s+/i, "")
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

function stripGreetingPrefix(text) {
  return cleanSpeechText(text || "")
    .replace(/^(hi|hello|hey)\s*,?\s*alex\s*[,. -]*\s*/i, "")
    .replace(/^(hi|hello|hey)\s*[,. -]*\s*/i, "")
    .trim();
}

function looksLikeIssueText(text) {
  const t = normalizedText(text || "");
  return Boolean(
    t && (
      t.startsWith("my ") ||
      t.startsWith("the ") ||
      t.startsWith("our ") ||
      t.includes(" leak") ||
      t.includes("clog") ||
      t.includes("drain") ||
      t.includes("not working") ||
      t.includes("refrigerator") ||
      t.includes("fridge") ||
      t.includes("dishwasher") ||
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

function extractOpeningNameAndIssue(text) {
  const original = cleanSpeechText(text || "");
  if (!original) return { name: null, issueText: "" };

  const normalized = stripGreetingPrefix(original);
  const introMarker = normalized.match(/^(?:this is|my name is|i am|i'm)\s+/i);
  if (introMarker) {
    const remainder = normalized.slice(introMarker[0].length).trim();
    const issueMarkers = [
      /\s+and\s+i\s+have\b/i,
      /\s+i\s+have\b/i,
      /\s+my\b/i,
      /\s+the\b/i,
      /\s+our\b/i,
      /\s+i\s+need\b/i,
      /\s+i\'?m\s+having\b/i,
      /\s+i\s+am\s+having\b/i,
      /\s+can\s+someone\b/i,
      /\s+can\s+you\b/i,
      /\s+there\s+is\b/i,
      /\s+because\b/i,
      /\s+about\b/i,
      /\s+with\b/i,
      /\s+regarding\b/i
    ];

    let earliestIndex = -1;
    for (const marker of issueMarkers) {
      const m = remainder.match(marker);
      if (!m || typeof m.index !== "number") continue;
      if (earliestIndex === -1 || m.index < earliestIndex) earliestIndex = m.index;
    }

    if (earliestIndex > 0) {
      const possibleName = normalizeNameCandidate(remainder.slice(0, earliestIndex));
      const issueText = stripIssueLeadIn(remainder.slice(earliestIndex));
      if (possibleName && issueText) return { name: possibleName, issueText };
    }

    const possibleNameOnly = normalizeNameCandidate(remainder);
    if (possibleNameOnly) return { name: possibleNameOnly, issueText: "" };
  }

  const patterns = [
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)(?:\s*,\s*|\s+and\s+)(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(my\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(the\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(i\s+need\s+.+)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const possibleName = normalizeNameCandidate(match[1]);
    const issueText = stripIssueLeadIn(match[2]);
    if (possibleName && issueText) return { name: possibleName, issueText };
  }

  if (looksLikeIssueText(normalized)) {
    return { name: null, issueText: stripIssueLeadIn(normalized) || original };
  }

  return { name: null, issueText: original };
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

function normalizeAddressInput(input) {
  if (!input) return "";
  let value = cleanForSpeech(input)
    .replace(/\bcomma\b/gi, "")
    .replace(/\bdot\b/gi, "")
    .replace(/[.,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = collapseSpacedDigits(value);
  value = value.replace(/^([0-9]{1,6})\s+\1(\b.*)$/i, "$1$2");
  value = value.replace(/\s{2,}/g, " ").trim();
  return value;
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
  if (digits.length === 3) return `${numberUnder100ToWords(Number(digits.slice(0, 1)))} ${numberUnder100ToWords(Number(digits.slice(1)))}`;
  if (digits.length === 4) return `${numberUnder100ToWords(Number(digits.slice(0, 2)))} ${numberUnder100ToWords(Number(digits.slice(2)))}`;
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

  const streetSpeech = streetLine.replace(/^(\d{1,5})(\s+.+)$/, (m, num, rest) => `${streetNumberToSpeech(num)}${rest}`);
  return city ? `${streetSpeech} in ${city}` : streetSpeech;
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.substring(1);
  // Speak phone numbers a little slower by converting digits to words and adding light pauses.
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

  if (["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "absolutely", "definitely", "correct", "right", "fine", "works"].includes(t)) return true;

  if (/\bthat\s+(works|will work|should work|will be fine|should be fine|is fine|is okay|is ok|is good|is great|is alright|is all right)\b/.test(t)) return true;
  if (/\b(i|we)\s+(ll|will)\s+take\s+(it|that)\b/.test(t)) return true;
  if (/\b(go ahead|please do|do that|book it|schedule it|book that|schedule that)\b/.test(t)) return true;

  if (containsAny(t, [
    "yes please", "yeah please", "sounds good", "sounds great", "sounds fine", "sounds okay",
    "lets do that", "let s do that", "mark this as an emergency", "make this an emergency",
    "this is an emergency", "it is an emergency", "its an emergency",
    "yeah have someone call me", "have someone call me", "have somebody call me",
    "whatever works", "that sounds good", "that sounds fine", "that sounds okay",
    "that is fine", "thats fine", "that s fine", "that is okay", "thats okay", "that s okay",
    "that is good", "that s good", "that is alright", "thats alright", "that s alright",
    "that is all right", "thats all right", "that s all right", "thatll work", "that ll work",
    "thatll do", "that ll do", "fine with me", "works for me", "go ahead and do that",
    "go ahead and book it", "go ahead and schedule it", "ill take that", "i ll take that",
    "ill take it", "i ll take it", "that should be okay", "that should be fine"
  ])) return true;

  return false;
}

function isNegative(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (["no", "nope", "nah", "skip", "pass"].includes(t)) return true;
  return containsAny(t, [
    "no thanks", "no thank you", "not now", "not really", "dont", "do not",
    "not an emergency", "not emergency", "non emergency", "nonemergency", "not urgent",
    "standard service", "normal service", "regular service", "something else", "another time", "different time",
    "that s all right", "thats all right", "that is all right", "that s alright", "thats alright", "that is alright"
  ]);
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
  return containsAny(t, [
    "that's all", "that is all", "nothing else", "i'm good", "im good", "all set",
    "that'll do it", "that will do it", "that's everything", "that is everything",
    "that's all i need", "that is all i need", "we're good", "we are good", "that should do it"
  ]);
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
  if (containsAny(t, ["remodel", "remodeling", "renovation", "renovating"])) return true;
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

function buildUnknownIssueSummary(issue) {
  const cleaned = cleanForSpeech(issue || "");
  if (!cleaned) return "the issue you described";
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 77).trim()}...`;
}

function isMainLineEmergencyCandidate(text) {
  const t = normalizedText(text);
  const yardLike = containsAny(t, ["yard", "front yard", "back yard", "outside", "front lawn", "back lawn"]);
  const mainLike = containsAny(t, [
    "water main", "main line", "main leak", "main broke", "main broken", "main popped",
    "main in my yard", "main in the yard", "water line", "service line", "broken line", "burst line"
  ]) || (containsAny(t, ["main", "line", "water"]) && yardLike);
  const severeLike = containsAny(t, ["popped", "burst", "broke", "broken", "water coming up", "water coming out", "leak", "leaking", "gushing", "pouring"]);
  return mainLike && severeLike;
}

function isHardEmergency(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "burst", "burst pipe", "flooding", "flooded", "sewer", "sewage", "gas leak", "no water",
    "gushing", "pouring", "water everywhere", "water coming through the ceiling", "ceiling pouring", "water is pouring"
  ]) || isMainLineEmergencyCandidate(t);
}

function isLeakLikeIssue(text) {
  const t = normalizedText(text);
  return containsAny(t, ["leak", "leaking", "drip", "dripping"]);
}

function classifyIssue(issue) {
  const text = normalizedText(issue);
  if (isMainLineEmergencyCandidate(text)) return { summary: "a possible broken water main in your yard" };
  if ((text.includes("faucet") || text.includes("sink")) && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaking faucet" };
  if (text.includes("water heater") && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaking water heater" };
  if (text.includes("roof") && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a roof leak" };
  if (text.includes("ceiling") && containsAny(text, ["leak", "drip", "dripping", "pouring", "gushing"])) return { summary: "a ceiling leak" };
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
  if (diffDays === 1) return `tomorrow, ${parsed.weekday} at ${timeText}`;
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
  return /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(t) || /\b(noon|midnight)\b/i.test(t) || /\b\d{1,2}:\d{2}\b/i.test(t);
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

function extractDatePart(text) {
  const value = cleanForSpeech(text || "");
  if (!value) return "";
  const t = normalizedText(value);
  if (containsAny(t, [
    "today", "tomorrow", "next week", "this week",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
  ])) return value;
  return "";
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
  const requestedTimePreference = detectTimePreference(raw);
  if (!requestedDate && existingDate && isAlternateAvailabilityRequest(raw)) requestedDate = existingDate;
  return {
    rawQuery: buildAvailabilityRawQuery(raw, existingDate, existingTime),
    requestedDate: requestedDate || existingDate || "",
    requestedTimePreference
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
  const t = normalizedText(rawText || "");

  const firstAvailablePrompts = [
    "I already have the calendar up. Let me see what the first available is.",
    "Let's see what the first available is.",
    "Let me see what I have available first."
  ];

  const specificDatePrompts = [
    "Alright, let me see if that date is available.",
    "Let me see if that date is open.",
    "I already have the calendar up. Let me see if that date is available."
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
      callbackNumber: "",
      callbackConfirmed: null,
      address: "",
      issue: "",
      issueSummary: "",
      urgency: "normal",
      emergencyAlert: false,
      leadType: "service",
      projectType: "",
      timeline: "",
      proposalDeadline: "",
      demoEmail: "",
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
      makeSent: false,
      lastStep: "ask_issue",
      pendingNameNextStep: "",
      pendingPromptText: "",
      promptBuffer: "",
      demoFollowupRequested: false,
      demoFollowupSent: false,
      demoFollowupContactName: "",
      demoFollowupCallbackNumber: "",
      demoFollowupEmail: "",
      calendarPromptIndex: 0,
      callbackOfferIndex: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
  callerStore[key].updatedAt = new Date().toISOString();
  return callerStore[key];
}

function sendText(ws, text, options = {}) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "text",
    token: text,
    last: true,
    interruptible: options.interruptible !== false,
    preemptible: options.preemptible === true
  }));
}

function estimateSpeechDurationMs(text) {
  const safe = cleanForSpeech(text || "");
  if (!safe) return 0;

  const commaCount = (safe.match(/[,;:]/g) || []).length;
  const stopCount = (safe.match(/[.!?]/g) || []).length;
  const estimated = 3800 + (safe.length * 88) + (commaCount * 260) + (stopCount * 420);

  return Math.max(14000, Math.min(32000, estimated));
}

function closeSession(ws, text) {
  if (text) sendText(ws, text, { interruptible: false, preemptible: false });
  setTimeout(() => {
    try { ws.close(); } catch (err) {}
  }, text ? estimateSpeechDurationMs(text) : 0);
}

function buildMakePayload(caller) {
  return {
    leadType: caller.leadType || (caller.emergencyAlert ? "emergency" : "service"),
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    phone: caller.phone || "",
    callbackNumber: caller.callbackNumber || caller.phone || "",
    callbackConfirmed: caller.callbackConfirmed === true,
    address: caller.address || "",
    issue: caller.issue || caller.projectType || "",
    issueSummary: caller.issueSummary || caller.projectType || "",
    urgency: caller.urgency || "normal",
    emergencyAlert: caller.emergencyAlert === true,
    projectType: caller.projectType || "",
    applianceType: "",
    applianceWarranty: "",
    timeline: caller.timeline || "",
    proposalDeadline: caller.proposalDeadline || "",
    demoEmail: caller.demoEmail || "",
    notes: caller.notes || "",
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

function postJsonToWebhook(webhookUrl, payload, label) {
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

      const req = https.request(options, (webhookRes) => {
        let body = "";
        webhookRes.on("data", (chunk) => { body += chunk; });
        webhookRes.on("end", () => {
          console.log(`[${label}] Status: ${webhookRes.statusCode}`);
          resolve({ statusCode: webhookRes.statusCode, body });
        });
      });

      req.on("error", (err) => {
        console.error(`[${label} ERROR]`, err.message);
        resolve(null);
      });

      req.write(data);
      req.end();
    } catch (err) {
      console.error(`[${label} ERROR]`, err.message);
      resolve(null);
    }
  });
}

async function sendLeadToMake(caller) {
  if (caller.makeSent || !shouldSendToMake(caller)) return;
  const payload = buildMakePayload(caller);
  await postJsonToWebhook(MAKE_WEBHOOK_URL, payload, "MAKE");
  caller.makeSent = true;
}

function buildBookingPayload(caller) {
  if (!caller.calendarSlotConfirmed || !caller.appointmentDate || !caller.appointmentTime) return null;
  const slotTimes = parseCallbackDateAndTimeToLocal(caller.appointmentDate, caller.appointmentTime);
  if (!slotTimes) return null;
  return {
    action: "create_callback_booking",
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
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
    source: "AI Receptionist"
  };
}

async function sendBookingToMake(caller) {
  if (caller.bookingSent) return;
  const payload = buildBookingPayload(caller);
  if (!payload) return;
  await postJsonToWebhook(BOOKING_WEBHOOK_URL, payload, "BOOKING");
  caller.bookingSent = true;
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
  if (caller.demoFollowupSent) return;
  const payload = buildDemoFollowupPayload(caller);
  if (!payload.fullName || (!payload.phone && !payload.demoEmail)) return;
  await postJsonToWebhook(MAKE_WEBHOOK_URL, payload, "DEMO FOLLOWUP");
  caller.demoFollowupSent = true;
}

async function checkCalendarAvailability(caller, requestDetails = {}) {
  const payloadObject = {
    action: "check_availability",
    phone: caller.phone,
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    issueSummary: caller.issueSummary || caller.projectType || "",
    address: caller.address || "",
    requestedDate: requestDetails.requestedDate || caller.requestedDate || "",
    requestedTimePreference: requestDetails.requestedTimePreference || caller.requestedTimePreference || "",
    availabilityQuery: requestDetails.rawQuery || caller.pendingAvailabilityQuery || "",
    currentDateLocal: currentDateInEastern(),
    currentDateTimeLocal: currentDateTimeInEastern()
  };

  const result = await postJsonToWebhook(AVAILABILITY_WEBHOOK_URL, payloadObject, "CALENDAR CHECK");
  if (!result || !result.body) return null;
  try {
    const parsed = JSON.parse(result.body || "{}");
    const date = cleanForSpeech(parsed.date || parsed.nextAvailableDate || "");
    const time = cleanForSpeech(parsed.time || parsed.nextAvailableTime || "");
    if (!date || !time) return null;
    return { date, time };
  } catch (err) {
    console.error("[CALENDAR CHECK PARSE ERROR]", err.message);
    return null;
  }
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

function afterIssueCaptured(caller) {
  caller.issueSummary = classifyIssue(caller.issue).summary;

  if (isDemoIntent(caller.issue)) {
    caller.leadType = "demo";
    caller.status = "demo_request";
    caller.issueSummary = "demo request";
    return;
  }

  if (isQuoteIntent(caller.issue)) {
    caller.leadType = "quote";
    caller.projectType = classifyProjectType(caller.issue);
    caller.issueSummary = caller.projectType;
    caller.status = "quote_request";
    return;
  }

  if (isHardEmergency(caller.issue)) {
    markEmergency(caller);
    return;
  }

  markStandardService(caller);
}

function buildNextPrompt(caller) {
  if (caller.lastStep === "ask_name") {
    return "Can I start by getting your full name, please?";
  }

  if (caller.lastStep === "ask_last_name") {
    return `Thank you, ${caller.firstName}. Can I get your last name as well?`;
  }

  if (caller.lastStep === "confirm_phone") {
    return `Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`;
  }

  if (caller.lastStep === "ask_address") {
    return caller.leadType === "quote" ? "What is the project address?" : "What is the service address?";
  }

  if (caller.lastStep === "confirm_address") {
    return `Great, let me make sure I have this right. You said ${formatAddressForSpeech(caller.address)}. Is that correct?`;
  }

  if (caller.lastStep === "schedule_or_callback") {
    return "Alright, I've got all the information I need. Now let's talk about a callback time that works best for you. Do you have something in mind, or would you like me to find the first available for you?";
  }

  return "How can I help you?";
}

async function handlePrompt(ws, caller, speech) {
  const text = cleanSpeechText(speech || "");
  if (!text) {
    sendText(ws, "I'm sorry, I didn't catch that. Could you say that again?");
    return;
  }

  if (isPricingQuestion(text)) {
    sendText(ws, pricingResponse());
    return;
  }

  switch (caller.lastStep) {
    case "ask_issue": {
      const parsed = extractOpeningNameAndIssue(text);
      if (parsed.name) {
        caller.fullName = parsed.name;
        caller.firstName = getFirstName(parsed.name);
      }
      if (!parsed.issueText) {
        caller.lastStep = "ask_issue_again";
        sendText(ws, "I'm sorry, I didn't quite catch the problem. Could you briefly tell me what is going on?");
        return;
      }
      caller.issue = cleanForSpeech(parsed.issueText);
      afterIssueCaptured(caller);

      if (caller.leadType === "demo") {
        caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
        sendText(ws, caller.fullName
          ? `Absolutely. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : "Absolutely. Can I start by getting your full name, please?");
        return;
      }

      if (caller.leadType === "quote") {
        caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
        sendText(ws, caller.fullName
          ? `Absolutely. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : "Absolutely. Can I start by getting your full name, please?");
        return;
      }

      if (isLeakLikeIssue(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "leak_emergency_choice";
        sendText(ws, `I'm sorry you're dealing with ${caller.issueSummary}. Do you want me to mark this as an emergency?`);
        return;
      }

      caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
      if (caller.emergencyAlert) {
        sendText(ws, caller.fullName
          ? `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : `I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Can I start by getting your full name, please?`);
      } else {
        sendText(ws, caller.fullName
          ? `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I'd be happy to help with that. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : `I'm sorry you're dealing with ${caller.issueSummary}. I'd be happy to help with that. Can I start by getting your full name, please?`);
      }
      return;
    }

    case "ask_issue_again": {
      caller.issue = cleanForSpeech(text);
      afterIssueCaptured(caller);
      if (caller.leadType === "quote" || caller.leadType === "demo") {
        caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
        sendText(ws, caller.fullName
          ? `Absolutely. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : "Absolutely. Can I start by getting your full name, please?");
        return;
      }
      if (isLeakLikeIssue(caller.issue) && !caller.emergencyAlert) {
        caller.lastStep = "leak_emergency_choice";
        sendText(ws, `I'm sorry you're dealing with ${caller.issueSummary}. Do you want me to mark this as an emergency?`);
        return;
      }
      caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
      sendText(ws, caller.fullName
        ? `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
        : "Can I start by getting your full name, please?");
      return;
    }

    case "leak_emergency_choice": {
      if (isAffirmative(text)) {
        markEmergency(caller);
        caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
        sendText(ws, caller.fullName
          ? `Alright, ${caller.firstName}. I'm going to mark this as an emergency so our service team can review it right away. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : "Alright. I'm going to mark this as an emergency so our service team can review it right away. Can I start with your full name?");
        return;
      }

      if (isNegative(text)) {
        markStandardService(caller);
        caller.lastStep = caller.fullName ? "confirm_phone" : "ask_name";
        sendText(ws, caller.fullName
          ? `Alright, ${caller.firstName}. I've got this as a standard service request. I just need to gather a few details from you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
          : "Alright. I've got this as a standard service request. I just need to gather a few details from you. Can I start with your full name?");
        return;
      }

      sendText(ws, "Do you want me to mark this as an emergency?");
      return;
    }

    case "ask_name": {
      const parsedName = parseFullNameFromSpeech(text);
      if (!parsedName) {
        sendText(ws, "I'm sorry, I didn't quite catch the name. Could you please say your full name?");
        return;
      }
      caller.fullName = parsedName;
      caller.firstName = getFirstName(parsedName);
      if (!hasFullName(parsedName)) {
        caller.lastStep = "ask_last_name";
        sendText(ws, `Thank you, ${caller.firstName}. Can I get your last name as well?`);
        return;
      }
      caller.lastStep = "confirm_phone";
      sendText(ws, `Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`);
      return;
    }

    case "ask_last_name": {
      const possibleFullName = parseFullNameFromSpeech(`${caller.firstName} ${text}`);
      if (!possibleFullName || !hasFullName(possibleFullName)) {
        sendText(ws, "I'm sorry, I didn't quite catch the last name. Could you please repeat it?");
        return;
      }
      caller.fullName = possibleFullName;
      caller.firstName = getFirstName(possibleFullName);
      caller.lastStep = "confirm_phone";
      sendText(ws, `Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`);
      return;
    }

    case "confirm_phone": {
      if (isPhoneCorrection(text)) {
        caller.callbackConfirmed = false;
        caller.lastStep = "get_new_phone";
        sendText(ws, "No problem. What's the best number to reach you?");
        return;
      }
      caller.callbackConfirmed = true;
      caller.lastStep = "ask_address";
      sendText(ws, caller.leadType === "quote" ? "What is the project address?" : "What is the service address?");
      return;
    }

    case "get_new_phone": {
      caller.callbackNumber = cleanForSpeech(text);
      caller.callbackConfirmed = true;
      caller.lastStep = "ask_address";
      sendText(ws, caller.leadType === "quote" ? "What is the project address?" : "What is the service address?");
      return;
    }

    case "ask_address": {
      caller.address = normalizeAddressInput(text);
      caller.lastStep = "confirm_address";
      sendText(ws, `Great, let me make sure I have this right. You said ${formatAddressForSpeech(caller.address)}. Is that correct?`);
      return;
    }

    case "confirm_address": {
      if (isAffirmative(text)) {
        if (caller.leadType === "quote") {
          caller.lastStep = "ask_project_timeline";
          sendText(ws, "What is the projected timeline or start date for this project?");
          return;
        }
        if (caller.leadType === "demo") {
          caller.lastStep = "ask_demo_email_optional";
          sendText(ws, "Would you like to include an email address as well?");
          return;
        }
        if (caller.emergencyAlert) {
          caller.lastStep = "ask_notes";
          sendText(ws, "Before I submit this, is there anything else you'd like me to note for the technician?");
          return;
        }
        caller.lastStep = "schedule_or_callback";
        sendText(ws, "Alright, I've got all the information I need. Now let's talk about a callback time that works best for you. Do you have something in mind, or would you like me to find the first available for you?");
        return;
      }
      if (isNegative(text)) {
        caller.address = "";
        caller.lastStep = "ask_address";
        sendText(ws, caller.leadType === "quote" ? "I'm sorry about that. Let's try it again. What is the project address?" : "I'm sorry about that. Let's try it again. What is the service address?");
        return;
      }
      sendText(ws, `Great, let me make sure I have this right. You said ${formatAddressForSpeech(caller.address)}. Is that correct?`);
      return;
    }

    case "ask_project_timeline": {
      caller.timeline = cleanForSpeech(text);
      caller.lastStep = "ask_project_scope";
      sendText(ws, "Can you give me a quick idea of what all you'd like done?");
      return;
    }

    case "ask_project_scope": {
      caller.notes = cleanForSpeech(text);
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
      if (isAffirmative(text)) {
        caller.lastStep = "capture_quote_email";
        sendText(ws, "Alright, go ahead and spell that out for me.");
        return;
      }
      caller.lastStep = "ask_notes";
      sendText(ws, "Is there anything else you'd like me to include with this quote request?");
      return;
    }

    case "capture_quote_email": {
      caller.demoEmail = cleanForSpeech(text);
      caller.lastStep = "ask_notes";
      sendText(ws, "Is there anything else you'd like me to include with this quote request?");
      return;
    }

    case "ask_demo_email_optional": {
      if (isAffirmative(text)) {
        caller.lastStep = "capture_demo_email";
        sendText(ws, "Alright, go ahead and spell that out for me.");
        return;
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
        sendText(ws, buildCalendarLookupPrompt(caller, text, isFirstAvailableRequest(text) ? "first_available" : "general"));
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback request, and someone from the office will reach out to confirm the exact callback time. Is there anything else you'd like me to note for the technician?");
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }

      if (normalizedText(text).includes("call") || normalizedText(text).includes("callback")) {
        caller.status = "callback_requested";
        caller.lastStep = "ask_notes";
        sendText(ws, "Alright. Someone from the office will call you to arrange the next available time. Is there anything else you'd like me to note for the technician?");
        return;
      }

      caller.lastStep = "ask_appointment_day";
      sendText(ws, "What day works best for you?");
      return;
    }

    case "ask_appointment_day": {
      const requestDetails = parseAvailabilityRequest(text, caller.requestedDate, caller.pendingOfferedTime);
      if (requestDetails.requestedDate || requestDetails.requestedTimePreference || isSpecificTime(text) || isFirstAvailableRequest(text)) {
        caller.requestedDate = requestDetails.requestedDate || cleanForSpeech(text);
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        sendText(ws, buildCalendarLookupPrompt(caller, text, extractDatePart(text) ? "specific_date" : "general"));
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback request, and someone from the office will reach out to confirm the exact callback time. Is there anything else you'd like me to note for the technician?");
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
      if (isFirstAvailableRequest(text) || isAlternateAvailabilityRequest(text) || isSpecificTime(text) || detectTimePreference(text)) {
        const requestDetails = parseAvailabilityRequest(text, caller.appointmentDate, caller.pendingOfferedTime);
        caller.requestedDate = requestDetails.requestedDate || caller.appointmentDate;
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        sendText(ws, buildCalendarLookupPrompt(caller, text, isAlternateAvailabilityRequest(text) ? "alternate" : (extractDatePart(text) ? "specific_date" : "general")));
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          caller.status = "callback_requested";
          caller.appointmentTime = detectTimePreference(text) || cleanForSpeech(text);
          caller.lastStep = "ask_notes";
          sendText(ws, "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback preference, and someone from the office will reach out to confirm the exact callback time. Is there anything else you'd like me to note for the technician?");
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }
      caller.appointmentTime = cleanForSpeech(text);
      caller.status = "scheduled";
      caller.lastStep = "ask_notes";
      sendText(ws, "Okay, I have you scheduled for your callback. Is there anything else you'd like me to note for the technician?");
      return;
    }

    case "confirm_first_available": {
      if (isRepeatTimeRequest(text)) {
        sendText(ws, buildCallbackOfferPrompt(caller, caller.pendingOfferedDate, caller.pendingOfferedTime));
        return;
      }

      if (isAlternateAvailabilityRequest(text)) {
        const requestDetails = parseAvailabilityRequest(text, caller.pendingOfferedDate, caller.pendingOfferedTime);
        caller.requestedDate = requestDetails.requestedDate || caller.pendingOfferedDate;
        caller.requestedTimePreference = requestDetails.requestedTimePreference;
        caller.pendingAvailabilityQuery = requestDetails.rawQuery || cleanForSpeech(text);
        sendText(ws, buildCalendarLookupPrompt(caller, text, "alternate"));
        const availability = await checkCalendarAvailability(caller, requestDetails);
        if (!availability) {
          sendText(ws, "I'm sorry, I wasn't able to pull another option right now. Someone from the office will reach out to confirm the exact callback time.");
          caller.status = "callback_requested";
          caller.lastStep = "ask_notes";
          sendText(ws, "Is there anything else you'd like me to note for the technician?");
          return;
        }
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        sendText(ws, `I don't have the earlier time open, but I do have ${spokenAvailabilityPhrase(caller.pendingOfferedDate, caller.pendingOfferedTime)} available. Would you like me to schedule that callback instead?`);
        return;
      }

      if (isAffirmative(text)) {
        caller.appointmentDate = caller.pendingOfferedDate;
        caller.appointmentTime = caller.pendingOfferedTime;
        caller.status = "scheduled";
        caller.calendarSlotConfirmed = true;
        caller.lastStep = "ask_notes";
        sendText(ws, `Okay, I have you scheduled for your callback on ${caller.appointmentDate} at ${caller.appointmentTime}. Is there anything else you'd like me to note for the technician?`);
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
      if (!isEndCallPhrase(text)) caller.notes = cleanForSpeech(text);
      await sendLeadToMake(caller);
      await sendBookingToMake(caller);

      if (caller.leadType === "demo") {
        caller.lastStep = "final_question";
        sendText(ws, "Okay, I've got everything I need. Someone from the office will reach out to you about the demo. Is there anything else I can help you with before I let you go?");
        return;
      }

      caller.lastStep = "offer_demo_followup";

      if (caller.emergencyAlert) {
        sendText(ws, `Okay, I've got this marked as an emergency for ${caller.issueSummary}, and someone from our service team will contact you shortly. How did you enjoy the demo? Would you like me to have one of our team members call you to discuss how this could help your company?`);
        return;
      }

      if (caller.leadType === "quote") {
        sendText(ws, "Okay, I've got everything I need. Someone from the office will reach out to you about your quote request. How did you enjoy the demo? Would you like me to have one of our team members call you to discuss how this could help your company?");
        return;
      }

      if (caller.status === "scheduled") {
        sendText(ws, `Okay, I've got you scheduled for a callback on ${caller.appointmentDate} at ${caller.appointmentTime}. Someone will reach out to you then. How did you enjoy the demo? Would you like me to have one of our team members call you to discuss how this could help your company?`);
        return;
      }

      sendText(ws, `Okay, I've got everything I need. Someone from the office will contact you shortly about ${caller.issueSummary}. How did you enjoy the demo? Would you like me to have one of our team members call you to discuss how this could help your company?`);
      return;
    }

    case "offer_demo_followup": {
      // IMPORTANT: check for "no" first. With streaming transcripts, the "no" can be merged or clipped.
      // We prefer honoring a decline rather than accidentally treating it as a yes.
      if (isNegative(text) || isEndCallPhrase(text)) {
        caller.demoFollowupRequested = false;
        caller.lastStep = "final_question";
        sendText(ws, "No problem. Before I let you go, is there anything else I can help you with?");
        return;
      }

      if (isAffirmative(text)) {
        caller.demoFollowupRequested = true;
        caller.lastStep = "ask_demo_followup_contact_name";
        sendText(ws, "Great. Who should we reach out to about the demo?");
        return;
      }

      sendText(ws, "Would you like for me to have one of our team members call you to discuss how this could help your company?");
      return;
    }

    case "ask_demo_followup_contact_name": {
      const parsedName = parseFullNameFromSpeech(text);
      if (!parsedName) {
        sendText(ws, "I'm sorry, I didn't quite catch the contact name. What is the best contact name for us to use regarding this demo?");
        return;
      }
      caller.demoFollowupContactName = parsedName;
      caller.lastStep = "ask_demo_followup_phone";
      sendText(ws, "What is the best callback number for us to use regarding this demo?");
      return;
    }

    case "ask_demo_followup_phone": {
      caller.demoFollowupCallbackNumber = cleanForSpeech(text);
      caller.lastStep = "ask_demo_followup_email_optional";
      sendText(ws, "Would you like to include an email address as well?");
      return;
    }

    case "ask_demo_followup_email_optional": {
      if (isAffirmative(text)) {
        caller.lastStep = "capture_demo_followup_email";
        sendText(ws, "Alright, go ahead and spell that out for me.");
        return;
      }
      if (!isNegative(text) && text.includes("@")) {
        caller.demoFollowupEmail = cleanForSpeech(text);
      }
      await sendDemoFollowupToMake(caller);
      closeSession(ws, "Alright. I'll have someone from our team reach out about the demo using that contact information. Thank you for calling.");
      return;
    }

    case "capture_demo_followup_email": {
      caller.demoFollowupEmail = cleanForSpeech(text);
      await sendDemoFollowupToMake(caller);
      closeSession(ws, "Alright. I'll have someone from our team reach out about the demo using that contact information. Thank you for calling.");
      return;
    }

    case "final_question": {
      if (isNegative(text) || isEndCallPhrase(text)) {
        closeSession(ws, `Alright, ${caller.firstName || "there"}, you're all set. Thank you for calling.`);
        return;
      }
      closeSession(ws, `Alright, ${caller.firstName || "there"}, you're all set. Thank you for calling.`);
      return;
    }

    default: {
      caller.lastStep = "ask_issue";
      sendText(ws, "Please go ahead and tell me what is going on.");
      return;
    }
  }
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
    incomingAllow: true
  }));
  return token.toJwt();
}

function verifyTwilioRequest(req) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return true;
  try {
    const signature = req.headers["x-twilio-signature"];
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body || {});
  } catch (err) {
    console.error("[TWILIO REQUEST VALIDATION ERROR]", err.message);
    return false;
  }
}

app.get("/twilio-token", (req, res) => {
  const identity = buildBrowserCallingIdentity(req);
  const token = createBrowserCallingToken(identity);

  if (!token) {
    return res.status(500).send("Missing browser calling environment variables");
  }

  if ((req.get("accept") || "").includes("application/json")) {
    return res.json({ identity, token });
  }

  res.type("text/plain").send(token);
});

app.get("/", (req, res) => {
  res.send(`Server is running - ${APP_VERSION}`);
});

app.post("/incoming-call", (req, res) => {
  if (!verifyTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  if (!PUBLIC_BASE_URL) {
    return res.status(500).send("Missing PUBLIC_BASE_URL");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.conversationRelay({
    url: `${PUBLIC_BASE_URL.replace(/^http/i, "ws")}/conversation-relay`,
    welcomeGreeting: "Thank you for calling the Blue Caller Automation demo line. How can I help you?",
    welcomeGreetingInterruptible: "speech",
    language: "en-US",
    ttsProvider: "ElevenLabs",
    elevenlabsTextNormalization: "on",
    interruptible: "speech",
    interruptSensitivity: "medium",
    reportInputDuringAgentSpeech: "speech",
    debug: "debugging"
  });

  res.type("text/xml").send(twiml.toString());
});

app.post("/connect-action", (req, res) => {
  res.status(204).send();
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/conversation-relay") {
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
        caller.callbackNumber = caller.phone;
        return;
      }

      if (type === "interrupt") {
        return;
      }

      if (type === "prompt") {
        if (data.voicePrompt) {
          caller.promptBuffer = `${caller.promptBuffer ? caller.promptBuffer + " " : ""}${data.voicePrompt}`;
        }
        if (data.last === false) return;
        const completePrompt = cleanSpeechText(caller.promptBuffer || data.voicePrompt || "");
        caller.promptBuffer = "";
        await handlePrompt(ws, caller, completePrompt);
        return;
      }

      if (type === "error") {
        console.error("[CONVERSATIONRELAY ERROR]", data.description || "Unknown error");
        return;
      }

      if (type === "dtmf") {
        return;
      }

      console.log("[WS MESSAGE IGNORED]", data);
    } catch (err) {
      console.error("[WS MESSAGE ERROR]", err.message);
      sendText(ws, "I'm sorry, something went wrong. Could you please say that again?");
    }
  });

  ws.on("close", () => {
    wsBySession.delete(ws.sessionKey);
  });

  ws.on("error", (err) => {
    console.error("[WS ERROR]", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});