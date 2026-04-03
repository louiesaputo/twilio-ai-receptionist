/*************************************************
 VERSION: V100-CALENDAR-CHECK-FILLER
 DATE: 2026-04-03

 NOTES:
 - Keeps browser / PC call support
 - Keeps calendar-driven scheduling flow
 - Uses dedicated Make availability webhook
 - Uses dedicated Make booking webhook for confirmed callback slots
 - Preserves requested day when asking for another option
 - Improves acceptance of natural yes/no-style replies
 - Sends current local date/time to availability scenario to prevent day drift
 - Improves opening name + issue capture
 - Prevents false names like "Not"
 - Expands major appliance detection and aliases
 - Adds better unknown-item fallback summaries
 - Improves appliance issue summaries
 - Keeps appliance drain issues classified as appliance issues
 - Adds ambiguous first-name spelling confirmation
 - Improves spoken callback date phrasing for tomorrow/today
 - Adds demo follow-up contact confirmation + corrected contact capture
 - Writes confirmed calendar-backed callback slots to dedicated Make booking webhook
 - Places service address into the booking payload for Calendar Location mapping
 - Confirms address using natural wording
 - Improves ZIP/address cleanup including spaced-out digits
 - Broadens natural affirmative/negative intent handling
 - Keeps softer, varied fallback wording for weak or choppy audio
 - Calms speech sensitivity so tiny background sounds do not end the gather prematurely
 - Adds an immediate spoken calendar-check filler before availability lookup to remove awkward dead air
*************************************************/

console.log("🔥 BLUE CALLER SERVER V100 LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");
const path = require("path");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V100-CALENDAR-CHECK-FILLER";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";
const AVAILABILITY_WEBHOOK_URL = "https://hook.us2.make.com/c2gnxl52lvw69122ylvb66gksudiw8jb";
const BOOKING_WEBHOOK_URL = "https://hook.us2.make.com/fm94sa7ws2s7kynhskinnu825lr87pn4";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static("public"));

const callerStore = {};

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

const MISSED_AUDIO_PROMPTS = [
  "I'm sorry, I didn't catch that. Could you say that again?",
  "I'm sorry, I missed that. Could you repeat it for me?",
  "I'm sorry, I think our phone call is a little choppy. Could you say that again?"
];

const CHOPPY_AUDIO_PROMPTS = [
  "You're cutting in and out just a little bit, so I'm going to have to ask you to repeat yourself.",
  "Our phone connection seems a little choppy, but I can hear you. Please say that again for me.",
  "I'm sorry, I only caught part of that. Could you repeat it one more time?"
];

