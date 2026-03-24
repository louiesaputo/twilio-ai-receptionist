console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V35-NAME-FALLBACK-FIX";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const callerStore = {};

function getOrCreateCaller(phone) {
  if (!callerStore[phone]) {
    const now = new Date().toISOString();
    callerStore[phone] = {
      phone,
      issue: null,
      issueSummary: null,
      issueCategory: null,
      name: null,
      firstName: null,
      callbackNumber: null,
      callbackConfirmed: null,
      address: null,
      urgency: null,
      emergencyAlert: false,
      appointmentDate: null,
      appointmentTime: null,
      additionalNeed: null,
      status: null,
      leadType: null,
      lastStep: null,
      retryCount: 0,
      makeSent: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  callerStore[phone].updatedAt = new Date().toISOString();
  return callerStore[phone];
}

function cleanSpeechText(input) {
  if (!input) return "";
  return input.trim().replace(/\s+/g, " ");
}

function cleanForSpeech(input) {
  if (!input) return "";
  return input.replace(/[.,!?]+$/g, "").trim();
}

function cleanName(input) {
  return cleanForSpeech(input)
    .replace(/^my name is\s+/i, "")
    .replace(/^this is\s+/i, "")
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
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
}

function normalizeNameCandidate(rawName) {
  if (!rawName) return "";

  const cleaned = cleanName(rawName);
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[^a-zA-Z'-]/g, ""))
    .filter(Boolean);

  if (words.length < 2 || words.length > 3) return "";

  const bannedWords = new Set([
    "emergency",
    "urgent",
    "leak",
    "leaking",
    "leaky",
    "flood",
    "flooding",
    "burst",
    "busted",
    "broken",
    "pipe",
    "pipes",
    "main",
    "water",
    "gas",
    "heater",
    "toilet",
    "drain",
    "kitchen",
    "bathroom",
    "front",
    "yard",
    "outside",
    "street",
    "curb",
    "lawn",
    "sink",
    "faucet",
    "call",
    "calling",
    "help",
    "hello",
    "hi",
    "hey"
  ]);

  if (words.some((word) => bannedWords.has(word.toLowerCase()))) return "";

  return toTitleCase(words.join(" "));
}

function stripIssueLeadIn(text) {
  if (!text) return "";
  return cleanForSpeech(text)
    .replace(/^(and\s+)?i\s+have\s+/i, "")
    .replace(/^(and\s+)?i've\s+got\s+/i, "")
    .replace(/^(and\s+)?i\s+need\s+/i, "")
    .replace(/^(and\s+)?i\s+am\s+calling\s+about\s+/i, "")
    .replace(/^(and\s+)?i\s+am\s+calling\s+with\s+/i, "")
    .replace(/^(and\s+)?i\s+am\s+calling\s+for\s+/i, "")
    .replace(/^(and\s+)?i\s+am\s+calling\s+regarding\s+/i, "")
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

function splitNameAndIssueRemainder(remainder) {
  const cleaned = cleanSpeechText(remainder || "");
  if (!cleaned) return { name: "", issueText: "" };

  const delimiters = [
    /\s+and\s+i\s+have\s+/i,
    /\s+i\s+have\s+/i,
    /\s+and\s+i've\s+got\s+/i,
    /\s+i've\s+got\s+/i,
    /\s+and\s+i\s+need\s+/i,
    /\s+i\s+need\s+/i,
    /\s+and\s+i\s+am\s+calling\s+about\s+/i,
    /\s+i\s+am\s+calling\s+about\s+/i,
    /\s+calling\s+about\s+/i,
    /\s+calling\s+with\s+/i,
    /\s+calling\s+for\s+/i,
    /\s+calling\s+regarding\s+/i,
    /\s+about\s+/i,
    /\s+with\s+/i,
    /\s+regarding\s+/i,
    /\s+because\s+/i,
    /\s+for\s+/i,
  ];

  for (const delimiter of delimiters) {
    const match = cleaned.match(delimiter);
    if (!match || match.index === undefined) continue;

    const namePart = cleaned.slice(0, match.index).trim();
    const issuePart = cleaned.slice(match.index + match[0].length).trim();

    if (namePart && issuePart) {
      return {
        name: namePart,
        issueText: stripIssueLeadIn(issuePart),
      };
    }
  }

  return { name: cleaned, issueText: "" };
}

function findFallbackNameInSpeech(text) {
  const cleaned = cleanSpeechText(text || "");
  if (!cleaned) return "";

  const patterns = [
    /(?:^|\b)this is\s+([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)(?=\s+and\s+i\s+have|\s+i\s+have|\s+and\s+i've\s+got|\s+i've\s+got|\s+and\s+i\s+need|\s+i\s+need|$)/i,
    /(?:^|\b)my name is\s+([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)(?=\s+and\s+i\s+have|\s+i\s+have|\s+and\s+i've\s+got|\s+i've\s+got|\s+and\s+i\s+need|\s+i\s+need|$)/i,
    /(?:^|\b)i am\s+([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)(?=\s+and\s+i\s+have|\s+i\s+have|\s+and\s+i've\s+got|\s+i've\s+got|\s+and\s+i\s+need|\s+i\s+need|$)/i,
    /(?:^|\b)i'm\s+([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)(?=\s+and\s+i\s+have|\s+i\s+have|\s+and\s+i've\s+got|\s+i've\s+got|\s+and\s+i\s+need|\s+i\s+need|$)/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;

    const normalized = normalizeNameCandidate(match[1]);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function extractOpeningNameAndIssue(text) {
  const original = cleanSpeechText(text || "");
  if (!original) {
    return { name: null, issueText: "" };
  }

  const prefixPatterns = [
    /^(?:hi|hello|hey)\s*,?\s*this is\s+(.+)$/i,
    /^this is\s+(.+)$/i,
    /^(?:hi|hello|hey)\s*,?\s*my name is\s+(.+)$/i,
    /^my name is\s+(.+)$/i,
    /^(?:hi|hello|hey)\s*,?\s*i am\s+(.+)$/i,
    /^i am\s+(.+)$/i,
    /^i'm\s+(.+)$/i,
  ];

  for (const pattern of prefixPatterns) {
    const match = original.match(pattern);
    if (!match) continue;

    const split = splitNameAndIssueRemainder(match[1]);
    const name = normalizeNameCandidate(split.name);
    const issueText = cleanForSpeech(split.issueText);

    if (name && issueText) {
      return { name, issueText };
    }

    if (name) {
      return { name, issueText: "" };
    }
  }

  const directPatterns = [
    /^([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,2})\s+calling\s+(?:about|with|for|regarding)\s+(.+)$/i,
    /^([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,2})\s*,?\s+and\s+i\s+have\s+(.+)$/i,
    /^([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,2})\s+and\s+i\s+have\s+(.+)$/i,
  ];

  for (const pattern of directPatterns) {
    const match = original.match(pattern);
    if (!match) continue;

    const name = normalizeNameCandidate(match[1]);
    const issueText = cleanForSpeech(stripIssueLeadIn(match[2]));

    if (name && issueText) {
      return { name, issueText };
    }
  }

  const fallbackName = findFallbackNameInSpeech(original);
  if (fallbackName) {
    return { name: fallbackName, issueText: cleanForSpeech(original) };
  }

  return { name: null, issueText: cleanForSpeech(original) };
}

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || "https";
  return `${proto}://${req.get("host")}`;
}

function buildSpeechGather(twiml, actionUrl, prompt, options = {}) {
  const gather = twiml.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    speechTimeout: options.speechTimeout || 3,
    timeout: options.timeout || 10,
    actionOnEmptyResult: true,
    language: "en-US",
  });

  gather.say({ voice: "alice" }, prompt);
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";

  let digits = String(phone).replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.substring(1);
  }

  if (!digits) return "unknown";

  return digits.split("").join(" ");
}

function isYes(text) {
  return /yes|yeah|yep|correct|right|sure|that is correct|that's correct/.test(
    (text || "").toLowerCase()
  );
}

function isNo(text) {
  return /no|nope|wrong|different|not correct|that's wrong|that is wrong|nothing else|that is all|that's all|all set|i am good|i'm good/.test(
    (text || "").toLowerCase()
  );
}

function isPricingQuestion(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("how much") ||
    t.includes("price") ||
    t.includes("pricing") ||
    t.includes("cost") ||
    t.includes("estimate") ||
    t.includes("quote") ||
    t.includes("what do you charge") ||
    t.includes("what will it cost") ||
    t.includes("what does it cost") ||
    t.includes("service fee") ||
    t.includes("trip charge") ||
    t.includes("diagnostic fee") ||
    t.includes("ballpark")
  );
}

function pricingResponse() {
  return "Each job is different, so pricing depends on the details of the work. One of our team members will go over pricing with you when they call to review your request.";
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function parseAppointmentResponse(text) {
  const cleaned = cleanForSpeech(text || "");
  const lower = cleaned.toLowerCase();

  if (!cleaned) {
    return {
      date: "",
      time: "",
    };
  }

  const noPreferencePhrases = [
    "no preference",
    "any time",
    "anytime",
    "whenever",
    "doesn't matter",
    "does not matter",
    "first available",
    "soon as possible",
    "as soon as possible",
    "earliest available",
    "whatever works",
  ];

  if (containsAny(lower, noPreferencePhrases)) {
    return {
      date: "No preference",
      time: "First available",
    };
  }

  return {
    date: cleaned,
    time: cleaned,
  };
}

function classifyIssue(issue) {
  const text = (issue || "").toLowerCase().trim();

  if (!text) {
    return {
      category: "generic",
      summary: "the issue you described",
      urgency: "non-emergency",
    };
  }

  const hasLeak = containsAny(text, ["leak", "leaking", "leaky", "busted", "burst", "broke", "broken"]);
  const hasFlood = containsAny(text, ["flood", "flooding", "pooling water", "water everywhere"]);
  const hasNoWater = containsAny(text, ["no water", "lost water", "water is off", "no running water"]);
  const hasUrgentWords = containsAny(text, ["emergency", "urgent", "asap", "immediately", "right away"]);
  const hasMainHint = containsAny(text, ["water main", "main line", "main water line", "service line", "water line break", "main pipe", "main valve", "my main", "the main", "in my main"]);

  if (containsAny(text, ["gas leak", "smell gas", "gas odor", "gas smell", "hissing gas", "gas line"])) {
    return {
      category: "gas_leak",
      summary: "a possible gas leak",
      urgency: "emergency",
    };
  }

  if (
    hasMainHint ||
    (
      containsAny(text, ["front yard", "yard", "lawn", "outside", "out front", "by the street", "near the curb", "in the grass"]) &&
      (hasLeak || hasFlood || hasNoWater)
    )
  ) {
    return {
      category: "water_main",
      summary: "a possible water main leak in your front yard",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["burst pipe", "pipe burst", "broken pipe", "frozen pipe", "pipe busted"]) || (hasLeak && hasFlood && containsAny(text, ["pipe", "ceiling", "wall"]))) {
    return {
      category: "burst_pipe",
      summary: "a burst or broken pipe",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["sewer backup", "backing up", "sewage backup", "raw sewage", "sewer line", "main drain backup"])) {
    return {
      category: "sewer_backup",
      summary: "a sewer backup",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["toilet overflow", "overflowing toilet"])) {
    return {
      category: "toilet_overflow",
      summary: "an overflowing toilet",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["slab leak", "foundation leak", "hot spot on floor", "wet slab"])) {
    return {
      category: "slab_leak",
      summary: "a possible slab leak",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["water heater"]) && containsAny(text, ["leak", "leaking"])) {
    return {
      category: "water_heater_leak",
      summary: "a leak in your water heater",
      urgency: hasFlood || hasUrgentWords ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["water heater"]) && containsAny(text, ["no hot water", "not getting hot water", "cold water only"])) {
    return {
      category: "water_heater_no_hot_water",
      summary: "a water heater issue with no hot water",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["water heater"]) && containsAny(text, ["pilot", "won't light", "not turning on"])) {
    return {
      category: "water_heater_not_working",
      summary: "a water heater that is not working",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["kitchen faucet"]) && hasLeak) {
    return {
      category: "kitchen_faucet_leak",
      summary: "a leak in your kitchen faucet",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["bathroom faucet"]) && hasLeak) {
    return {
      category: "bathroom_faucet_leak",
      summary: "a leak in your bathroom faucet",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["faucet", "tap", "spigot"]) && hasLeak) {
    return {
      category: "faucet_leak",
      summary: "a leak in your faucet",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["under the sink", "under my sink", "under sink", "cabinet"]) && hasLeak) {
    return {
      category: "under_sink_leak",
      summary: "a leak under your sink",
      urgency: hasFlood ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["dishwasher"]) && hasLeak) {
    return {
      category: "dishwasher_leak",
      summary: "a leaking dishwasher",
      urgency: hasFlood ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["washing machine", "washer", "laundry room"]) && hasLeak) {
    return {
      category: "washer_leak",
      summary: "a leaking washing machine",
      urgency: hasFlood ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["refrigerator", "fridge", "ice maker", "icemaker"]) && hasLeak) {
    return {
      category: "fridge_line_leak",
      summary: "a leak from your refrigerator water line",
      urgency: hasFlood ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["garbage disposal", "disposal"]) && hasLeak) {
    return {
      category: "garbage_disposal_leak",
      summary: "a leaking garbage disposal",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["garbage disposal", "disposal"]) && containsAny(text, ["jam", "stuck", "not working", "humming"])) {
    return {
      category: "garbage_disposal_jam",
      summary: "a garbage disposal that is jammed or not working",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["toilet"]) && containsAny(text, ["clog", "clogged"])) {
    return {
      category: "toilet_clog",
      summary: "a clogged toilet",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["toilet"]) && containsAny(text, ["running"])) {
    return {
      category: "toilet_running",
      summary: "a toilet that is running constantly",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["toilet"]) && hasLeak) {
    return {
      category: "toilet_leak",
      summary: "a leak in or around your toilet",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["drain", "sink drain", "shower drain", "tub drain", "floor drain"]) && containsAny(text, ["clog", "clogged", "slow", "backed up"])) {
    return {
      category: "drain_clog",
      summary: "a clogged or backed-up drain",
      urgency: containsAny(text, ["backed up", "overflow", "overflowing"]) ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["sewer smell", "smell sewage", "drain smell"])) {
    return {
      category: "drain_odor",
      summary: "a sewer or drain odor issue",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["hose bib", "hose bibb", "spigot", "outside faucet", "outdoor faucet"]) && hasLeak) {
    return {
      category: "outdoor_spigot_leak",
      summary: "a leak in your outdoor faucet or spigot",
      urgency: "non-emergency",
    };
  }

  if (containsAny(text, ["low water pressure", "weak pressure", "pressure is low"])) {
    return {
      category: "low_pressure",
      summary: "a low water pressure issue",
      urgency: "non-emergency",
    };
  }

  if (hasNoWater) {
    return {
      category: "no_water",
      summary: "a loss of water service",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["flood", "flooding", "water everywhere", "pooling water", "kitchen is flooding"])) {
    return {
      category: "flooding",
      summary: "flooding or pooling water",
      urgency: "emergency",
    };
  }

  if (containsAny(text, ["boiler"]) && containsAny(text, ["no heat", "not working", "leak"])) {
    return {
      category: "boiler_issue",
      summary: "a boiler issue",
      urgency: containsAny(text, ["no heat", "leak"]) ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["heat"]) && containsAny(text, ["not working", "no heat"])) {
    return {
      category: "heating_issue",
      summary: "a heating system that is not working",
      urgency: "emergency",
    };
  }

  if ((hasLeak || hasFlood || hasUrgentWords) && containsAny(text, ["pipe"])) {
    return {
      category: "pipe_leak",
      summary: "a leaking pipe",
      urgency: hasFlood || hasUrgentWords ? "emergency" : "non-emergency",
    };
  }

  if (hasLeak) {
    return {
      category: "generic_leak",
      summary: "a leak",
      urgency: hasFlood || hasUrgentWords ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["not working", "broken"])) {
    return {
      category: "generic_not_working",
      summary: "something that is not working properly",
      urgency: "non-emergency",
    };
  }

  return {
    category: "generic",
    summary: "the issue you described",
    urgency: hasUrgentWords ? "emergency" : "non-emergency",
  };
}

function sendLeadToMake(caller) {
  if (caller.makeSent) {
    console.log("[MAKE] Skipped duplicate send");
    return;
  }

  try {
    const data = JSON.stringify({
      timestamp: new Date().toISOString(),
      leadType: caller.leadType || (caller.emergencyAlert ? "emergency_service" : "standard_service"),
      phone: caller.phone || "",
      fullName: caller.name || "",
      firstName: caller.firstName || "",
      callbackNumber: caller.callbackNumber || "",
      callbackConfirmed: caller.callbackConfirmed ?? "",
      address: caller.address || "",
      issue: caller.issue || "",
      issueSummary: caller.issueSummary || "",
      issueCategory: caller.issueCategory || "",
      urgency: caller.urgency || "",
      emergencyAlert: caller.emergencyAlert === true,
      appointmentDate: caller.appointmentDate || "",
      appointmentTime: caller.appointmentTime || "",
      additionalNeed: caller.additionalNeed || "",
      status: caller.status || "",
    });

    const url = new URL(MAKE_WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: `${url.pathname}${url.search || ""}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
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
    console.log("[MAKE] Lead sent");
  } catch (err) {
    console.error("[MAKE ERROR]", err.message);
  }
}

function getRepromptForCurrentStep(caller) {
  if (caller.lastStep === "confirm_issue") {
    if (caller.urgency === "emergency") {
      return `I understand this is an emergency regarding ${caller.issueSummary || "your issue"}, and I'm marking this as urgent.`;
    }
    return `Just so I have this right, you're calling about ${caller.issueSummary || "the issue you described"}, correct?`;
  }

  if (caller.lastStep === "ask_name") {
    return "Can I have your full name?";
  }

  if (caller.lastStep === "confirm_callback") {
    const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);
    return `I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`;
  }

  if (caller.lastStep === "ask_callback") {
    return "What is the best callback number to reach you?";
  }

  if (caller.lastStep === "ask_address") {
    return "What is the address for the job?";
  }

  if (caller.lastStep === "ask_appt") {
    return "Do you have a preferred day or time for the appointment?";
  }

  if (caller.lastStep === "anything_else") {
    return "Is there anything else you'd like us to know before I finish this up?";
  }

  if (caller.lastStep === "capture_additional_need") {
    return "Please tell me anything else you'd like us to know about the job.";
  }

  return "Please continue.";
}

function closeCall(twiml, caller) {
  sendLeadToMake(caller);

  twiml.say(
    { voice: "alice" },
    `Thank you ${caller.firstName || ""}. This call has been marked ${
      caller.urgency === "emergency" ? "urgent" : "for normal service"
    }. Someone will call you shortly. Have a great day.`
  );

  twiml.hangup();
}

app.get("/", (req, res) => {
  res.send(`Server is running - ${APP_VERSION}`);
});

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  caller.issue = null;
  caller.issueSummary = null;
  caller.issueCategory = null;
  caller.name = null;
  caller.firstName = null;
  caller.callbackNumber = phone;
  caller.callbackConfirmed = null;
  caller.address = null;
  caller.urgency = null;
  caller.emergencyAlert = false;
  caller.appointmentDate = null;
  caller.appointmentTime = null;
  caller.additionalNeed = null;
  caller.status = "in_progress";
  caller.leadType = null;
  caller.lastStep = "ask_issue";
  caller.retryCount = 0;
  caller.makeSent = false;

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    "Thank you for calling Blue Caller Automation. This is Alex, how can I help you?"
  );

  return res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (!speech) {
    caller.retryCount++;

    if (caller.retryCount <= 1) {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Sorry, I missed that. Please say that again."
      );
    } else {
      twiml.say({ voice: "alice" }, "I am sorry, I still could not hear you. Please call back.");
      twiml.hangup();
    }

    return res.type("text/xml").send(twiml.toString());
  }

  caller.retryCount = 0;

  if (isPricingQuestion(speech)) {
    twiml.say({ voice: "alice" }, pricingResponse());

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getRepromptForCurrentStep(caller)
    );

    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_issue") {
    const parsedOpening = extractOpeningNameAndIssue(speech);

    if (parsedOpening.name) {
      caller.name = parsedOpening.name;
      caller.firstName = getFirstName(parsedOpening.name);
    }

    caller.issue = cleanForSpeech(parsedOpening.issueText || speech);

    const classification = classifyIssue(caller.issue);
    caller.issueSummary = classification.summary;
    caller.issueCategory = classification.category;
    caller.urgency = classification.urgency;
    caller.emergencyAlert = caller.urgency === "emergency";

    if (caller.urgency === "emergency") {
      if (caller.name) {
        caller.lastStep = "confirm_callback";
        const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);

        buildSpeechGather(
          twiml,
          `${baseUrl}/handle-input`,
          `I understand this is an emergency regarding ${caller.issueSummary || "your issue"}, and I'm marking this as urgent. Thank you ${caller.firstName}. I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      caller.lastStep = "ask_name";
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `I understand this is an emergency regarding ${caller.issueSummary || "your issue"}, and I'm marking this as urgent. Can I have your full name?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "confirm_issue";
    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just so I have this right, you're calling about ${caller.issueSummary || "the issue you described"}, correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_issue") {
    if (isYes(speech)) {
      if (caller.name) {
        caller.lastStep = "confirm_callback";
        const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);

        buildSpeechGather(
          twiml,
          `${baseUrl}/handle-input`,
          `Thank you ${caller.firstName}. I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      caller.lastStep = "ask_name";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Can I have your full name?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.lastStep = "ask_issue";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Okay. Please tell me briefly what is going on."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Sorry, I missed that. Just so I have this right, you're calling about ${caller.issueSummary || "the issue you described"}, correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_name") {
    const cleanedName = cleanName(speech);

    if (!cleanedName) {
      caller.retryCount++;

      if (caller.retryCount <= 1) {
        buildSpeechGather(
          twiml,
          `${baseUrl}/handle-input`,
          "Sorry, I missed that. Can I have your full name?"
        );
      } else {
        twiml.say({ voice: "alice" }, "I am sorry, I still could not get your name. Please call back.");
        twiml.hangup();
      }

      return res.type("text/xml").send(twiml.toString());
    }

    caller.name = toTitleCase(cleanedName);
    caller.firstName = getFirstName(caller.name);
    caller.lastStep = "confirm_callback";

    const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_callback") {
    if (isYes(speech)) {
      caller.callbackConfirmed = true;
      caller.lastStep = "ask_address";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "What is the address for the job?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.callbackConfirmed = false;
      caller.lastStep = "ask_callback";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "What is the best callback number to reach you?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Sorry, I missed that. I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_callback") {
    caller.callbackNumber = cleanForSpeech(speech);
    caller.lastStep = "ask_address";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "What is the address for the job?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_address") {
    caller.address = cleanForSpeech(speech);

    if (caller.urgency === "emergency") {
      caller.status = "new_emergency";
      caller.leadType = "emergency_service";

      sendLeadToMake(caller);

      caller.lastStep = "anything_else";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Is there anything else you'd like us to know before I finish this up?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "ask_appt";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Do you have a preferred day or time for the appointment?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_appt") {
    const appt = parseAppointmentResponse(speech);
    caller.appointmentDate = appt.date;
    caller.appointmentTime = appt.time;
    caller.status = "new_lead";
    caller.leadType = "standard_service";
    caller.lastStep = "anything_else";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Is there anything else you'd like us to know before I finish this up?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "anything_else") {
    if (isNo(speech)) {
      closeCall(twiml, caller);
      return res.type("text/xml").send(twiml.toString());
    }

    if (isYes(speech)) {
      caller.lastStep = "capture_additional_need";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Please tell me anything else you'd like us to know about the job."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "capture_additional_need";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Please tell me anything else you'd like us to know about the job."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "capture_additional_need") {
    caller.additionalNeed = cleanForSpeech(speech);

    if (caller.additionalNeed) {
      caller.issue = `${caller.issue}. Additional request: ${caller.additionalNeed}`;
    }

    closeCall(twiml, caller);
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});
