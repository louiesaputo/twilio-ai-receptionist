/*************************************************
 BLUE CALLER AUTOMATION - VOICE SERVER
 VERSION: V74
 DATE: 2026-03-29
 NOTES:
 - Removed awkward "Hi" from intro
 - Tightened quote flow wording to remove repetition
 - Preserved current service / emergency / scheduling logic
 - Keeps quote detection
 - Keeps first-available / calendar lookup flow
*************************************************/

console.log("🔥 BLUE CALLER SERVER V74 LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V74";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const callerStore = {};

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

      notes: "",
      status: "new_lead",
      appointmentDate: "",
      appointmentTime: "",
      pendingOfferedDate: "",
      pendingOfferedTime: "",

      makeSent: false,
      lastStep: "ask_issue",
      silenceCount: 0,
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

  caller.notes = "";
  caller.status = "new_lead";
  caller.appointmentDate = "";
  caller.appointmentTime = "";
  caller.pendingOfferedDate = "";
  caller.pendingOfferedTime = "";

  caller.makeSent = false;
  caller.lastStep = "ask_issue";
  caller.silenceCount = 0;
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

function normalizeAddressInput(input) {
  if (!input) return "";

  let value = cleanForSpeech(input)
    .replace(/\bcomma\b/gi, "")
    .replace(/\bdot\b/gi, "")
    .replace(/[.,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = value.replace(
    /^(\d)\s+(\d{2,})(\b.*)$/i,
    (match, first, second, rest) => {
      if (second.startsWith(first)) return `${second}${rest}`;
      return match;
    }
  );

  value = value.replace(/^(\d{1,6})\s+\1(\b.*)$/i, "$1$2");

  return value.trim();
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
    "alex"
  ]);

  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !stopWords.has(word))
    .map((word) => word.replace(/[^a-zA-Z'-]/g, ""))
    .filter(Boolean);

  if (words.length === 0 || words.length > 4) return "";

  return toTitleCase(words.join(" "));
}

function stripIssueLeadIn(text) {
  if (!text) return "";
  return cleanForSpeech(text)
    .replace(/^(and\s+)?i\s+have\s+/i, "")
    .replace(/^(and\s+)?i've\s+got\s+/i, "")
    .replace(/^(and\s+)?i\s+need\s+/i, "")
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

function extractOpeningNameAndIssue(text) {
  const original = cleanSpeechText(text || "");
  if (!original) return { name: null, issueText: "" };

  let normalized = original
    .replace(/^(hi|hello|hey)\s*,?\s*alex\s*,?\s*/i, "")
    .replace(/^(hi|hello|hey)\s*,?\s*/i, "")
    .trim();

  const markerPatterns = [
    "this is",
    "my name is",
    "i am",
    "i'm",
    "it is",
    "it's"
  ];

  const issueSeparators = [
    " and i have ",
    " and i've got ",
    " and i need ",
    ", i have ",
    ", i've got ",
    ", i need ",
    " i have ",
    " i've got ",
    " i need ",
    " calling about ",
    " calling with ",
    " calling for ",
    " calling regarding "
  ];

  const lower = normalized.toLowerCase();

  for (const marker of markerPatterns) {
    const markerIndex = lower.indexOf(marker);
    if (markerIndex === -1) continue;

    const afterMarker = normalized.slice(markerIndex + marker.length).trim();
    const afterMarkerLower = afterMarker.toLowerCase();

    for (const separator of issueSeparators) {
      const sepIndex = afterMarkerLower.indexOf(separator);
      if (sepIndex === -1) continue;

      const possibleNameRaw = afterMarker
        .slice(0, sepIndex)
        .trim()
        .replace(/^[,.\-\s]+|[,.\-\s]+$/g, "");
      const issueRaw = afterMarker.slice(sepIndex + separator.length).trim();

      const possibleName = normalizeNameCandidate(possibleNameRaw);
      const issueText = stripIssueLeadIn(issueRaw);

      if (possibleName && issueText) {
        return { name: possibleName, issueText };
      }
    }

    const possibleNameOnly = normalizeNameCandidate(afterMarker);
    if (possibleNameOnly) {
      return { name: possibleNameOnly, issueText: "" };
    }
  }

  return { name: null, issueText: original };
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.substring(1);
  return digits.split("").join(" ");
}

function containsAny(text, phrases) {
  return phrases.some((p) => text.includes(p));
}

function normalizedText(text) {
  return cleanForSpeech(text || "").toLowerCase();
}

function isAffirmative(text) {
  const t = normalizedText(text);

  if (t.includes("not an emergency")) return false;
  if (t.includes("not emergency")) return false;
  if (t.includes("non emergency")) return false;
  if (t.includes("non-emergency")) return false;
  if (t.includes("not urgent")) return false;
  if (t.includes("non urgent")) return false;
  if (t.includes("non-urgent")) return false;

  return (
    t === "yes" ||
    t === "yeah" ||
    t === "yep" ||
    t === "correct" ||
    t === "right" ||
    t === "ok" ||
    t === "okay" ||
    t === "sure" ||
    t.includes("mark it emergency") ||
    t.includes("make it emergency") ||
    t.includes("this is an emergency") ||
    t.includes("it's an emergency") ||
    t.includes("it is an emergency") ||
    t.includes("urgent") ||
    t.includes("as soon as possible") ||
    t.includes("right away") ||
    t.includes("immediately") ||
    t.includes("that works") ||
    t.includes("that would work") ||
    t.includes("that works for me") ||
    t.includes("thatll work") ||
    t.includes("that will work")
  );
}

function isNegative(text) {
  const t = normalizedText(text);

  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("not an emergency") ||
    t.includes("not emergency") ||
    t.includes("non emergency") ||
    t.includes("non-emergency") ||
    t.includes("not urgent") ||
    t.includes("non urgent") ||
    t.includes("non-urgent") ||
    t.includes("standard") ||
    t.includes("normal") ||
    t.includes("regular") ||
    t.includes("during business hours") ||
    t.includes("normal business hours") ||
    t.includes("standard call") ||
    t.includes("not right away") ||
    t.includes("not immediately") ||
    t.includes("can wait") ||
    t.includes("whenever is fine") ||
    t.includes("no whenever is fine") ||
    t.includes("whenever works") ||
    t.includes("any time is fine") ||
    t.includes("anytime is fine") ||
    t.includes("no rush") ||
    t.includes("sometime this week") ||
    t.includes("during the week is fine") ||
    t.includes("business hours is fine") ||
    t.includes("that doesn't work") ||
    t.includes("that does not work")
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
  return containsAny(t, [
    "leak",
    "leaking",
    "drip",
    "dripping"
  ]);
}

function isQuoteIntent(text) {
  const t = normalizedText(text);

  if (containsAny(t, ["quote", "estimate", "proposal", "bid"])) {
    return true;
  }

  if (containsAny(t, ["remodel", "remodeling", "renovation", "renovating"])) {
    return true;
  }

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

function classifyProjectType(text) {
  const t = normalizedText(text);

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

  if (containsAny(t, ["quote", "estimate", "proposal", "bid"])) {
    return cleanForSpeech(text)
      .replace(/\b(i'?m|i am|we're|we are|looking to|want to|would like to|get a|need a)\b/gi, "")
      .replace(/\bquote\b/gi, "")
      .replace(/\bestimate\b/gi, "")
      .replace(/\bproposal\b/gi, "")
      .replace(/\bbid\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim() || "this project";
  }

  return cleanForSpeech(text) || "this project";
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
    t.includes("when is your next opening") ||
    t.includes("when is the soonest") ||
    t.includes("what's your first available") ||
    t.includes("whats your first available") ||
    t.includes("what is your first available") ||
    t.includes("what's the first available") ||
    t.includes("what is the first available") ||
    t.includes("how soon can someone come") ||
    t.includes("how soon can someone come out") ||
    t.includes("how soon can you come") ||
    t.includes("when can someone come out")
  );
}

function detectTimePreference(text) {
  const t = normalizedText(text);

  if (containsAny(t, ["morning", "mornings", "early morning"])) {
    return "Morning preferred";
  }

  if (containsAny(t, ["afternoon", "afternoons", "later in the day"])) {
    return "Afternoon preferred";
  }

  if (containsAny(t, ["evening", "evenings", "tonight"])) {
    return "Evening preferred";
  }

  if (containsAny(t, ["any time", "anytime", "whenever"])) {
    return "Any time preferred";
  }

  return "";
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

  value = value
    .replace(/^let'?s say\s+/i, "")
    .replace(/^how about\s+/i, "")
    .replace(/^maybe\s+/i, "")
    .replace(/^for\s+/i, "")
    .replace(/\bdo you have anything.*$/i, "")
    .replace(/\bwhat do you have.*$/i, "")
    .replace(/\banything in the .*$/i, "")
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

  value = value.replace(/[?.!,]+$/g, "").trim();
  return value;
}

function hasUsableProblemText(text) {
  if (!text) return false;

  const t = normalizedText(text);
  const wordCount = cleanForSpeech(text).split(/\s+/).filter(Boolean).length;

  if (wordCount >= 2) return true;

  if (
    isQuoteIntent(text) ||
    isHardEmergency(text) ||
    isLeakLikeIssue(text) ||
    containsAny(t, ["clog", "clogged", "drain", "faucet", "sink", "toilet", "roof", "ceiling", "water heater"])
  ) {
    return true;
  }

  return false;
}

function classifyIssue(issue) {
  const text = normalizedText(issue);

  if (
    containsAny(text, ["yard", "front yard", "back yard", "lawn", "outside"]) &&
    containsAny(text, ["leak", "water", "pooling", "drip", "dripping"])
  ) {
    return { summary: "a leak in your yard" };
  }

  if (text.includes("water main")) {
    return { summary: "a possible water main leak" };
  }

  if (text.includes("roof") && containsAny(text, ["leak", "drip", "dripping"])) {
    return { summary: "a roof leak" };
  }

  if (text.includes("ceiling") && containsAny(text, ["leak", "drip", "dripping", "pouring", "gushing"])) {
    return { summary: "a ceiling leak" };
  }

  if ((text.includes("faucet") || text.includes("sink")) && containsAny(text, ["leak", "drip", "dripping"])) {
    return { summary: "a leaking faucet" };
  }

  if (text.includes("water heater") && containsAny(text, ["leak", "drip", "dripping"])) {
    return { summary: "a leaking water heater" };
  }

  if (containsAny(text, ["clog", "clogged", "drain"])) {
    return { summary: "a clogged drain" };
  }

  if (containsAny(text, ["flood", "flooding", "flooded"])) {
    return { summary: "flooding" };
  }

  if (containsAny(text, ["burst", "burst pipe"])) {
    return { summary: "a burst pipe" };
  }

  if (containsAny(text, ["sewer", "sewage"])) {
    return { summary: "a sewer backup" };
  }

  if (containsAny(text, ["gas leak"])) {
    return { summary: "a gas leak" };
  }

  if (containsAny(text, ["no water"])) {
    return { summary: "no water service" };
  }

  if (containsAny(text, ["leak", "leaking", "drip", "dripping"])) {
    return { summary: "a water leak" };
  }

  return { summary: "your service issue" };
}

function buildMakePayload(caller) {
  return {
    leadType: caller.leadType || (caller.emergencyAlert ? "emergency" : "service"),
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    phone: caller.phone || "",
    callbackNumber: caller.callbackNumber || "",
    callbackConfirmed: caller.callbackConfirmed === true,
    address: caller.address || "",
    issue: caller.issue || "",
    issueSummary: caller.issueSummary || "",
    urgency: caller.urgency || "normal",
    emergencyAlert: caller.emergencyAlert === true,
    projectType: caller.projectType || "",
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

function sendLeadToMake(caller) {
  if (caller.makeSent) return;
  if (!shouldSendToMake(caller)) {
    console.log("⚠️ Skipping Make webhook — missing minimum required data");
    return;
  }

  try {
    const payload = buildMakePayload(caller);
    const data = JSON.stringify(payload);
    const url = new URL(MAKE_WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: `${url.pathname}${url.search || ""}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };

    const makeReq = https.request(options, (makeRes) => {
      console.log(`[MAKE] Status: ${makeRes.statusCode}`);
    });

    makeReq.on("error", (err) => {
      console.error("[MAKE ERROR]", err.message);
    });

    makeReq.write(data);
    makeReq.end();

    caller.makeSent = true;
  } catch (err) {
    console.error("[MAKE ERROR]", err.message);
  }
}

function checkCalendarAvailability(caller) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        action: "check_availability",
        phone: caller.phone,
        fullName: caller.fullName || "",
        firstName: caller.firstName || "",
        issueSummary: caller.issueSummary || "",
        address: caller.address || "",
        appointmentDate: caller.appointmentDate || "",
        appointmentTime: caller.appointmentTime || ""
      });

      const url = new URL(MAKE_WEBHOOK_URL);

      const options = {
        hostname: url.hostname,
        path: `${url.pathname}${url.search || ""}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (makeRes) => {
        let body = "";

        makeRes.on("data", (chunk) => {
          body += chunk;
        });

        makeRes.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            resolve(parsed);
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on("error", () => resolve(null));
      req.write(payload);
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

function sayThenGather(twiml, res, actionUrl, prompt) {
  twiml.say({ voice: "alice" }, prompt);
  twiml.pause({ length: 1 });

  twiml.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    speechTimeout: 1,
    timeout: 5,
    actionOnEmptyResult: true,
    language: "en-US"
  });

  return res.type("text/xml").send(twiml.toString());
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
    caller.lastStep = "ask_last_name";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      askLastNamePrompt || `Thank you, ${caller.firstName}. Can I get your last name as well?`
    );
  }

  if (caller.fullName && caller.firstName) {
    caller.lastStep = "confirm_phone";

    if (caller.emergencyAlert) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        emergencyKnownNamePrompt ||
          `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      normalKnownNamePrompt ||
        `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I'd be more than happy to help you with that. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
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

function moveToQuoteNameOrPhoneStep(twiml, res, caller, options = {}) {
  const {
    quoteKnownNamePrompt = null,
    quoteUnknownNamePrompt = null,
    quoteAskLastNamePrompt = null
  } = options;

  if (caller.firstName && caller.fullName && !hasFullName(caller.fullName)) {
    caller.lastStep = "ask_last_name";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      quoteAskLastNamePrompt || `Thank you, ${caller.firstName}. Can I get your last name as well?`
    );
  }

  if (caller.fullName && caller.firstName) {
    caller.lastStep = "confirm_phone";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      quoteKnownNamePrompt ||
        `Absolutely, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  caller.lastStep = "ask_name";
  return sayThenGather(
    twiml,
    res,
    "/handle-input",
    quoteUnknownNamePrompt ||
      "Absolutely. Can I start by getting your full name, please?"
  );
}

app.get("/", (req, res) => {
  res.send(`Server running - ${APP_VERSION}`);
});

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  resetCallerForNewCall(caller, phone);

  twiml.say(
    { voice: "alice" },
    "Thank you for calling Blue Caller Automation. This is Alex, your virtual receptionist. This is a demonstration line, so you can experience how I would answer calls for your business. You can speak to me just like one of your customers would when calling for service, an emergency, or a quote. How can I help you today?"
  );
  twiml.pause({ length: 1 });

  twiml.gather({
    input: "speech",
    action: "/handle-input",
    method: "POST",
    speechTimeout: 1,
    timeout: 5,
    actionOnEmptyResult: true,
    language: "en-US"
  });

  res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (!speech) {
    caller.silenceCount += 1;

    if (caller.silenceCount === 1) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I didn't catch that. Could you please say that again?"
      );
    }

    if (caller.silenceCount === 2) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm still not hearing anything on the line. If you need help, please go ahead and say it now."
      );
    }

    twiml.say(
      { voice: "alice" },
      "I'm sorry we weren't able to connect. Please call us back when you're ready. Thank you."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  caller.silenceCount = 0;

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
      console.log("✅ Captured opening name:", caller.fullName);
    } else {
      console.log("⚠️ No opening name captured");
    }

    if (!hasUsableProblemText(parsed.issueText)) {
      caller.lastStep = "ask_issue_again";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        caller.firstName
          ? `Nice to meet you, ${caller.firstName}. What can I help you with today?`
          : "I'm sorry, I didn't quite catch the problem. Could you briefly tell me what is going on?"
      );
    }

    caller.issue = cleanForSpeech(parsed.issueText);
    caller.issueSummary = classifyIssue(caller.issue).summary;

    if (isHardEmergency(caller.issue)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      return moveToNameOrPhoneStep(twiml, res, caller);
    }

    if (isQuoteIntent(caller.issue)) {
      caller.leadType = "quote";
      caller.projectType = classifyProjectType(caller.issue);
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
        `I'm sorry you're dealing with this ${caller.issueSummary.replace(/^a\s+/i, "").replace(/^an\s+/i, "")}. Should I mark this as an emergency for you, or is this something that can be handled during normal business hours?`
      );
    }

    caller.emergencyAlert = false;
    caller.urgency = "normal";
    caller.leadType = "service";
    return moveToNameOrPhoneStep(twiml, res, caller);
  }

  if (caller.lastStep === "ask_issue_again") {
    caller.issue = cleanForSpeech(speech);
    caller.issueSummary = classifyIssue(caller.issue).summary;

    if (isHardEmergency(caller.issue)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      return moveToNameOrPhoneStep(twiml, res, caller);
    }

    if (isQuoteIntent(caller.issue)) {
      caller.leadType = "quote";
      caller.projectType = classifyProjectType(caller.issue);
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
        `I'm sorry you're dealing with this ${caller.issueSummary.replace(/^a\s+/i, "").replace(/^an\s+/i, "")}. Should I mark this as an emergency for you, or is this something that can be handled during normal business hours?`
      );
    }

    caller.emergencyAlert = false;
    caller.urgency = "normal";
    caller.leadType = "service";
    return moveToNameOrPhoneStep(twiml, res, caller);
  }

  if (caller.lastStep === "leak_emergency_choice") {
    if (isAffirmative(speech)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      caller.leakNeedsEmergencyChoice = false;

      return moveToNameOrPhoneStep(twiml, res, caller, {
        emergencyKnownNamePrompt: `Alright, ${caller.firstName}. I've got this marked as an emergency. I just need to gather a few details so someone can reach out to you as soon as possible. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`,
        emergencyUnknownNamePrompt: `Alright. I've got this marked as an emergency. I just need to gather a few details so someone can reach out to you as soon as possible. Can I start with your full name?`,
        askLastNamePrompt: `Alright, ${caller.firstName}. I've got this marked as an emergency. Before I go any further, can I get your last name as well?`
      });
    }

    if (isNegative(speech)) {
      caller.emergencyAlert = false;
      caller.urgency = "normal";
      caller.leadType = "service";
      caller.status = "new_lead";
      caller.leakNeedsEmergencyChoice = false;

      return moveToNameOrPhoneStep(twiml, res, caller, {
        normalKnownNamePrompt: `Alright, ${caller.firstName}. I've got this as a standard service request. I just need to gather a few details so someone from the office can reach out and get this scheduled for you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`,
        normalUnknownNamePrompt: `Alright. I've got this as a standard service request. I just need to gather a few details so someone from the office can reach out and get this scheduled for you. Can I start with your full name?`,
        askLastNamePrompt: `Alright, ${caller.firstName}. I've got this as a standard service request. Before I go any further, can I get your last name as well?`
      });
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Should I mark this as an emergency for you, or is this something that can be handled during normal business hours?"
    );
  }

  if (caller.lastStep === "ask_name") {
    caller.fullName = toTitleCase(cleanName(speech));
    caller.firstName = getFirstName(caller.fullName);

    if (!hasFullName(caller.fullName)) {
      caller.lastStep = "ask_last_name";

      if (caller.leadType === "quote") {
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `Thank you, ${caller.firstName}. Can I get your last name as well?`
        );
      }

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Thank you, ${caller.firstName}. Can I get your last name as well?`
      );
    }

    caller.lastStep = "confirm_phone";

    if (caller.leadType === "quote") {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "ask_last_name") {
    const lastName = cleanName(speech);
    caller.fullName = toTitleCase(`${caller.firstName} ${lastName}`);
    caller.lastStep = "confirm_phone";

    if (caller.leadType === "quote") {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Thank you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "confirm_phone") {
    if (isNegative(speech)) {
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
    caller.lastStep = "ask_address";

    if (caller.leadType === "quote") {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "What is the project address?"
      );
    }

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
    caller.lastStep = "ask_address";

    if (caller.leadType === "quote") {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "What is the project address?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What is the service address?"
    );
  }

  if (caller.lastStep === "ask_address") {
    caller.address = normalizeAddressInput(speech);

    if (caller.leadType === "quote") {
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
        "Before I submit this, are there any notes or details you'd like me to add for the technician?"
      );
    }

    caller.lastStep = "schedule_or_callback";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Would you like to schedule a service appointment now, would you prefer someone from the office to call you to schedule it, or would you like the first available appointment?"
    );
  }

  if (caller.lastStep === "ask_project_timeline") {
    caller.timeline = cleanForSpeech(speech);
    caller.lastStep = "ask_proposal_deadline";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Do you have a timeline in mind for this project?"
    );
  }

  if (caller.lastStep === "ask_proposal_deadline") {
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
      "Before I submit this quote request, are there any notes or details you'd like me to add?"
    );
  }

  if (caller.lastStep === "schedule_or_callback") {
    const t = normalizedText(speech);

    if (isAvailabilityRequest(t)) {
      const availability = await checkCalendarAvailability(caller);

      if (availability && availability.date && availability.time) {
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";

        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `The first available appointment I have is ${caller.pendingOfferedDate} at ${caller.pendingOfferedTime}. Would you like me to schedule that for you?`
        );
      }

      caller.status = "callback_requested";
      caller.appointmentDate = "First available requested";
      caller.appointmentTime = "";
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I wasn't able to pull the calendar right now. I'll note that you'd like the first available appointment, and someone from the office will reach out to confirm the exact day and time. Before I submit this, are there any notes you'd like me to add?"
      );
    }

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
      caller.lastStep = "ask_notes";
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Perfect. Someone from the office will call you to get this scheduled. Before I submit this, are there any notes you'd like me to add?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Would you like to schedule now, would you prefer someone from the office to call you, or would you like the first available appointment?"
    );
  }

  if (caller.lastStep === "confirm_first_available") {
    if (isAffirmative(speech)) {
      caller.appointmentDate = caller.pendingOfferedDate;
      caller.appointmentTime = caller.pendingOfferedTime;
      caller.status = "scheduled";
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Perfect. I've got you down for ${caller.appointmentDate} at ${caller.appointmentTime}. Before I submit this, are there any notes or details you'd like me to add for the technician?`
      );
    }

    if (isNegative(speech)) {
      caller.pendingOfferedDate = "";
      caller.pendingOfferedTime = "";
      caller.status = "scheduling";
      caller.lastStep = "ask_appointment_day";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "No problem. What day works better for you?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Would you like me to schedule that first available appointment for you?"
    );
  }

  if (caller.lastStep === "ask_appointment_day") {
    if (isAvailabilityRequest(speech)) {
      const availability = await checkCalendarAvailability(caller);

      if (availability && availability.date && availability.time) {
        caller.pendingOfferedDate = availability.date;
        caller.pendingOfferedTime = availability.time;
        caller.lastStep = "confirm_first_available";

        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `The first available appointment I have is ${caller.pendingOfferedDate} at ${caller.pendingOfferedTime}. Would you like me to schedule that for you?`
        );
      }

      caller.status = "callback_requested";
      caller.appointmentDate = "First available requested";
      caller.appointmentTime = "";
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry, I wasn't able to pull the calendar right now. I'll note that you'd like the first available appointment, and someone from the office will reach out to confirm the exact day and time. Before I submit this, are there any notes you'd like me to add?"
      );
    }

    const timePreference = detectTimePreference(speech);
    const datePart = extractDatePart(speech);

    if (timePreference && !datePart) {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I can certainly note a time preference. What day works best for you?"
      );
    }

    if (datePart && timePreference) {
      caller.appointmentDate = datePart;
      caller.appointmentTime = timePreference;
      caller.status = "callback_requested";
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Got it. I'll note that you'd prefer ${timePreference.toLowerCase()} on ${caller.appointmentDate}, and someone from the office will confirm the exact appointment time with you. Before I submit this, are there any notes you'd like me to add?`
      );
    }

    caller.appointmentDate = cleanForSpeech(speech);
    caller.lastStep = "ask_appointment_time";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What time works best for you?"
    );
  }

  if (caller.lastStep === "ask_appointment_time") {
    const timePreference = detectTimePreference(speech);

    if (timePreference && !isSpecificTime(speech)) {
      caller.appointmentTime = timePreference;
      caller.status = "callback_requested";
      caller.lastStep = "ask_notes";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `Got it. I'll note that you'd prefer ${timePreference.toLowerCase()}, and someone from the office will confirm the exact appointment time with you. Before I submit this, are there any notes or details you'd like me to add for the technician?`
      );
    }

    caller.appointmentTime = cleanForSpeech(speech);
    caller.status = "scheduled";
    caller.lastStep = "ask_notes";
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Got it. Before I submit this, are there any notes or details you'd like me to add for the technician?"
    );
  }

  if (caller.lastStep === "ask_notes") {
    if (isPricingQuestion(speech)) {
      if (caller.leadType === "quote") {
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `${pricingResponse()} Before I submit this quote request, are there any notes or details you'd like me to add?`
        );
      }

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `${pricingResponse()} Before I submit this, are there any notes or details you'd like me to add for the technician?`
      );
    }

    if (!isEndCallPhrase(speech)) {
      caller.notes = cleanForSpeech(speech);
    }

    caller.lastStep = "final_question";

    let recap = "";

    if (caller.emergencyAlert) {
      recap = `Perfect. I am marking this as an emergency for ${caller.issueSummary}, and I am submitting it for review now. Someone from our service team will contact you shortly.`;
    } else if (caller.leadType === "quote") {
      recap = `Perfect. I'm submitting your quote request for ${caller.projectType || "this project"} now, and someone from the office will contact you shortly.`;
    } else if (caller.status === "scheduled") {
      recap = `Perfect. I'm submitting your service request for ${caller.issueSummary} with your requested appointment on ${caller.appointmentDate} at ${caller.appointmentTime}. Someone from the office will contact you if anything else is needed.`;
    } else if (caller.status === "callback_requested" && caller.appointmentDate && caller.appointmentTime) {
      recap = `Perfect. I'm submitting your service request for ${caller.issueSummary} with your preference for ${caller.appointmentDate} and ${caller.appointmentTime.toLowerCase()}. Someone from the office will reach out to confirm the exact appointment time.`;
    } else {
      recap = `Perfect. I'm submitting your service call for ${caller.issueSummary} now, and someone from the office will contact you shortly to go over this and get you scheduled.`;
    }

    twiml.say({ voice: "alice" }, recap);
    twiml.pause({ length: 1 });

    if (caller.leadType === "quote") {
      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Is there anything else you'd like me to add before I submit this quote request?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      caller.emergencyAlert
        ? "Is there anything else I can do for you today?"
        : "Is there anything else I can add before I submit this?"
    );
  }

  if (caller.lastStep === "final_question") {
    if (isPricingQuestion(speech)) {
      if (caller.leadType === "quote") {
        return sayThenGather(
          twiml,
          res,
          "/handle-input",
          `${pricingResponse()} Is there anything else you'd like me to add before I submit this quote request?`
        );
      }

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        `${pricingResponse()} ${caller.emergencyAlert ? "Is there anything else I can do for you today?" : "Is there anything else I can add before I submit this?"}`
      );
    }

    if (!isEndCallPhrase(speech)) {
      caller.notes = caller.notes
        ? `${caller.notes} ${cleanForSpeech(speech)}`
        : cleanForSpeech(speech);
    }

    sendLeadToMake(caller);

    const goodbye = caller.emergencyAlert
      ? "Thank you for calling. Take care."
      : "Perfect. Thank you for calling, and have a great day.";

    twiml.say({ voice: "alice" }, goodbye);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});