function getOrCreateCaller(phone) {
  if (!callerStore[phone]) {
    callerStore[phone] = {
      phone,
      fullName: null,
      firstName: null,
      callbackNumber: phone,
      callbackConfirmed: null,
      address: null,

      issue: null,
      issueSummary: null,
      urgency: "normal",
      emergencyAlert: false,
      leakNeedsEmergencyChoice: false,

      leadType: "service",
      projectType: "",
      timeline: "",
      proposalDeadline: "",
      demoEmail: "",
      applianceType: "",
      applianceWarranty: "",
      pendingIssueItem: "",
      pendingIssuePrompt: "",

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

      demoFollowupRequested: false,
      demoFollowupSent: false,
      demoFollowupContactName: "",

      nameSpellingConfirmed: false,
      pendingNameNextStep: "",
      demoFollowupCallbackNumber: "",
      demoFollowupEmail: "",

      makeSent: false,
      lastStep: "ask_issue",
      silenceCount: 0,
      audioRepromptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  callerStore[phone].updatedAt = new Date().toISOString();
  return callerStore[phone];
}

function resetCallerForNewCall(caller, phone) {
  caller.phone = phone;
  caller.fullName = null;
  caller.firstName = null;
  caller.callbackNumber = phone;
  caller.callbackConfirmed = null;
  caller.address = null;

  caller.issue = null;
  caller.issueSummary = null;
  caller.urgency = "normal";
  caller.emergencyAlert = false;
  caller.leakNeedsEmergencyChoice = false;

  caller.leadType = "service";
  caller.projectType = "";
  caller.timeline = "";
  caller.proposalDeadline = "";
  caller.demoEmail = "";
  caller.applianceType = "";
  caller.applianceWarranty = "";
  caller.pendingIssueItem = "";
  caller.pendingIssuePrompt = "";

  caller.notes = "";
  caller.status = "new_lead";

  caller.appointmentDate = "";
  caller.appointmentTime = "";
  caller.requestedDate = "";
  caller.requestedTimePreference = "";
  caller.pendingOfferedDate = "";
  caller.pendingOfferedTime = "";
  caller.pendingAvailabilityQuery = "";
  caller.calendarSlotConfirmed = false;
  caller.bookingSent = false;

  caller.demoFollowupRequested = false;
  caller.demoFollowupSent = false;
  caller.demoFollowupContactName = "";

  caller.nameSpellingConfirmed = false;
  caller.pendingNameNextStep = "";
  caller.demoFollowupCallbackNumber = "";
  caller.demoFollowupEmail = "";

  caller.makeSent = false;
  caller.lastStep = "ask_issue";
  caller.silenceCount = 0;
  caller.audioRepromptCount = 0;
  caller.updatedAt = new Date().toISOString();
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

function wordCount(text) {
  return cleanForSpeech(text || "").split(/\s+/).filter(Boolean).length;
}

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

  if (candidateDateOnly < currentDateOnly) {
    year += 1;
  }

  const startLocal = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const endLocal = addMinutesToLocalDateTime(startLocal, 30);

  return {
    startLocal,
    endLocal
  };
}

function containsAny(text, phrases) {
  return phrases.some((p) => text.includes(p));
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

function toTitleCase(value) {
  if (!value) return "";
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
}

function hasFullName(name) {
  if (!name) return false;
  return cleanForSpeech(name).split(/\s+/).filter(Boolean).length >= 2;
}

function firstNameNeedsSpelling(name) {
  const first = normalizedText(name).replace(/[^a-z]/g, "");
  if (!first) return false;
  return AMBIGUOUS_FIRST_NAMES.has(first);
}

function normalizeSpelledFirstName(text, fallback = "") {
  const letters = cleanForSpeech(text || "").replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 2 && letters.length <= 15) {
    return toTitleCase(letters);
  }
  return fallback || "";
}

function maybeAskFirstNameSpelling(twiml, res, caller, nextStep) {
  if (caller.firstName && !caller.nameSpellingConfirmed && firstNameNeedsSpelling(caller.firstName)) {
    caller.pendingNameNextStep = nextStep || (hasFullName(caller.fullName) ? "confirm_phone" : "ask_last_name");
    caller.lastStep = "ask_first_name_spelling";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `${toTitleCase(caller.firstName)} can be spelled a few different ways. How do you spell it?`
    );
  }
  return null;
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

function normalizeNameCandidate(rawName) {
  if (!rawName) return "";

  const cleaned = cleanName(rawName).toLowerCase();

  const stopWords = new Set([
    "and",
    "i",
    "have",
    "need",
    "calling",
    "about",
    "with",
    "for",
    "regarding",
    "because",
    "alex",
    "my",
    "name",
    "is",
    "this",
    "am",
    "im"
  ]);

  const blockedNameWords = new Set([
    "not",
    "no",
    "issue",
    "problem",
    "service",
    "schedule",
    "scheduling",
    "appointment",
    "someone",
    "heating",
    "cooling",
    "draining",
    "working",
    "broken",
    "leaking",
    "burning",
    "stove",
    "oven",
    "range",
    "cooktop",
    "dishwasher",
    "refrigerator",
    "washer",
    "dryer",
    "microwave",
    "icemaker",
    "ice",
    "maker"
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
    .replace(/^(and\s+)?i\s+am\s+interested\s+in\s+/i, "")
    .replace(/^(and\s+)?i\'?m\s+interested\s+in\s+/i, "")
    .replace(/^i\s+need\s+someone\s+to\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^i\s+need\s+somebody\s+to\s+(come\s+)?look\s+at\s+/i, "")
    .replace(/^can\s+someone\s+look\s+at\s+/i, "")
    .replace(/^can\s+you\s+look\s+at\s+/i, "")
    .replace(/^i\s+need\s+service\s+for\s+/i, "")
    .replace(/^i\s+need\s+help\s+with\s+/i, "")
    .replace(/^i\'?m\s+having\s+an?\s+issue\s+with\s+/i, "")
    .replace(/^i\s+am\s+having\s+an?\s+issue\s+with\s+/i, "")
    .replace(/^there\s+is\s+an?\s+issue\s+with\s+/i, "")
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
      t.includes("oven") ||
      t.includes("dishwasher") ||
      t.includes("washer") ||
      t.includes("dryer") ||
      t.includes("range") ||
      t.includes("stove") ||
      t.includes("light") ||
      t.includes("door") ||
      t.includes("faucet")
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

      if (possibleName && issueText) {
        return { name: possibleName, issueText };
      }
    }

    const possibleNameOnly = normalizeNameCandidate(remainder);
    if (possibleNameOnly) {
      return { name: possibleNameOnly, issueText: "" };
    }
  }

  const patterns = [
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)(?:\s*,\s*|\s+and\s+)(.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(my\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(the\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(i\s+need\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(i\'?m\s+having\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(can\s+someone\s+.+)$/i,
    /^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+?)\s+(can\s+you\s+.+)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const possibleName = normalizeNameCandidate(match[1]);
    const issueText = stripIssueLeadIn(match[2]);

    if (possibleName && issueText) {
      return { name: possibleName, issueText };
    }
  }

  const markerOnly = normalized.match(/^(?:this is|my name is|i am|i'm)\s+([a-zA-Z' -]+)$/i);
  if (markerOnly) {
    const possibleName = normalizeNameCandidate(markerOnly[1]);
    if (possibleName) return { name: possibleName, issueText: "" };
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

  value = value.replace(
    /^(\d)\s+(\d{2,})(\b.*)$/i,
    (match, first, second, rest) => {
      if (second.startsWith(first)) return `${second}${rest}`;
      return match;
    }
  );

  value = value.replace(/^(\d{1,6})\s+\1(\b.*)$/i, "$1$2");
  value = value.replace(/\b(FL|Florida)\s+(\d{5})(\d{4})\b/i, "$1 $2-$3");
  value = value.replace(/\s{2,}/g, " ").trim();

  return value;
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.substring(1);
  return digits.split("").join(" ");
}

function isAffirmative(text) {
  const t = normalizeIntentText(text);

  if (containsAny(t, [
    "not an emergency",
    "not emergency",
    "non emergency",
    "nonemergency",
    "not urgent",
    "non urgent",
    "nonurgent"
  ])) {
    return false;
  }

  return (
    t === "yes" ||
    t === "yeah" ||
    t === "yep" ||
    t === "yup" ||
    t === "sure" ||
    t === "correct" ||
    t === "right" ||
    t === "ok" ||
    t === "okay" ||
    t === "absolutely" ||
    t === "definitely" ||
    t === "please do" ||
    t === "go ahead" ||
    t === "do that" ||
    t === "sounds good" ||
    t === "sounds great" ||
    t === "that works" ||
    t === "that will work" ||
    t === "thatll work" ||
    t === "works for me" ||
    t === "that works for me" ||
    t === "that is fine" ||
    t === "thats fine" ||
    t === "that is okay" ||
    t === "thats okay" ||
    t === "that is perfect" ||
    t === "thats perfect" ||
    t === "that should work" ||
    t === "that should be fine" ||
    t === "yes please" ||
    t === "yeah please" ||
    t === "yep please" ||
    t === "sure please" ||
    t === "okay please" ||
    t === "ok please" ||
    t === "ill take it" ||
    t === "i will take it" ||
    t === "ill take that" ||
    t === "i will take that" ||
    t === "book it" ||
    t === "schedule it" ||
    t === "lets do that" ||
    t === "let s do that" ||
    t.includes("that appointment works") ||
    t.includes("that time works") ||
    t.includes("that will be fine") ||
    t.includes("that sounds good") ||
    t.includes("that sounds great") ||
    t.includes("perfect") ||
    t.includes("mark this as an emergency") ||
    t.includes("make this an emergency") ||
    t.includes("this is an emergency") ||
    t.includes("its an emergency") ||
    t.includes("it is an emergency") ||
    t.includes("as soon as possible") ||
    t.includes("right away") ||
    t.includes("immediately")
  );
}

function isNegative(text) {
  const t = normalizeIntentText(text);

  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t === "no thanks" ||
    t === "no thank you" ||
    t === "not now" ||
    t === "not really" ||
    t === "dont" ||
    t === "do not" ||
    t === "pass" ||
    t === "skip" ||
    t.includes("not an emergency") ||
    t.includes("not emergency") ||
    t.includes("non emergency") ||
    t.includes("nonemergency") ||
    t.includes("not urgent") ||
    t.includes("non urgent") ||
    t.includes("nonurgent") ||
    t.includes("standard") ||
    t.includes("normal") ||
    t.includes("regular") ||
    t.includes("during business hours") ||
    t.includes("normal business hours") ||
    t.includes("business hours is fine") ||
    t.includes("can wait") ||
    t.includes("no rush") ||
    t.includes("that wont work") ||
    t.includes("that won't work") ||
    t.includes("that does not work") ||
    t.includes("that doesnt work") ||
    t.includes("that doesn't work") ||
    t.includes("something else") ||
    t.includes("another time") ||
    t.includes("different time")
  );
}

function isPhoneCorrection(text) {
  const t = normalizeIntentText(text);
  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("wrong number") ||
    t.includes("different number") ||
    t.includes("new number") ||
    t.includes("not that number") ||
    t.includes("thats not right") ||
    t.includes("that is not right") ||
    t.includes("incorrect")
  );
}

function isSkipResponse(text) {
  const t = normalizeIntentText(text);
  return (
    t === "skip" ||
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t === "none" ||
    t === "not right now" ||
    t === "id rather skip that" ||
    t === "i would rather skip that"
  );
}

function isEndCallPhrase(text) {
  const t = normalizedText(text);

  if (containsAny(t, [
    "that's all",
    "that is all",
    "nothing else",
    "i'm good",
    "im good",
    "all set",
    "no thank you",
    "no thanks",
    "that'll do it",
    "that will do it",
    "that should do it",
    "that's everything",
    "that is everything",
    "that's all i need",
    "that is all i need",
    "that's good",
    "that is good",
    "we're good",
    "we are good",
    "no that is all",
    "no that's all",
    "no that will do it",
    "no that'll do it",
    "no that should do it"
  ])) {
    return true;
  }

  const stripped = t.replace(/[^\w\s]/g, "").trim();
  return (
    stripped === "no" ||
    stripped === "done" ||
    stripped === "thats it" ||
    stripped === "that is it" ||
    stripped === "thatll do it" ||
    stripped === "that will do it" ||
    stripped === "that should do it"
  );
}

function isPricingQuestion(text) {
  const t = normalizedText(text);
  return (
    t.includes("how much") ||
    t.includes("price") ||
    t.includes("pricing") ||
    t.includes("cost") ||
    t.includes("what is this going to cost") ||
    t.includes("what's this going to cost") ||
    t.includes("what will this cost") ||
    t.includes("what will it cost") ||
    t.includes("how much is this gonna cost") ||
    t.includes("how much is this going to cost") ||
    t.includes("how much do you charge") ||
    t.includes("what do you charge") ||
    t.includes("service fee") ||
    t.includes("trip charge") ||
    t.includes("diagnostic fee")
  );
}

function pricingResponse() {
  return "That is a great question. Pricing can vary depending on the job, so someone from the office will go over that with you when they call.";
}

function callerSaysNotToldProblem(text) {
  const t = normalizedText(text);
  return (
    t.includes("haven't told you the problem") ||
    t.includes("didn't tell you the problem") ||
    t.includes("i didn't tell you the problem") ||
    t.includes("i havent told you the problem") ||
    t.includes("i have not told you the problem") ||
    t.includes("not the problem")
  );
}

function isHardEmergency(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "burst",
    "burst pipe",
    "flooding",
    "flooded",
    "sewer",
    "sewage",
    "gas leak",
    "no water",
    "gushing",
    "pouring",
    "water everywhere"
  ]);
}

function isLeakLikeIssue(text) {
  const t = normalizedText(text);
  return containsAny(t, ["leak", "leaking", "drip", "dripping"]);
}

function isQuoteIntent(text) {
  const t = normalizedText(text);

  if (containsAny(t, ["quote", "estimate", "proposal", "bid"])) return true;
  if (containsAny(t, ["remodel", "remodeling", "renovation", "renovating"])) return true;

  if (
    containsAny(t, ["install", "installation", "replace", "replacement", "new "]) &&
    containsAny(t, [
      "water heater",
      "toilet",
      "sink",
      "faucet",
      "shower",
      "tub",
      "bathroom",
      "kitchen",
      "garbage disposal"
    ]) &&
    !containsAny(t, ["leak", "leaking", "clog", "clogged", "repair", "fix", "burst", "gushing", "pouring"])
  ) {
    return true;
  }

  return false;
}

function isDemoIntent(text) {
  const t = normalizedText(text);
  return (
    t.includes("demo") ||
    t.includes("demonstration") ||
    t.includes("schedule a demo") ||
    t.includes("book a demo") ||
    t.includes("interested in your service") ||
    t.includes("interested in the service") ||
    t.includes("interested in your ai receptionist") ||
    t.includes("interested in the ai receptionist") ||
    t.includes("learn more about your service") ||
    t.includes("learn more about the service") ||
    t.includes("tell me more about your service") ||
    t.includes("how does this service work") ||
    t.includes("how does your service work") ||
    t.includes("virtual receptionist service") ||
    t.includes("ai receptionist service")
  );
}

function isDemoFollowupInterest(text) {
  const t = normalizedText(text);
  if (isNegative(t) || isEndCallPhrase(t)) return false;

  return (
    isAffirmative(t) ||
    containsAny(t, [
      "contact me",
      "have someone contact me",
      "have someone call me",
      "have somebody call me",
      "have someone reach out",
      "have somebody reach out",
      "reach out to me",
      "call me about it",
      "discuss how this works",
      "discuss how it works",
      "discuss how this could work",
      "for my company",
      "for my business",
      "tell me more",
      "learn more",
      "i'd like to talk to someone",
      "id like to talk to someone",
      "i would like to talk to someone",
      "yes please",
      "that would be great"
    ])
  );
}

function cleanQuoteProjectText(text) {
  if (!text) return "";

  return cleanForSpeech(text)
    .replace(/^hi[, ]*/i, "")
    .replace(/^hello[, ]*/i, "")
    .replace(/^hey[, ]*/i, "")
    .replace(/^this is [a-zA-Z' -]+[, ]*/i, "")
    .replace(/^my name is [a-zA-Z' -]+[, ]*/i, "")
    .replace(/^i(?:'d| would)? like to /i, "")
    .replace(/^i wanted to /i, "")
    .replace(/^i want to /i, "")
    .replace(/^i need to /i, "")
    .replace(/^get /i, "")
    .replace(/^quote (on|for)\s+/i, "")
    .replace(/^estimate (on|for)\s+/i, "")
    .replace(/^proposal (on|for)\s+/i, "")
    .replace(/^bid (on|for)\s+/i, "")
    .replace(/^a quote (on|for)\s+/i, "")
    .replace(/^an estimate (on|for)\s+/i, "")
    .replace(/^a proposal (on|for)\s+/i, "")
    .replace(/^a bid (on|for)\s+/i, "")
    .replace(/^remodel of\s+/i, "")
    .replace(/^remodel for\s+/i, "")
    .replace(/^quote request for\s+/i, "")
    .replace(/^quote request on\s+/i, "")
    .replace(/^pricing for\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyProjectType(text) {
  const raw = cleanQuoteProjectText(text);
  const t = normalizedText(raw);

  if (containsAny(t, ["bathroom", "bath"]) && containsAny(t, ["remodel", "remodeling", "renovation", "renovating"])) {
    return "a bathroom remodel";
  }

  if (t.includes("kitchen") && containsAny(t, ["remodel", "remodeling", "renovation", "renovating"])) {
    return "a kitchen remodel";
  }

  if (t.includes("water heater") && containsAny(t, ["install", "installation", "replace", "replacement", "new"])) {
    return "a water heater installation";
  }

  if (t.includes("toilet") && containsAny(t, ["install", "installation", "replace", "replacement", "new"])) {
    return "a toilet installation";
  }

  if (t.includes("faucet") && containsAny(t, ["install", "installation", "replace", "replacement", "new"])) {
    return "a faucet installation";
  }

  if (containsAny(t, ["bathroom", "bath"]) && containsAny(t, ["quote", "estimate", "proposal", "bid", "remodel"])) {
    return "a bathroom remodel";
  }

  if (t.includes("kitchen") && containsAny(t, ["quote", "estimate", "proposal", "bid", "remodel"])) {
    return "a kitchen remodel";
  }

  if (containsAny(t, ["remodel", "remodeling", "renovation", "renovating"])) {
    if (t.includes("bathroom") || t.includes("bath")) return "a bathroom remodel";
    if (t.includes("kitchen")) return "a kitchen remodel";
    return "a remodeling project";
  }

  return raw || "this project";
}

function detectServiceItem(issue) {
  const text = normalizedText(issue)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const items = [
    { pattern: /\b(refrigerator|refrigerators|fridge|fridges|freezer|freezers)\b/, label: "refrigerator", prompt: "your refrigerator", category: "appliance" },
    { pattern: /\b(wine fridge|wine refrigerator|wine cooler|wine coolers|wine chiller|wine chillers)\b/, label: "wine cooler", prompt: "your wine cooler", category: "appliance" },
    { pattern: /\b(beverage center|beverage centres|beverage fridge|beverage refrigerator|beverage refrigerators|beverage cooler|beverage coolers|drink fridge|drink refrigerator|soda fridge|soda refrigerator)\b/, label: "beverage center", prompt: "your beverage center", category: "appliance" },
    { pattern: /\b(dishwasher|dish washer|dishdrawer|dish drawer)\b/, label: "dishwasher", prompt: "your dishwasher", category: "appliance" },
    { pattern: /\b(ice maker|icemaker)\b/, label: "ice maker", prompt: "your ice maker", category: "appliance" },
    { pattern: /\b(ice machine|icemachine)\b/, label: "ice machine", prompt: "your ice machine", category: "appliance" },
    { pattern: /\b(range hood|hood vent|vent hood|oven hood|stove hood|hood)\b/, label: "range hood", prompt: "your range hood", category: "appliance" },
    { pattern: /\b(oven|wall oven|double oven)\b/, label: "oven", prompt: "your oven", category: "appliance" },
    { pattern: /\b(cooktop|cook top)\b/, label: "cooktop", prompt: "your cooktop", category: "appliance" },
    { pattern: /\b(range)\b/, label: "range", prompt: "your range", category: "appliance" },
    { pattern: /\b(stove|stovetop|stove top|burner|burners)\b/, label: "stove", prompt: "your stove", category: "appliance" },
    { pattern: /\b(deep fryer|built in fryer|built in deep fryer|fryer)\b/, label: "deep fryer", prompt: "your deep fryer", category: "appliance" },
    { pattern: /\b(warming drawer)\b/, label: "warming drawer", prompt: "your warming drawer", category: "appliance" },
    { pattern: /\b(trash compactor|compactor)\b/, label: "trash compactor", prompt: "your trash compactor", category: "appliance" },
    { pattern: /\b(washer|washing machine)\b/, label: "washer", prompt: "your washer", category: "appliance" },
    { pattern: /\b(dryer|clothes dryer)\b/, label: "dryer", prompt: "your dryer", category: "appliance" },
    { pattern: /\b(microwave|built in microwave)\b/, label: "microwave", prompt: "your microwave", category: "appliance" },
    { pattern: /\b(garbage disposal|disposal)\b/, label: "garbage disposal", prompt: "your garbage disposal", category: "appliance" },
    { pattern: /\b(faucet|tap)\b/, label: "faucet", prompt: "your faucet", category: "fixture" },
    { pattern: /\b(sink)\b/, label: "sink", prompt: "your sink", category: "fixture" },
    { pattern: /\b(toilet)\b/, label: "toilet", prompt: "your toilet", category: "fixture" },
    { pattern: /\b(water heater)\b/, label: "water heater", prompt: "your water heater", category: "fixture" }
  ];

  for (const item of items) {
    if (item.pattern.test(text)) return item;
  }

  return null;
}

function hasSpecificProblemDetail(issue) {
  const text = normalizedText(issue);

  return containsAny(text, [
    "not working",
    "isn't working",
    "isnt working",
    "stopped working",
    "won't work",
    "wont work",
    "not cooling",
    "isn't cooling",
    "isnt cooling",
    "not heating",
    "isn't heating",
    "isnt heating",
    "not drying",
    "isn't drying",
    "isnt drying",
    "not draining",
    "won't drain",
    "wont drain",
    "not turning on",
    "won't turn on",
    "wont turn on",
    "not starting",
    "won't start",
    "wont start",
    "not igniting",
    "not making ice",
    "not producing ice",
    "ice production",
    "making too much ice",
    "overproducing",
    "won't stop",
    "wont stop",
    "won't stop making ice",
    "wont stop making ice",
    "stopped",
    "broken",
    "cracked",
    "loose",
    "leak",
    "leaking",
    "drip",
    "dripping",
    "clog",
    "clogged",
    "overflow",
    "overflowing",
    "backed up",
    "backing up",
    "making noise",
    "noisy",
    "noise",
    "sparking",
    "smoke",
    "smoking",
    "burning smell",
    "gas smell",
    "water everywhere",
    "flooding",
    "freezing",
    "too warm",
    "too hot",
    "pilot",
    "not flushing",
    "running constantly",
    "not responding",
    "burner",
    "burners"
  ]);
}

function buildApplianceIssueSummary(issue, item) {
  const t = normalizedText(issue);

  if (!item || item.category !== "appliance") return "";

  if ((item.label === "stove" || item.label === "range" || item.label === "cooktop") && containsAny(t, [
    "burner",
    "burners",
    "not turning on",
    "won't turn on",
    "wont turn on",
    "not igniting",
    "won't ignite",
    "wont ignite"
  ])) {
    return `a ${item.label} burner that is not turning on`;
  }

  if (item.label === "oven" && containsAny(t, ["not heating", "isn't heating", "isnt heating"])) {
    return "an oven that is not heating properly";
  }

  if (item.label === "refrigerator" && containsAny(t, ["not cooling", "isn't cooling", "isnt cooling", "too warm"])) {
    return "a refrigerator that is not cooling";
  }

  if (item.label === "dishwasher" && containsAny(t, ["not draining", "won't drain", "wont drain"])) {
    return "a dishwasher that is not draining";
  }

  if (item.label === "washer" && containsAny(t, ["not draining", "won't drain", "wont drain"])) {
    return "a washer that is not draining";
  }

  if (item.label === "dryer" && containsAny(t, ["not heating", "isn't heating", "isnt heating", "not drying"])) {
    return "a dryer that is not heating properly";
  }

  if (item.label === "ice maker" && containsAny(t, [
    "not making ice",
    "not producing ice",
    "ice production",
    "making too much ice",
    "overproducing",
    "won't stop",
    "wont stop"
  ])) {
    return "an ice maker issue";
  }

  if (containsAny(t, ["not turning on", "won't turn on", "wont turn on"])) {
    return `a ${item.label} that is not turning on`;
  }

  if (containsAny(t, ["not working", "isn't working", "isnt working", "stopped working"])) {
    return `a ${item.label} that is not working`;
  }

  if (containsAny(t, ["not cooling", "isn't cooling", "isnt cooling"])) {
    return `a ${item.label} that is not cooling`;
  }

  if (containsAny(t, ["not heating", "isn't heating", "isnt heating"])) {
    return `a ${item.label} that is not heating properly`;
  }

  if (containsAny(t, ["not draining", "won't drain", "wont drain"])) {
    return `a ${item.label} that is not draining`;
  }

  if (containsAny(t, ["making noise", "noisy", "noise"])) {
    return `a noisy ${item.label}`;
  }

  if (containsAny(t, ["leak", "leaking", "drip", "dripping"])) {
    return `a leaking ${item.label}`;
  }

  return `an issue with ${item.prompt}`;
}

function detectApplianceSummary(issue) {
  const item = detectServiceItem(issue);
  if (!item || item.category !== "appliance") return "";
  return buildApplianceIssueSummary(issue, item);
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

function parseWarrantyStatus(text) {
  const t = normalizeIntentText(text);

  if (containsAny(t, [
    "i dont know",
    "i do not know",
    "not sure",
    "unsure",
    "maybe"
  ])) return "unknown";

  if (
    t === "yes" ||
    t === "yeah" ||
    t === "yep" ||
    t === "probably" ||
    t === "i think so" ||
    t === "it should be" ||
    t === "it is" ||
    t.includes("still under") ||
    t.includes("under warranty")
  ) return "yes";

  if (
    t === "no" ||
    t === "nope" ||
    t.includes("not anymore") ||
    t.includes("out of warranty") ||
    t.includes("not under warranty") ||
    t.includes("expired")
  ) return "no";

  return "unknown";
}

function applianceSchedulingPrompt() {
  return "If you have access to it, please have your model and serial number available when our team calls you to discuss your issue. Would you like to choose a callback time now, would you prefer someone from the office to call you, or would you like the first available callback time?";
}

function buildUnknownIssueSummary(issue) {
  const cleaned = cleanForSpeech(issue || "");
  if (!cleaned) return "the issue you described";

  const lower = cleaned.toLowerCase();
  const myMatch = lower.match(/\bmy\s+([a-z0-9\s-]{2,40})/i);
  if (myMatch && myMatch[1]) {
    const phrase = myMatch[1]
      .replace(/\b(is|isn'?t|won'?t|not|that|because|and)\b.*$/i, "")
      .trim();
    if (phrase) return `an issue with your ${phrase}`;
  }

  const theMatch = lower.match(/\bthe\s+([a-z0-9\s-]{2,40})/i);
  if (theMatch && theMatch[1]) {
    const phrase = theMatch[1]
      .replace(/\b(is|isn'?t|won'?t|not|that|because|and)\b.*$/i, "")
      .trim();
    if (phrase) return `an issue with the ${phrase}`;
  }

  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 77).trim()}...`;
}

function classifyIssue(issue) {
  const text = normalizedText(issue);
  const serviceItem = detectServiceItem(issue);
  const applianceSummary = detectApplianceSummary(issue);

  if (serviceItem && serviceItem.category === "appliance" && applianceSummary) {
    return { summary: applianceSummary };
  }

  if (
    containsAny(text, ["yard", "front yard", "back yard", "lawn", "outside"]) &&
    containsAny(text, ["leak", "water", "pooling", "drip", "dripping"])
  ) return { summary: "a leak in your yard" };

  if (text.includes("water main")) return { summary: "a possible water main leak" };
  if (text.includes("roof") && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a roof leak" };
  if (text.includes("ceiling") && containsAny(text, ["leak", "drip", "dripping", "pouring", "gushing"])) return { summary: "a ceiling leak" };
  if ((text.includes("faucet") || text.includes("sink")) && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaking faucet" };
  if (text.includes("water heater") && containsAny(text, ["leak", "drip", "dripping"])) return { summary: "a leaking water heater" };
  if (containsAny(text, ["clog", "clogged", "drain"])) return { summary: "a clogged drain" };
  if (containsAny(text, ["flood", "flooding", "flooded"])) return { summary: "flooding" };
  if (containsAny(text, ["burst", "burst pipe"])) return { summary: "a burst pipe" };
  if (containsAny(text, ["sewer", "sewage"])) return { summary: "a sewer backup" };
  if (containsAny(text, ["gas leak"])) return { summary: "a gas leak" };
  if (containsAny(text, ["no water"])) return { summary: "no water service" };
  if (containsAny(text, ["leak", "leaking", "drip", "dripping"])) return { summary: "a water leak" };

  if (serviceItem && serviceItem.category === "fixture") {
    return { summary: `an issue with ${serviceItem.prompt}` };
  }

  return { summary: buildUnknownIssueSummary(issue) };
}

function hasUsableProblemText(text) {
  if (!text) return false;
  const t = normalizedText(text);
  const count = wordCount(text);

  if (count >= 2) return true;

  return (
    isQuoteIntent(text) ||
    isDemoIntent(text) ||
    isHardEmergency(text) ||
    isLeakLikeIssue(text) ||
    containsAny(t, [
      "clog",
      "clogged",
      "drain",
      "faucet",
      "sink",
      "toilet",
      "roof",
      "ceiling",
      "water heater",
      "refrigerator",
      "fridge",
      "dishwasher",
      "stove",
      "oven",
      "range",
      "cooktop",
      "washer",
      "dryer",
      "microwave",
      "ice maker",
      "garbage disposal"
    ])
  );
}

function isAvailabilityRequest(text) {
  const t = normalizedText(text);
  return (
    t.includes("first available") ||
    t.includes("earliest available") ||
    t.includes("soonest available") ||
    t.includes("next available") ||
    t.includes("first opening") ||
    t.includes("next opening") ||
    t.includes("earliest opening") ||
    t.includes("available opening") ||
    t.includes("available appointment") ||
    t.includes("available time") ||
    t.includes("available slot") ||
    t.includes("when is your next opening") ||
    t.includes("when is the soonest") ||
    t.includes("what's your first available") ||
    t.includes("whats your first available") ||
    t.includes("what is your first available") ||
    t.includes("what's the first available") ||
    t.includes("what is the first available") ||
    t.includes("what's your next available") ||
    t.includes("what is your next available") ||
    t.includes("how soon can someone come") ||
    t.includes("how soon can someone come out") ||
    t.includes("how soon can you come") ||
    t.includes("when can someone come out") ||
    t.includes("do you have anything available") ||
    t.includes("what do you have available") ||
    t.includes("what do you have for") ||
    t.includes("do you have anything for")
  );
}

function isAlternateAvailabilityRequest(text) {
  const t = normalizedText(text);
  return (
    t.includes("what else do you have") ||
    t.includes("anything else do you have") ||
    t.includes("do you have anything else") ||
    t.includes("another option") ||
    t.includes("something else") ||
    t.includes("anything later") ||
    t.includes("any other times") ||
    t.includes("anything tomorrow") ||
    t.includes("anything else tomorrow") ||
    t.includes("what else do you have tomorrow") ||
    t.includes("what else is available") ||
    t.includes("what else is open") ||
    t.includes("instead")
  );
}

function isFlexibleSchedulingRequest(text) {
  const t = normalizedText(text);
  if (!t) return false;

  if (containsAny(t, [
    "today", "tomorrow", "next week", "this week",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
  ])) return true;

  if (detectTimePreference(text)) return true;
  if (isSpecificTime(text)) return true;

  return containsAny(t, [
    "what about",
    "how about",
    "instead",
    "monday or",
    "tuesday or",
    "wednesday or",
    "thursday or",
    "friday or"
  ]);
}

function detectTimePreference(text) {
  const t = normalizedText(text);

  if (containsAny(t, ["morning", "mornings", "early morning"])) return "Morning preferred";
  if (containsAny(t, ["afternoon", "afternoons", "later in the day"])) return "Afternoon preferred";
  if (containsAny(t, ["evening", "evenings", "tonight"])) return "Evening preferred";
  if (containsAny(t, ["any time", "anytime", "whenever"])) return "Any time preferred";

  return "";
}

function convertPreferenceToMakeValue(pref) {
  if (!pref) return "";
  if (pref === "Morning preferred") return "morning";
  if (pref === "Afternoon preferred") return "afternoon";
  if (pref === "Evening preferred") return "evening";
  if (pref === "Any time preferred") return "anytime";
  return pref;
}

function formatPreferenceForSpeech(pref) {
  if (!pref) return "";
  if (pref === "morning" || pref === "Morning preferred") return "morning";
  if (pref === "afternoon" || pref === "Afternoon preferred") return "afternoon";
  if (pref === "evening" || pref === "Evening preferred") return "evening";
  if (pref === "anytime" || pref === "Any time preferred") return "any time";
  return cleanForSpeech(pref).toLowerCase();
}

function isSpecificTime(text) {
  const t = normalizedText(text);

  return (
    /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(t) ||
    /\b(noon|midnight)\b/i.test(t) ||
    /\bbetween\s+\d{1,2}\s*(am|pm)?\s+and\s+\d{1,2}\s*(am|pm)?\b/i.test(t) ||
    /\b\d{1,2}:\d{2}\b/i.test(t)
  );
}

function extractDatePart(text) {
  let value = cleanForSpeech(text || "");
  if (!value) return "";

  const normalized = normalizedText(value);
  const containsDirectDate = containsAny(normalized, [
    "today", "tomorrow", "next week", "this week",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
  ]) || isSpecificTime(value);

  if (!containsDirectDate) {
    value = value
      .replace(/^let'?s say\s+/i, "")
      .replace(/^how about\s+/i, "")
      .replace(/^maybe\s+/i, "")
      .replace(/^for\s+/i, "")
      .replace(/\bwhat('?s| is)\s+(your\s+)?first available( appointment)?\b.*$/i, "")
      .replace(/\bwhat('?s| is)\s+the first available( appointment)?\b.*$/i, "")
      .replace(/\bwhat('?s| is)\s+(your\s+)?next available( appointment)?\b.*$/i, "")
      .replace(/\b(first|next|soonest|earliest)\s+(available\s+)?(appointment|opening|slot|time)\b.*$/i, "")
      .replace(/\bdo you have anything available\b.*$/i, "")
      .replace(/\bwhat do you have available\b.*$/i, "")
      .replace(/\bdo you have anything.*$/i, "")
      .replace(/\bwhat do you have.*$/i, "")
      .replace(/\banything in the .*$/i, "");
  }

  value = value
    .replace(/\bin the mornings?\b.*$/i, "")
    .replace(/\bin the afternoon\b.*$/i, "")
    .replace(/\bin the afternoons\b.*$/i, "")
    .replace(/\bin the evenings?\b.*$/i, "")
    .replace(/\bmornings?\b$/i, "")
    .replace(/\bafternoons?\b$/i, "")
    .replace(/\bevenings?\b$/i, "")
    .replace(/\bany time\b$/i, "")
    .replace(/\banytime\b$/i, "")
    .replace(/\bwhenever\b$/i, "")
    .trim();

  return value.replace(/[?.!,]+$/g, "").trim();
}

function parseAvailabilityRequest(text, existingDate = "") {
  const raw = cleanForSpeech(text || "");
  let datePart = extractDatePart(raw);
  const timePref = detectTimePreference(raw);

  if (!datePart && isFlexibleSchedulingRequest(raw)) {
    datePart = raw;
  }

  if (!datePart && existingDate && !containsAny(normalizedText(existingDate), [
    "first available requested",
    "availability requested"
  ])) {
    datePart = cleanForSpeech(existingDate);
  }

  return {
    rawQuery: raw,
    requestedDate: datePart || "",
    requestedTimePreference: convertPreferenceToMakeValue(timePref)
  };
}

function normalizeAvailabilityResponse(response) {
  if (!response || typeof response !== "object") return null;

  const date = cleanForSpeech(response.date || response.nextAvailableDate || "");
  const time = cleanForSpeech(response.time || response.nextAvailableTime || "");

  if (!date || !time) return null;

  return { date, time };
}

function nonDemoNotesPrompt(caller) {
  if (caller.leadType === "quote") {
    return "Before I submit this quote request, are there any notes or details you'd like me to add?";
  }
  return "Before I submit this, is there anything else you'd like me to note for the technician?";
}

function postSubmitFollowupPrompt(caller) {
  if (caller.leadType === "demo") {
    return "Is there anything else I can help you with today?";
  }
  return "How did you enjoy the demo? If you'd like, I can have someone from our team contact you to discuss how this could work for your company. Would you like me to do that?";
}

function buildMakePayload(caller) {
  const effectiveLeadType =
    caller.leadType === "quote"
      ? "quote"
      : caller.leadType === "demo"
      ? "demo"
      : (caller.leadType || (caller.emergencyAlert ? "emergency" : "service"));

  const effectiveStatus =
    caller.leadType === "quote"
      ? "quote_request"
      : caller.leadType === "demo"
      ? (caller.status || "demo_request")
      : (caller.status || "new_lead");

  const effectiveIssueSummary =
    caller.leadType === "quote"
      ? (caller.projectType || caller.issueSummary || "")
      : caller.leadType === "demo"
      ? (caller.issueSummary || "demo request")
      : (caller.issueSummary || "");

  const effectiveIssue =
    caller.leadType === "quote"
      ? (caller.projectType || caller.issueSummary || caller.issue || "")
      : caller.leadType === "demo"
      ? (caller.issue || caller.issueSummary || "demo request")
      : (caller.issue || "");

  let effectiveNotes =
    caller.leadType === "quote" && caller.issue && caller.projectType && caller.issue !== caller.projectType
      ? `${caller.notes ? caller.notes + " " : ""}Original caller request: ${caller.issue}`.trim()
      : (caller.notes || "");

  const applianceNoteParts = [];
  if (caller.applianceType) applianceNoteParts.push(`Appliance: ${caller.applianceType}`);
  if (caller.applianceWarranty) applianceNoteParts.push(`Warranty: ${caller.applianceWarranty}`);
  if (applianceNoteParts.length) {
    effectiveNotes = `${effectiveNotes ? effectiveNotes + " " : ""}${applianceNoteParts.join(". ")}.`.trim();
  }

  return {
    leadType: effectiveLeadType,
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    phone: caller.phone || "",
    callbackNumber: caller.callbackNumber || "",
    callbackConfirmed: caller.callbackConfirmed === true,
    address: caller.address || "",
    issue: effectiveIssue,
    issueSummary: effectiveIssueSummary,
    urgency: caller.urgency || "normal",
    emergencyAlert: caller.emergencyAlert === true,
    projectType: caller.projectType || "",
    applianceType: caller.applianceType || "",
    applianceWarranty: caller.applianceWarranty || "",
    timeline: caller.timeline || "",
    proposalDeadline: caller.proposalDeadline || "",
    demoEmail: caller.demoEmail || "",
    notes: effectiveNotes,
    status: effectiveStatus,
    appointmentDate: caller.appointmentDate || "",
    appointmentTime: caller.appointmentTime || "",
    source: "AI Receptionist",
    timestamp: new Date().toISOString()
  };
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

function shouldSendToMake(caller) {
  const payload = buildMakePayload(caller);

  if (payload.leadType === "service" || payload.leadType === "emergency") {
    return Boolean(payload.fullName && payload.phone && payload.issueSummary);
  }

  if (payload.leadType === "quote") {
    return Boolean(payload.fullName && payload.phone && payload.projectType);
  }

  if (payload.leadType === "demo") {
    return Boolean(payload.fullName && (payload.phone || payload.demoEmail));
  }

  return false;
}

function postJsonToWebhook(webhookUrl, payload, label, onComplete) {
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

    const webhookReq = https.request(options, (webhookRes) => {
      console.log(`[${label}] Status: ${webhookRes.statusCode}`);
      if (onComplete) onComplete();
    });

    webhookReq.on("error", (err) => {
      console.error(`[${label} ERROR]`, err.message);
      if (onComplete) onComplete(err);
    });

    webhookReq.write(data);
    webhookReq.end();
  } catch (err) {
    console.error(`[${label} ERROR]`, err.message);
    if (onComplete) onComplete(err);
  }
}

function postJsonToMake(payload, onComplete) {
  return postJsonToWebhook(MAKE_WEBHOOK_URL, payload, "MAKE", onComplete);
}

function sendLeadToMake(caller) {
  if (caller.makeSent) return;
  if (!shouldSendToMake(caller)) {
    console.log("⚠️ Skipping Make webhook — missing minimum required data");
    return;
  }

  const payload = buildMakePayload(caller);
  postJsonToMake(payload);
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
    callbackNumber: caller.callbackNumber || "",
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

function shouldSendBooking(caller) {
  const payload = buildBookingPayload(caller);
  if (!payload) return false;

  return Boolean(
    !caller.bookingSent &&
    caller.leadType === "service" &&
    caller.status === "scheduled" &&
    caller.calendarSlotConfirmed === true &&
    payload.fullName &&
    payload.callbackNumber &&
    payload.issueSummary &&
    payload.address &&
    payload.bookingStartDateTimeLocal &&
    payload.bookingEndDateTimeLocal
  );
}

function sendBookingToMake(caller) {
  if (!shouldSendBooking(caller)) {
    if (caller.status === "scheduled" && caller.calendarSlotConfirmed) {
      console.log("⚠️ Skipping booking webhook — missing booking data");
    }
    return;
  }

  const payload = buildBookingPayload(caller);
  postJsonToWebhook(BOOKING_WEBHOOK_URL, payload, "BOOKING");
  caller.bookingSent = true;
}

function sendDemoFollowupToMake(caller) {
  if (caller.demoFollowupSent) return;

  const payload = buildDemoFollowupPayload(caller);
  if (!payload.fullName || (!payload.phone && !payload.demoEmail)) {
    console.log("⚠️ Skipping demo follow-up webhook — missing contact info");
    return;
  }

  postJsonToMake(payload);
  caller.demoFollowupSent = true;
}

function checkCalendarAvailability(caller, requestDetails = {}) {
  return new Promise((resolve) => {
    try {
      const payloadObject = {
        action: "check_availability",
        phone: caller.phone,
        fullName: caller.fullName || "",
        firstName: caller.firstName || "",
        issueSummary: caller.issueSummary || "",
        address: caller.address || "",
        requestedDate: requestDetails.requestedDate || caller.requestedDate || "",
        requestedTimePreference: requestDetails.requestedTimePreference || caller.requestedTimePreference || "",
        availabilityQuery: requestDetails.rawQuery || caller.pendingAvailabilityQuery || "",
        currentDateLocal: currentDateInEastern(),
        currentDateTimeLocal: currentDateTimeInEastern()
      };

      const payload = JSON.stringify(payloadObject);
      const url = new URL(AVAILABILITY_WEBHOOK_URL);

      const options = {
        hostname: url.hostname,
        path: `${url.pathname}${url.search || ""}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      console.log("[CALENDAR CHECK REQUEST]", payloadObject);

      const req = https.request(options, (makeRes) => {
        let body = "";

        makeRes.on("data", (chunk) => {
          body += chunk;
        });

        makeRes.on("end", () => {
          console.log("[CALENDAR CHECK RAW RESPONSE]", body || "(empty)");
          try {
            const parsed = JSON.parse(body || "{}");
            resolve(parsed);
          } catch (err) {
            console.error("[CALENDAR CHECK PARSE ERROR]", err.message);
            resolve(null);
          }
        });
      });

      req.setTimeout(8000, () => {
        console.error("[CALENDAR CHECK ERROR] Request timed out");
        req.destroy();
        resolve(null);
      });

      req.on("error", (err) => {
        console.error("[CALENDAR CHECK ERROR]", err.message);
        resolve(null);
      });

      req.write(payload);
      req.end();
    } catch (err) {
      console.error("[CALENDAR CHECK ERROR]", err.message);
      resolve(null);
    }
  });
}

function parseConfidence(rawConfidence) {
  const n = Number(rawConfidence);
  return Number.isFinite(n) ? n : null;
}

function looksLikeWeakAudioTranscript(text) {
  const t = normalizeIntentText(text);

  if (!t) return true;

  if ([
    "uh",
    "um",
    "er",
    "ah",
    "huh",
    "hmm",
    "mm",
    "mhm",
    "hm",
    "uh huh",
    "nuh uh",
    "static",
    "noise"
  ].includes(t)) return true;

  if (/^[hm]+$/.test(t)) return true;
  if (t.length === 1) return true;

  return false;
}

function isLikelyNoiseTranscript(text, confidence) {
  const t = normalizeIntentText(text);
  const words = t ? t.split(/\s+/).filter(Boolean).length : 0;

  if (!t) return true;
  if (looksLikeWeakAudioTranscript(text)) return true;

  if (
    confidence !== null &&
    confidence < 0.35 &&
    words <= 2 &&
    t.length <= 12 &&
    !isAffirmative(t) &&
    !isNegative(t)
  ) {
    return true;
  }

  return false;
}

function nextRotatingPrompt(caller, prompts) {
  const index = caller.audioRepromptCount % prompts.length;
  caller.audioRepromptCount += 1;
  return prompts[index];
}

function nextMissedAudioPrompt(caller) {
  return nextRotatingPrompt(caller, MISSED_AUDIO_PROMPTS);
}

function nextChoppyAudioPrompt(caller) {
  return nextRotatingPrompt(caller, CHOPPY_AUDIO_PROMPTS);
}

function sayThenGather(twiml, res, actionUrl, prompt) {
  const gather = twiml.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    speechTimeout: "auto",
    timeout: 5,
    actionOnEmptyResult: true,
    language: "en-US"
  });

  gather.say({ voice: "alice" }, prompt);

  return res.type("text/xml").send(twiml.toString());
}

function sayThenRedirect(twiml, res, prompt, redirectUrl) {
  twiml.say({ voice: "alice" }, prompt);
  twiml.redirect({ method: "POST" }, redirectUrl);
  return res.type("text/xml").send(twiml.toString());
}

function getAddressPrompt(caller) {
  return caller.leadType === "quote" ? "What is the project address?" : "What is the service address?";
}

function proceedAfterConfirmedAddress(twiml, res, caller) {
  if (caller.leadType === "quote") {
    caller.leadType = "quote";
    caller.status = "quote_request";
    caller.lastStep = "ask_project_timeline";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Do you have a timeline in mind for this project?"
    );
  }

  if (caller.emergencyAlert) {
    caller.lastStep = "ask_notes";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      nonDemoNotesPrompt(caller)
    );
  }

  if (caller.applianceType) {
    caller.lastStep = "ask_appliance_warranty";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Do you know whether the appliance is still under the manufacturer's warranty?"
    );
  }

  caller.lastStep = "schedule_or_callback";
  return sayThenGather(
    twiml,
    res,
    "/handle-input",
    "Would you like to choose a callback day and time now, ask what is available on a specific day, or would you prefer the first available callback?"
  );
}

function moveToNameOrPhoneStep(twiml, res, caller, options = {}) {
  const {
    emergencyKnownNamePrompt = null,
    emergencyUnknownNamePrompt = null,
    normalKnownNamePrompt = null,
    normalUnknownNamePrompt = null,
    askLastNamePrompt = null
  } = options;

  if (caller.firstName && caller.fullName && !hasFullName(caller.fullName)) {
    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "ask_last_name");
    if (spellingPrompt) return spellingPrompt;

    caller.lastStep = "ask_last_name";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      askLastNamePrompt || `Thank you, ${caller.firstName}. Can I get your last name as well?`
    );
  }

  if (caller.fullName && caller.firstName) {
    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "confirm_phone");
    if (spellingPrompt) return spellingPrompt;
    caller.lastStep = "confirm_phone";

    if (caller.emergencyAlert) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        emergencyKnownNamePrompt ||
          `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      normalKnownNamePrompt ||
        `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I'd be more than happy to help you with that. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  caller.lastStep = "ask_name";

  if (caller.emergencyAlert) {
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      emergencyUnknownNamePrompt ||
        `I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Can I start by getting your full name, please?`
    );
  }

  return sayThenGather(
    twiml,
    res,
    "/handle-input",
    normalUnknownNamePrompt ||
      `I'm sorry you're dealing with ${caller.issueSummary}. I'd be more than happy to help you with that. Can I start by getting your full name, please?`
  );
}

function moveToQuoteNameOrPhoneStep(twiml, res, caller) {
  caller.leadType = "quote";
  caller.status = "quote_request";

  if (caller.firstName && caller.fullName && !hasFullName(caller.fullName)) {
    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "ask_last_name");
    if (spellingPrompt) return spellingPrompt;

    caller.lastStep = "ask_last_name";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you, ${caller.firstName}. Can I get your last name as well?`
    );
  }

  if (caller.fullName && caller.firstName) {
    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "confirm_phone");
    if (spellingPrompt) return spellingPrompt;
    caller.lastStep = "confirm_phone";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Absolutely, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  caller.lastStep = "ask_name";
  return sayThenGather(
    twiml,
    res,
    "/handle-input",
    "Absolutely. Can I start by getting your full name, please?"
  );
}

function moveToDemoNameOrPhoneStep(twiml, res, caller) {
  caller.leadType = "demo";
  caller.status = "demo_request";
  if (!caller.issueSummary) caller.issueSummary = "demo request";

  if (caller.firstName && caller.fullName && !hasFullName(caller.fullName)) {
    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "ask_last_name");
    if (spellingPrompt) return spellingPrompt;

    caller.lastStep = "ask_last_name";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you, ${caller.firstName}. Can I get your last name as well?`
    );
  }

  if (caller.fullName && caller.firstName) {
    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "confirm_phone");
    if (spellingPrompt) return spellingPrompt;
    caller.lastStep = "confirm_phone";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Absolutely, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  caller.lastStep = "ask_name";
  return sayThenGather(
    twiml,
    res,
    "/handle-input",
    "Absolutely. Can I start by getting your full name, please?"
  );
}

function resetPendingAvailability(caller) {
  caller.requestedDate = "";
  caller.requestedTimePreference = "";
  caller.pendingOfferedDate = "";
  caller.pendingOfferedTime = "";
  caller.pendingAvailabilityQuery = "";
}

function handleAvailabilityLookup(twiml, res, caller, speech, options = {}) {
  const shouldHandle =
    isAvailabilityRequest(speech) ||
    isAlternateAvailabilityRequest(speech) ||
    (options.allowFlexibleDateRequest && isFlexibleSchedulingRequest(speech));

  if (!shouldHandle) return false;

  const requestDetails = parseAvailabilityRequest(
    speech,
    options.existingDate || ""
  );

  caller.requestedDate = requestDetails.requestedDate;
  caller.requestedTimePreference = requestDetails.requestedTimePreference;
  caller.pendingAvailabilityQuery = requestDetails.rawQuery;
  caller.lastStep = "waiting_for_availability_lookup";

  return sayThenRedirect(
    twiml,
    res,
    "Sure, give me just a moment while I check the calendar for you.",
    "/perform-availability-check"
  );
}

app.post("/perform-availability-check", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  const requestDetails = {
    requestedDate: caller.requestedDate || "",
    requestedTimePreference: caller.requestedTimePreference || "",
    rawQuery: caller.pendingAvailabilityQuery || ""
  };

  const availabilityRaw = await checkCalendarAvailability(caller, requestDetails);
  const availability = normalizeAvailabilityResponse(availabilityRaw);

  if (availability && availability.date && availability.time) {
    caller.pendingOfferedDate = availability.date;
    caller.pendingOfferedTime = availability.time;
    caller.calendarSlotConfirmed = false;
    caller.lastStep = "confirm_first_available";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `I have ${spokenAvailabilityPhrase(caller.pendingOfferedDate, caller.pendingOfferedTime)} for a callback. Would that callback time work for you?`
    );
  }

  caller.status = "callback_requested";
  caller.calendarSlotConfirmed = false;
  caller.appointmentDate = requestDetails.requestedDate || "First available requested";
  caller.appointmentTime = requestDetails.requestedTimePreference
    ? `${formatPreferenceForSpeech(requestDetails.requestedTimePreference)} preferred`
    : "";
  caller.lastStep = "ask_notes";

  return sayThenGather(
    twiml,
    res,
    "/handle-input",
    "I'm sorry, I wasn't able to pull the calendar right now. I'll note your callback request, and someone from the office will reach out to confirm the exact callback time. Before I submit this, is there anything else you'd like me to note for the technician?"
  );
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  resetCallerForNewCall(caller, phone);

  const gather = twiml.gather({
    input: "speech",
    action: "/handle-input",
    method: "POST",
    speechTimeout: "auto",
    timeout: 5,
    actionOnEmptyResult: true,
    language: "en-US"
  });

  gather.say(
    { voice: "alice" },
    "Thank you for calling Blue Caller Automation. This is Alex, your virtual receptionist. This is a demonstration line, so you can hear how I would handle calls for your business. You can speak to me just like any of your customers would if they were calling for a quote, a service call, or emergency service. How can I help you today?"
  );

  res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const confidence = parseConfidence(req.body.Confidence);
  const caller = getOrCreateCaller(phone);

  if (!speech) {
    caller.silenceCount += 1;

    if (caller.silenceCount === 1) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        nextMissedAudioPrompt(caller)
      );
    }

    if (caller.silenceCount === 2) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        nextChoppyAudioPrompt(caller)
      );
    }

    twiml.say({ voice: "alice" }, "I'm sorry we weren't able to connect. Please call us back when you're ready. Thank you.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  caller.silenceCount = 0;

  if (isLikelyNoiseTranscript(speech, confidence)) {
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      nextChoppyAudioPrompt(caller)
    );
  }

  caller.audioRepromptCount = 0;

  if (callerSaysNotToldProblem(speech)) {
    caller.lastStep = "ask_issue";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Oh, I'm sorry about that. Please go ahead and tell me what is going on."
    );
  }

  if (caller.lastStep === "ask_issue") {
    const parsed = extractOpeningNameAndIssue(speech);

    if (parsed.name) {
      caller.fullName = parsed.name;
      caller.firstName = getFirstName(parsed.name);
      caller.nameSpellingConfirmed = false;
      console.log("✅ Captured opening name:", caller.fullName);
    }

    if (!hasUsableProblemText(parsed.issueText)) {
      caller.lastStep = "ask_issue_again";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I didn't quite catch the problem. Could you briefly tell me what is going on?"
      );
    }

    caller.issue = cleanForSpeech(parsed.issueText);
    caller.issueSummary = classifyIssue(caller.issue).summary;
    const detectedServiceItem = detectServiceItem(caller.issue);
    caller.applianceType = detectedServiceItem && detectedServiceItem.category === "appliance" ? detectedServiceItem.label : "";

    if (isHardEmergency(caller.issue)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      return moveToNameOrPhoneStep(twiml, res, caller);
    }

    if (isDemoIntent(caller.issue)) {
      caller.leadType = "demo";
      caller.status = "demo_request";
      caller.issueSummary = "demo request";
      return moveToDemoNameOrPhoneStep(twiml, res, caller);
    }

    if (isQuoteIntent(caller.issue)) {
      caller.leadType = "quote";
      caller.projectType = classifyProjectType(caller.issue);
      caller.issueSummary = caller.projectType;
      caller.status = "quote_request";
      caller.urgency = "normal";
      caller.emergencyAlert = false;
      return moveToQuoteNameOrPhoneStep(twiml, res, caller);
    }

    if (isLeakLikeIssue(caller.issue)) {
      caller.leakNeedsEmergencyChoice = true;
      caller.lastStep = "leak_emergency_choice";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `I'm sorry you're dealing with ${caller.issueSummary}. Do you want me to mark this as an emergency?`
      );
    }

    const missingProblemItem = detectMissingProblemItem(caller.issue);
    if (missingProblemItem) {
      caller.pendingIssueItem = missingProblemItem.label;
      caller.pendingIssuePrompt = missingProblemItem.prompt;
      if (missingProblemItem.category === "appliance") caller.applianceType = missingProblemItem.label;
      caller.lastStep = "ask_item_issue_detail";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `What seems to be going on with ${missingProblemItem.prompt}?`
      );
    }

    caller.leadType = "service";
    caller.urgency = "normal";
    caller.emergencyAlert = false;
    return moveToNameOrPhoneStep(twiml, res, caller);
  }

  if (caller.lastStep === "ask_issue_again") {
    caller.issue = cleanForSpeech(speech);
    caller.issueSummary = classifyIssue(caller.issue).summary;
    const detectedServiceItem = detectServiceItem(caller.issue);
    caller.applianceType = detectedServiceItem && detectedServiceItem.category === "appliance" ? detectedServiceItem.label : "";

    if (isHardEmergency(caller.issue)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      return moveToNameOrPhoneStep(twiml, res, caller);
    }

    if (isDemoIntent(caller.issue)) {
      caller.leadType = "demo";
      caller.status = "demo_request";
      caller.issueSummary = "demo request";
      return moveToDemoNameOrPhoneStep(twiml, res, caller);
    }

    if (isQuoteIntent(caller.issue)) {
      caller.leadType = "quote";
      caller.projectType = classifyProjectType(caller.issue);
      caller.issueSummary = caller.projectType;
      caller.status = "quote_request";
      caller.urgency = "normal";
      caller.emergencyAlert = false;
      return moveToQuoteNameOrPhoneStep(twiml, res, caller);
    }

    if (isLeakLikeIssue(caller.issue)) {
      caller.leakNeedsEmergencyChoice = true;
      caller.lastStep = "leak_emergency_choice";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `I'm sorry you're dealing with ${caller.issueSummary}. Do you want me to mark this as an emergency?`
      );
    }

    const missingProblemItem = detectMissingProblemItem(caller.issue);
    if (missingProblemItem) {
      caller.pendingIssueItem = missingProblemItem.label;
      caller.pendingIssuePrompt = missingProblemItem.prompt;
      if (missingProblemItem.category === "appliance") caller.applianceType = missingProblemItem.label;
      caller.lastStep = "ask_item_issue_detail";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `What seems to be going on with ${missingProblemItem.prompt}?`
      );
    }

    caller.leadType = "service";
    caller.urgency = "normal";
    caller.emergencyAlert = false;
    return moveToNameOrPhoneStep(twiml, res, caller);
  }

  if (caller.lastStep === "ask_item_issue_detail") {
    caller.issue = combineItemAndDetail(caller.pendingIssueItem, speech);
    caller.issueSummary = classifyIssue(caller.issue).summary;
    caller.pendingIssueItem = "";
    caller.pendingIssuePrompt = "";

    if (isHardEmergency(caller.issue)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      return moveToNameOrPhoneStep(twiml, res, caller);
    }

    if (isLeakLikeIssue(caller.issue)) {
      caller.leakNeedsEmergencyChoice = true;
      caller.lastStep = "leak_emergency_choice";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `I'm sorry you're dealing with ${caller.issueSummary}. Do you want me to mark this as an emergency?`
      );
    }

    caller.leadType = "service";
    caller.urgency = "normal";
    caller.emergencyAlert = false;
    return moveToNameOrPhoneStep(twiml, res, caller);
  }

  if (caller.lastStep === "leak_emergency_choice") {
    const normalizedEmergencyReply = normalizeIntentText(speech);

    if (isAffirmative(normalizedEmergencyReply)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      caller.leakNeedsEmergencyChoice = false;

      return moveToNameOrPhoneStep(twiml, res, caller, {
        emergencyKnownNamePrompt: `Alright, ${caller.firstName}. I'm going to mark this as an emergency so our service team can review it right away. I just need to gather a few details from you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`,
        emergencyUnknownNamePrompt: "Alright. I'm going to mark this as an emergency so our service team can review it right away. I just need to gather a few details from you. Can I start with your full name?",
        askLastNamePrompt: `Alright, ${caller.firstName}. I'm going to mark this as an emergency so our service team can review it right away. Before I go any further, can I get your last name as well?`
      });
    }

    if (isNegative(normalizedEmergencyReply)) {
      caller.emergencyAlert = false;
      caller.urgency = "normal";
      caller.leadType = "service";
      caller.status = "new_lead";
      caller.leakNeedsEmergencyChoice = false;

      return moveToNameOrPhoneStep(twiml, res, caller, {
        normalKnownNamePrompt: `Alright, ${caller.firstName}. I've got this as a standard service request. I just need to gather a few details so someone from the office can reach out and get this scheduled for you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`,
        normalUnknownNamePrompt: "Alright. I've got this as a standard service request. I just need to gather a few details so someone from the office can reach out and get this scheduled for you. Can I start with your full name?",
        askLastNamePrompt: `Alright, ${caller.firstName}. I've got this as a standard service request. Before I go any further, can I get your last name as well?`
      });
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Do you want me to mark this as an emergency? Please say yes or no."
    );
  }

  if (caller.lastStep === "ask_name") {
    const parsedName = parseFullNameFromSpeech(speech);

    if (!parsedName) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I didn't quite catch the name. Could you please say your full name?"
      );
    }

    caller.fullName = parsedName;
    caller.firstName = getFirstName(caller.fullName);
    caller.nameSpellingConfirmed = false;

    const spellingPrompt = maybeAskFirstNameSpelling(
      twiml,
      res,
      caller,
      hasFullName(caller.fullName) ? "confirm_phone" : "ask_last_name"
    );
    if (spellingPrompt) return spellingPrompt;

    if (!hasFullName(caller.fullName)) {
      caller.lastStep = "ask_last_name";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Thank you, ${caller.firstName}. Can I get your last name as well?`
      );
    }

    caller.lastStep = "confirm_phone";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "ask_first_name_spelling") {
    const spelledFirstName = normalizeSpelledFirstName(speech, caller.firstName || "");
    const remainingParts = cleanForSpeech(caller.fullName || "").split(/\s+/).filter(Boolean).slice(1).join(" ");

    caller.firstName = spelledFirstName || caller.firstName;
    caller.fullName = remainingParts ? `${caller.firstName} ${toTitleCase(remainingParts)}` : caller.firstName;
    caller.nameSpellingConfirmed = true;

    const nextStep = caller.pendingNameNextStep || (hasFullName(caller.fullName) ? "confirm_phone" : "ask_last_name");
    caller.pendingNameNextStep = "";

    if (nextStep === "ask_last_name") {
      caller.lastStep = "ask_last_name";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Thank you. Can I get your last name as well?"
      );
    }

    caller.lastStep = "confirm_phone";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "ask_last_name") {
    const possibleFullName = parseFullNameFromSpeech(`${caller.firstName} ${speech}`);

    if (!possibleFullName || !hasFullName(possibleFullName)) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I didn't quite catch the last name. Could you please repeat it?"
      );
    }

    caller.fullName = possibleFullName;
    caller.firstName = getFirstName(caller.fullName);

    const spellingPrompt = maybeAskFirstNameSpelling(twiml, res, caller, "confirm_phone");
    if (spellingPrompt) return spellingPrompt;

    caller.lastStep = "confirm_phone";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "confirm_phone") {
    if (isPhoneCorrection(speech)) {
      caller.callbackConfirmed = false;
      caller.lastStep = "get_new_phone";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "No problem. What's the best number to reach you?"
      );
    }

    caller.callbackConfirmed = true;

    if (caller.leadType === "quote") {
      caller.lastStep = "ask_address";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "What is the project address?"
      );
    }

    if (caller.leadType === "demo") {
      caller.lastStep = "ask_demo_email";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "If you'd like, what is the best email address for the demo follow-up? You can also say skip."
      );
    }

    caller.lastStep = "ask_address";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What is the service address?"
    );
  }

  if (caller.lastStep === "get_new_phone") {
    caller.callbackNumber = cleanForSpeech(speech);
    caller.callbackConfirmed = true;

    if (caller.leadType === "quote") {
      caller.lastStep = "ask_address";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "What is the project address?"
      );
    }

    if (caller.leadType === "demo") {
      caller.lastStep = "ask_demo_email";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "If you'd like, what is the best email address for the demo follow-up? You can also say skip."
      );
    }

    caller.lastStep = "ask_address";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What is the service address?"
    );
  }

  if (caller.lastStep === "ask_demo_email") {
    if (!isSkipResponse(speech)) {
      caller.demoEmail = cleanForSpeech(speech);
    }
    caller.lastStep = "ask_notes";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Before I submit this demo request, are there any notes or details you'd like me to add?"
    );
  }

  if (caller.lastStep === "ask_address") {
    caller.address = normalizeAddressInput(speech);
    caller.lastStep = "confirm_address";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Great, let me make sure I have this right. You said ${caller.address}. Is that correct?`
    );
  }

  if (caller.lastStep === "confirm_address") {
    if (isAffirmative(speech)) {
      return proceedAfterConfirmedAddress(twiml, res, caller);
    }

    if (isNegative(speech)) {
      caller.address = "";
      caller.lastStep = "ask_address";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `I'm sorry about that. Let's try it again. ${getAddressPrompt(caller)}`
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Great, let me make sure I have this right. You said ${caller.address}. Is that correct?`
    );
  }

  if (caller.lastStep === "ask_appliance_warranty") {
    caller.applianceWarranty = parseWarrantyStatus(speech);
    caller.lastStep = "schedule_or_callback";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      applianceSchedulingPrompt()
    );
  }

  if (caller.lastStep === "ask_project_timeline") {
    caller.leadType = "quote";
    caller.status = "quote_request";
    caller.timeline = cleanForSpeech(speech);
    caller.lastStep = "ask_proposal_deadline";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Do you have a deadline for the proposal or estimate?"
    );
  }

  if (caller.lastStep === "ask_proposal_deadline") {
    caller.leadType = "quote";
    caller.status = "quote_request";

    const t = normalizedText(speech);

    if (t === "no" || t === "nope" || t === "not really" || t === "not sure" || t.includes("no deadline")) {
      caller.proposalDeadline = "";
    } else {
      caller.proposalDeadline = cleanForSpeech(speech);
    }

    caller.lastStep = "ask_notes";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      nonDemoNotesPrompt(caller)
    );
  }

  if (caller.lastStep === "schedule_or_callback") {
    const availabilityHandled = await handleAvailabilityLookup(twiml, res, caller, speech, { allowFlexibleDateRequest: true });
    if (availabilityHandled) return availabilityHandled;

    const t = normalizedText(speech);

    if (
      t.includes("schedule") ||
      t.includes("book") ||
      t.includes("set up") ||
      t.includes("appointment")
    ) {
      caller.status = "scheduling";
      caller.lastStep = "ask_appointment_day";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "What day works best for you?"
      );
    }

    if (
      t.includes("call") ||
      t.includes("callback") ||
      t.includes("call me") ||
      t.includes("someone call")
    ) {
      caller.status = "callback_requested";
      caller.calendarSlotConfirmed = false;
      caller.lastStep = "ask_notes";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Alright. Someone from the office will call you to arrange the next available time. Before I submit this, is there anything else you'd like me to note for the technician?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Would you like to choose a callback day and time now, ask what is available on a specific day, or would you prefer the first available callback?"
    );
  }

  if (caller.lastStep === "confirm_first_available") {
    const alternateAvailabilityHandled = await handleAvailabilityLookup(twiml, res, caller, speech, {
      existingDate: caller.requestedDate || caller.pendingOfferedDate || "",
      existingTimePreference: caller.requestedTimePreference || "",
      allowFlexibleDateRequest: true
    });
    if (alternateAvailabilityHandled) return alternateAvailabilityHandled;

    if (isAffirmative(speech)) {
      caller.appointmentDate = caller.pendingOfferedDate;
      caller.appointmentTime = caller.pendingOfferedTime;
      caller.status = "scheduled";
      caller.calendarSlotConfirmed = true;
      caller.lastStep = "ask_notes";
      resetPendingAvailability(caller);

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Alright. I've got your callback set for ${caller.appointmentDate} at ${caller.appointmentTime}. Before I submit this, is there anything else you'd like me to note for the technician?`
      );
    }

    if (isNegative(speech)) {
      caller.pendingOfferedDate = "";
      caller.pendingOfferedTime = "";
      caller.status = "scheduling";
      caller.calendarSlotConfirmed = false;
      caller.lastStep = "ask_appointment_day";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "No problem. What day works better for a callback?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Would that callback time work for you? You can also ask for another time."
    );
  }

  if (caller.lastStep === "ask_appointment_day") {
    const availabilityHandled = await handleAvailabilityLookup(twiml, res, caller, speech, { allowFlexibleDateRequest: true });
    if (availabilityHandled) return availabilityHandled;

    const timePreference = detectTimePreference(speech);
    const datePart = extractDatePart(speech);

    if (timePreference && !datePart) {
      caller.requestedTimePreference = convertPreferenceToMakeValue(timePreference);
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I can certainly note a time preference. What day works best for you?"
      );
    }

    if (datePart && timePreference) {
      const requestDetails = {
        rawQuery: cleanForSpeech(speech),
        requestedDate: datePart,
        requestedTimePreference: convertPreferenceToMakeValue(timePreference)
      };

      caller.requestedDate = requestDetails.requestedDate;
      caller.requestedTimePreference = requestDetails.requestedTimePreference;
      caller.pendingAvailabilityQuery = requestDetails.rawQuery;

      const availability = normalizeAvailabilityResponse(await checkCalendarAvailability(caller, requestDetails));

      if (availability && availability.date && availability.time) {
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";

        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `Let me check the calendar. I have ${spokenAvailabilityPhrase(caller.pendingOfferedDate, caller.pendingOfferedTime)} for a callback. Would that callback time work for you?`
        );
      }

      caller.appointmentDate = datePart;
      caller.appointmentTime = formatPreferenceForSpeech(timePreference);
      caller.status = "callback_requested";
      caller.calendarSlotConfirmed = false;
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Got it. I'll note that you'd prefer a ${formatPreferenceForSpeech(timePreference)} callback on ${caller.appointmentDate}, and someone from the office will confirm the exact callback time with you. Before I submit this, is there anything else you'd like me to note for the technician?`
      );
    }

    caller.appointmentDate = cleanForSpeech(speech);
    caller.lastStep = "ask_appointment_time";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What callback time works best for you?"
    );
  }

  if (caller.lastStep === "ask_appointment_time") {
    const availabilityHandled = await handleAvailabilityLookup(twiml, res, caller, speech, {
      existingDate: caller.appointmentDate,
      allowFlexibleDateRequest: true
    });
    if (availabilityHandled) return availabilityHandled;

    const timePreference = detectTimePreference(speech);

    if (timePreference && !isSpecificTime(speech)) {
      caller.appointmentTime = formatPreferenceForSpeech(timePreference);
      caller.status = "callback_requested";
      caller.calendarSlotConfirmed = false;
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Got it. I'll note that you'd prefer ${formatPreferenceForSpeech(timePreference)}, and someone from the office will confirm the exact callback time with you. Before I submit this, is there anything else you'd like me to note for the technician?`
      );
    }

    caller.appointmentTime = cleanForSpeech(speech);
    caller.status = "scheduled";
    caller.calendarSlotConfirmed = false;
    caller.lastStep = "ask_notes";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Got it. Before I submit this, is there anything else you'd like me to note for the technician?"
    );
  }

  if (caller.lastStep === "ask_notes") {
    if (caller.leadType === "quote") {
      caller.leadType = "quote";
      caller.status = "quote_request";
    }

    if (caller.leadType === "demo") {
      caller.leadType = "demo";
      caller.status = "demo_request";
    }

    if (isPricingQuestion(speech)) {
      if (caller.leadType === "quote") {
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `${pricingResponse()} ${nonDemoNotesPrompt(caller)}`
        );
      }

      if (caller.leadType === "demo") {
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `${pricingResponse()} Before I submit this demo request, are there any notes or details you'd like me to add?`
        );
      }

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `${pricingResponse()} ${nonDemoNotesPrompt(caller)}`
      );
    }

    if (!isEndCallPhrase(speech)) {
      caller.notes = cleanForSpeech(speech);
    }

    let recap = "";

    if (caller.emergencyAlert) {
      recap = `Perfect. I am marking this as an emergency for ${caller.issueSummary}, and I am submitting it for review now. Someone from our service team will contact you shortly.`;
    } else if (caller.leadType === "quote") {
      recap = `Perfect. I'm submitting your quote request for ${caller.projectType || "this project"} now, and someone from the office will contact you shortly.`;
    } else if (caller.leadType === "demo") {
      recap = "Perfect. I'm submitting your demo request now, and someone from the office will contact you shortly.";
    } else if (caller.status === "scheduled") {
      recap = `Perfect. I'm submitting your service request for ${caller.issueSummary} with your requested callback on ${caller.appointmentDate} at ${caller.appointmentTime}. Someone from the office will contact you if anything else is needed.`;
    } else if (caller.status === "callback_requested" && caller.appointmentDate && caller.appointmentTime) {
      recap = `Perfect. I'm submitting your service request for ${caller.issueSummary} with your callback preference for ${caller.appointmentDate} and ${caller.appointmentTime.toLowerCase()}. Someone from the office will reach out to confirm the exact callback time.`;
    } else {
      recap = `Perfect. I'm submitting your service call for ${caller.issueSummary} now, and someone from the office will contact you shortly to go over this and get you scheduled.`;
    }

    twiml.say({ voice: "alice" }, recap);

    sendLeadToMake(caller);
    sendBookingToMake(caller);

    caller.lastStep = "final_question";
    twiml.pause({ length: 1 });

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      postSubmitFollowupPrompt(caller)
    );
  }

  if (caller.lastStep === "final_question") {
    if (isPricingQuestion(speech)) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `${pricingResponse()} ${postSubmitFollowupPrompt(caller)}`
      );
    }

    if (caller.leadType !== "demo") {
      if (isDemoFollowupInterest(speech)) {
        caller.demoFollowupRequested = true;
        caller.lastStep = "confirm_demo_followup_info";
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          "Before I submit that, is the information you gave me during the demo the best contact information for you?"
        );
      }

      if (!isNegative(speech) && !isEndCallPhrase(speech)) {
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          "If you'd like, I can have someone from our team contact you to discuss how this could work for your company. Would you like me to do that?"
        );
      }
    }

    const goodbye = caller.emergencyAlert
      ? "Thank you for calling. Take care."
      : "Perfect. Thank you for calling, and have a great day.";

    twiml.say({ voice: "alice" }, goodbye);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_demo_followup_info") {
    if (isAffirmative(speech)) {
      caller.demoFollowupContactName = caller.fullName || "";
      caller.demoFollowupCallbackNumber = caller.callbackNumber || caller.phone || "";
      caller.demoFollowupEmail = caller.demoEmail || "";
      caller.lastStep = "ask_demo_followup_email_optional";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Perfect. If you'd like, what is the best email address for us to use regarding this demo? You can also say skip."
      );
    }

    if (isNegative(speech)) {
      caller.lastStep = "ask_demo_followup_contact_name";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "What is the best contact name for us to use regarding this demo?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Before I submit that, is the information you gave me during the demo the best contact information for you? Please say yes or no."
    );
  }

  if (caller.lastStep === "ask_demo_followup_contact_name") {
    const parsedName = parseFullNameFromSpeech(speech);

    if (!parsedName) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I didn't quite catch the contact name. What is the best contact name for us to use regarding this demo?"
      );
    }

    caller.demoFollowupContactName = parsedName;
    caller.lastStep = "ask_demo_followup_phone";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What is the best callback number for us to use regarding this demo?"
    );
  }

  if (caller.lastStep === "ask_demo_followup_phone") {
    caller.demoFollowupCallbackNumber = cleanForSpeech(speech);
    caller.lastStep = "ask_demo_followup_email_optional";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "If you'd like, what is the best email address for us to use regarding this demo? You can also say skip."
    );
  }

  if (caller.lastStep === "ask_demo_followup_email_optional") {
    if (!isSkipResponse(speech)) {
      caller.demoFollowupEmail = cleanForSpeech(speech);
    }

    sendDemoFollowupToMake(caller);

    twiml.say(
      { voice: "alice" },
      "Perfect. I'll have someone from our team reach out about the demo using that contact information. Thank you for calling, and have a great day."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.get("/twilio-token", (req, res) => {
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    if (!process.env.TWILIO_ACCOUNT_SID) {
      throw new Error("Missing TWILIO_ACCOUNT_SID");
    }
    if (!process.env.TWILIO_API_KEY_SID) {
      throw new Error("Missing TWILIO_API_KEY_SID");
    }
    if (!process.env.TWILIO_API_KEY_SECRET) {
      throw new Error("Missing TWILIO_API_KEY_SECRET");
    }
    if (!process.env.TWILIO_TWIML_APP_SID) {
      throw new Error("Missing TWILIO_TWIML_APP_SID");
    }

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity: "browser-user" }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: false
    });

    token.addGrant(voiceGrant);

    res.json({ token: token.toJwt() });
  } catch (err) {
    console.error("TOKEN ERROR:", err);
    res.status(500).send("Token error: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});
