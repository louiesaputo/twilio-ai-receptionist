console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V42-CONFIRMATIONS-FIRST-AVAILABLE";
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
      addressConfirmed: null,
      urgency: null,
      emergencyAlert: false,
      appointmentDate: null,
      appointmentTime: null,
      proposedAppointmentDate: null,
      proposedAppointmentTime: null,
      additionalNeed: null,
      status: null,
      leadType: null,
      lastStep: null,
      retryCount: 0,
      makeSent: false,
      demoRequested: false,
      demoName: null,
      demoPhone: null,
      demoEmail: null,
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
  return input.replace(/[!?]+$/g, "").trim();
}

function cleanName(input) {
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
    .map((word) => {
      if (word.includes("@")) return word.toLowerCase();
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
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

  if (words.length < 2 || words.length > 4) return "";

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
    "demo",
    "schedule"
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
  if (!original) {
    return { name: null, issueText: "" };
  }

  const patterns = [
    /^(?:hi|hello|hey)\s*,?\s*this is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^this is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^(?:hi|hello|hey)\s*,?\s*it(?:'s| is)\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^it(?:'s| is)\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^(?:hi|hello|hey)\s*,?\s*my name is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^my name is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^(?:hi|hello|hey)\s*,?\s*i am\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^i am\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^i'm\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})[\s,.-]+(.+)$/i,
    /^([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})\s+calling\s+(?:about|with|for|regarding)\s+(.+)$/i,
    /^([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})\s*,?\s+and\s+i\s+have\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = original.match(pattern);
    if (!match) continue;

    const name = normalizeNameCandidate(match[1]);
    const issueText = stripIssueLeadIn(match[2]);

    if (name && issueText) {
      return { name, issueText };
    }
  }

  const nameOnlyPatterns = [
    /^(?:hi|hello|hey)\s*,?\s*this is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^this is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^(?:hi|hello|hey)\s*,?\s*it(?:'s| is)\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^it(?:'s| is)\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^(?:hi|hello|hey)\s*,?\s*my name is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^my name is\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^(?:hi|hello|hey)\s*,?\s*i am\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^i am\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
    /^i'm\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){1,3})$/i,
  ];

  for (const pattern of nameOnlyPatterns) {
    const match = original.match(pattern);
    if (!match) continue;

    const name = normalizeNameCandidate(match[1]);
    if (name) {
      return { name, issueText: "" };
    }
  }

  return { name: null, issueText: original };
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

  if (digits.length === 10) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }

  return digits.split("").join(" ");
}

function formatEmailForSpeech(email) {
  if (!email) return "unknown";

  return email
    .replace(/@/g, " at ")
    .replace(/\./g, " dot ")
    .replace(/_/g, " underscore ")
    .replace(/-/g, " dash ")
    .replace(/\s+/g, " ")
    .trim();
}

function isYes(text) {
  return /yes|yeah|yep|correct|right|sure|that is correct|that's correct|sounds good|works for me|that works|please do|go ahead/.test(
    (text || "").toLowerCase()
  );
}

function isNo(text) {
  return /no|nope|wrong|different|not correct|that's wrong|that is wrong|nothing else|that is all|that's all|all set|i am good|i'm good|that should be it|thats it|that's it|that is it/.test(
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
  return "Each job is a little different, so pricing depends on the situation. One of our team members will go over pricing with you when they call to confirm your appointment.";
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function isDemoRequest(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("book a demo") ||
    t.includes("schedule a demo") ||
    t.includes("want a demo") ||
    t.includes("request a demo") ||
    t.includes("learn more about this system") ||
    t.includes("learn more about your receptionist") ||
    t.includes("follow-up call") ||
    t.includes("book a follow up") ||
    t.includes("book a follow-up")
  );
}

function parseAppointmentResponse(text) {
  const cleaned = cleanForSpeech(text || "");
  const lower = cleaned.toLowerCase();

  if (!cleaned) {
    return {
      date: "",
      time: "",
      firstAvailableRequested: false,
      noPreference: false,
    };
  }

  const firstAvailablePhrases = [
    "first available",
    "earliest available",
    "soonest available",
    "what is your first available",
    "what's your first available",
    "when is your first available",
    "when's your first available",
  ];

  if (containsAny(lower, firstAvailablePhrases)) {
    return {
      date: "",
      time: "",
      firstAvailableRequested: true,
      noPreference: false,
    };
  }

  const noPreferencePhrases = [
    "no preference",
    "any time",
    "anytime",
    "whenever",
    "doesn't matter",
    "does not matter",
    "whatever works",
  ];

  if (containsAny(lower, noPreferencePhrases)) {
    return {
      date: "No preference",
      time: "First available",
      firstAvailableRequested: false,
      noPreference: true,
    };
  }

  return {
    date: cleaned,
    time: cleaned,
    firstAvailableRequested: false,
    noPreference: false,
  };
}

function getNextAvailableSlot() {
  const now = new Date();
  const slot = new Date(now);
  slot.setDate(slot.getDate() + 1);
  slot.setHours(10, 0, 0, 0);

  const weekday = slot.toLocaleDateString("en-US", { weekday: "long" });
  const month = slot.toLocaleDateString("en-US", { month: "long" });
  const day = slot.getDate();
  const year = slot.getFullYear();
  const time = slot.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    date: `${weekday} ${month} ${day}, ${year}`,
    time,
    spoken: `${weekday} at ${time}`,
  };
}

function cleanEmail(input) {
  if (!input) return "";

  let cleaned = String(input).toLowerCase().trim();

  cleaned = cleaned
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+dash\s+/g, "-")
    .replace(/\s+hyphen\s+/g, "-")
    .replace(/\s+/g, "")
    .replace(/,+/g, "")
    .replace(/;+?/g, "")
    .replace(/:+/g, "");

  cleaned = cleaned.replace(/@+/g, "@");

  return cleaned;
}

function classifyIssue(issue) {
  const text = (issue || "").toLowerCase().trim();

  if (!text) {
    return {
      category: "generic",
      summary: "",
      urgency: "non-emergency",
    };
  }

  const hasLeak = containsAny(text, ["leak", "leaking", "leaky", "busted", "burst", "broke", "broken"]);
  const hasFlood = containsAny(text, ["flood", "flooding", "pooling water", "water everywhere"]);
  const hasNoWater = containsAny(text, ["no water", "lost water", "water is off", "no running water"]);
  const hasUrgentWords = containsAny(text, ["emergency", "urgent", "asap", "immediately", "right away"]);

  if (containsAny(text, ["gas leak", "smell gas", "gas odor", "gas smell", "hissing gas", "gas line"])) {
    return {
      category: "gas_leak",
      summary: "a possible gas leak",
      urgency: "emergency",
    };
  }

  if (
    (containsAny(text, ["front yard", "yard", "lawn", "outside", "out front", "by the street", "near the curb", "in the grass"]) && (hasLeak || hasFlood || hasNoWater)) ||
    containsAny(text, ["water main", "main line", "main water line", "service line", "water line break", "main pipe", "main valve"])
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
      summary: "",
      urgency: hasFlood || hasUrgentWords ? "emergency" : "non-emergency",
    };
  }

  if (containsAny(text, ["not working", "broken"])) {
    return {
      category: "generic_not_working",
      summary: "",
      urgency: "non-emergency",
    };
  }

  return {
    category: "generic",
    summary: "",
    urgency: hasUrgentWords ? "emergency" : "non-emergency",
  };
}

function buildNaturalIssueSummary(issue, classification) {
  if (classification.summary) return classification.summary;

  const cleaned = cleanForSpeech(issue || "").trim();
  if (!cleaned) return "the issue you described";

  let summary = cleaned
    .replace(/^hi[, ]*/i, "")
    .replace(/^hello[, ]*/i, "")
    .replace(/^hey[, ]*/i, "")
    .replace(/^this is\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){0,3}\s+and\s+/i, "")
    .replace(/^my name is\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){0,3}\s+and\s+/i, "")
    .replace(/^i have\s+/i, "")
    .replace(/^there is\s+/i, "")
    .replace(/^there's\s+/i, "")
    .trim();

  if (!summary) return "the issue you described";

  if (!/^a\s|^an\s|^the\s|^my\s|^our\s/i.test(summary)) {
    summary = `a ${summary}`;
  }

  return summary;
}

function sendLeadToMake(caller) {
  if (caller.makeSent) {
    console.log("[MAKE] Skipped duplicate send");
    return;
  }

  try {
    const data = JSON.stringify({
      timestamp: new Date().toISOString(),
      leadType: caller.leadType || (caller.demoRequested ? "demo_request" : caller.emergencyAlert ? "emergency_service" : "standard_service"),
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
      demoRequested: caller.demoRequested === true,
      demoName: caller.demoName || "",
      demoPhone: caller.demoPhone || "",
      demoEmail: caller.demoEmail || "",
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
      return `I have this marked as urgent for ${caller.issueSummary || "your issue"}. Is that correct?`;
    }
    return `Just to confirm, you are calling about ${caller.issueSummary || "the issue you described"}. Is that correct?`;
  }

  if (caller.lastStep === "ask_name") {
    return "May I have your full name?";
  }

  if (caller.lastStep === "confirm_name") {
    return `Just to confirm, I have ${caller.name || "your name"}. Is that correct?`;
  }

  if (caller.lastStep === "confirm_callback") {
    return `Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} the best number to reach you?`;
  }

  if (caller.lastStep === "ask_callback") {
    return "What is the best number to reach you?";
  }

  if (caller.lastStep === "ask_address") {
    return "What is the address for the job?";
  }

  if (caller.lastStep === "confirm_address") {
    return `Let me repeat that address to make sure I have it right: ${caller.address || "the address you gave me"}. Is that correct?`;
  }

  if (caller.lastStep === "ask_appt") {
    return "What day or time would you prefer for the appointment?";
  }

  if (caller.lastStep === "confirm_first_available_appt") {
    return `Our first available appointment is ${caller.proposedAppointmentDate} at ${caller.proposedAppointmentTime}. Would you like me to schedule that for you?`;
  }

  if (caller.lastStep === "anything_else") {
    return "Is there anything else I can help you with today?";
  }

  if (caller.lastStep === "capture_additional_need") {
    return "Please tell me what else you would like to add.";
  }

  if (caller.lastStep === "ask_demo_name") {
    return "Absolutely. May I have your full name?";
  }

  if (caller.lastStep === "confirm_demo_name") {
    return `Just to confirm, I have ${caller.demoName || "your name"}. Is that correct?`;
  }

  if (caller.lastStep === "confirm_demo_phone") {
    return `Is ${formatPhoneNumberForSpeech(caller.demoPhone)} the best number to reach you?`;
  }

  if (caller.lastStep === "ask_demo_phone") {
    return "What is the best number to reach you for the demo?";
  }

  if (caller.lastStep === "ask_demo_email") {
    return "What is the best email address for the demo?";
  }

  if (caller.lastStep === "confirm_demo_email") {
    return `Just to confirm, I have ${formatEmailForSpeech(caller.demoEmail)}. Is that correct?`;
  }

  return "Please continue.";
}

function closeCall(twiml, caller) {
  sendLeadToMake(caller);

  twiml.say(
    { voice: "alice" },
    `Thank you${caller.firstName ? ` ${caller.firstName}` : ""}. ${
      caller.demoRequested
        ? "We will follow up with you soon about the demo."
        : caller.urgency === "emergency"
          ? "Your request has been marked urgent, and someone will contact you shortly."
          : "Your request has been received, and someone will contact you shortly."
    } Have a great day.`
  );

  twiml.hangup();
}

function startDemoFlow(twiml, baseUrl, caller) {
  caller.demoRequested = true;
  caller.leadType = "demo_request";
  caller.status = "in_progress";
  caller.lastStep = "ask_demo_name";

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    "Absolutely. I can help with that. May I have your full name?"
  );
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
  caller.addressConfirmed = null;
  caller.urgency = null;
  caller.emergencyAlert = false;
  caller.appointmentDate = null;
  caller.appointmentTime = null;
  caller.proposedAppointmentDate = null;
  caller.proposedAppointmentTime = null;
  caller.additionalNeed = null;
  caller.status = "in_progress";
  caller.leadType = null;
  caller.lastStep = "ask_issue";
  caller.retryCount = 0;
  caller.makeSent = false;
  caller.demoRequested = false;
  caller.demoName = null;
  caller.demoPhone = null;
  caller.demoEmail = null;

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    "Thank you for calling Blue Caller Automation. This is Alex, our automated receptionist demo for home service companies. Please speak to me just like one of your own customers would if they were calling to book a service call or ask for a quote on a new job. You can also ask to book a demo at any time. Let's begin the demo. How can I help you today?"
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
      twiml.say({ voice: "alice" }, "I'm sorry, I still could not hear you. Please call back.");
      twiml.hangup();
    }

    return res.type("text/xml").send(twiml.toString());
  }

  caller.retryCount = 0;

  if (!caller.demoRequested && isDemoRequest(speech)) {
    startDemoFlow(twiml, baseUrl, caller);
    return res.type("text/xml").send(twiml.toString());
  }

  if (isPricingQuestion(speech) && !caller.demoRequested) {
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
    caller.issueSummary = buildNaturalIssueSummary(caller.issue, classification);
    caller.issueCategory = classification.category;
    caller.urgency = classification.urgency;
    caller.emergencyAlert = caller.urgency === "emergency";
    caller.lastStep = "confirm_issue";

    if (caller.urgency === "emergency") {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `I understand this sounds urgent, and I am marking it that way. Just to confirm, you are calling about ${caller.issueSummary}. Is that correct?`
      );
    } else {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Just to confirm, you are calling about ${caller.issueSummary}. Is that correct?`
      );
    }

    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_issue") {
    if (isYes(speech)) {
      if (caller.name) {
        caller.lastStep = "confirm_name";

        buildSpeechGather(
          twiml,
          `${baseUrl}/handle-input`,
          `Just to confirm, I have ${caller.name}. Is that correct?`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      caller.lastStep = "ask_name";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "May I have your full name?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.lastStep = "ask_issue";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Okay. Please tell me a little more about what is going on."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getRepromptForCurrentStep(caller)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_name") {
    const cleanedName = cleanName(speech);

    if (!cleanedName) {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Sorry, I missed that. May I have your full name?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.name = toTitleCase(cleanedName);
    caller.firstName = getFirstName(caller.name);
    caller.lastStep = "confirm_name";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, I have ${caller.name}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_name") {
    if (isYes(speech)) {
      caller.lastStep = "confirm_callback";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} the best number to reach you?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.name = null;
      caller.firstName = null;
      caller.lastStep = "ask_name";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "I'm sorry about that. May I have your full name again?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, I have ${caller.name || "your name"}. Is that correct?`
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
        "Okay. What is the best number to reach you?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} the best number to reach you?`
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
    caller.lastStep = "confirm_address";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Let me repeat that address to make sure I have it right: ${caller.address}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_address") {
    if (isYes(speech)) {
      caller.addressConfirmed = true;

      if (caller.urgency === "emergency") {
        caller.status = "new_emergency";
        caller.leadType = "emergency_service";

        sendLeadToMake(caller);

        caller.lastStep = "anything_else";

        buildSpeechGather(
          twiml,
          `${baseUrl}/handle-input`,
          "Your request has been marked urgent. Is there anything else I can help you with today?"
        );
        return res.type("text/xml").send(twiml.toString());
      }

      caller.lastStep = "ask_appt";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "What day or time would you prefer for the appointment?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.address = null;
      caller.addressConfirmed = false;
      caller.lastStep = "ask_address";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "I'm sorry about that. What is the correct address for the job?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Let me repeat that address to make sure I have it right: ${caller.address || "the address you gave me"}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_appt") {
    const appt = parseAppointmentResponse(speech);

    if (appt.firstAvailableRequested) {
      const nextSlot = getNextAvailableSlot();
      caller.proposedAppointmentDate = nextSlot.date;
      caller.proposedAppointmentTime = nextSlot.time;
      caller.lastStep = "confirm_first_available_appt";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Our first available appointment is ${nextSlot.date} at ${nextSlot.time}. Would you like me to schedule that for you?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.appointmentDate = appt.date;
    caller.appointmentTime = appt.time;
    caller.status = "new_lead";
    caller.leadType = "standard_service";
    caller.lastStep = "anything_else";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Perfect. Is there anything else I can help you with today?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_first_available_appt") {
    if (isYes(speech)) {
      caller.appointmentDate = caller.proposedAppointmentDate;
      caller.appointmentTime = caller.proposedAppointmentTime;
      caller.status = "new_lead";
      caller.leadType = "standard_service";
      caller.lastStep = "anything_else";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Great. I have you scheduled for ${caller.appointmentDate} at ${caller.appointmentTime}. Is there anything else I can help you with today?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.proposedAppointmentDate = null;
      caller.proposedAppointmentTime = null;
      caller.lastStep = "ask_appt";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "No problem. What day or time would you prefer instead?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Our first available appointment is ${caller.proposedAppointmentDate} at ${caller.proposedAppointmentTime}. Would you like me to schedule that for you?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "anything_else") {
    if (isNo(speech)) {
      if (!caller.makeSent) {
        if (!caller.leadType) {
          caller.leadType = caller.emergencyAlert ? "emergency_service" : "standard_service";
        }
        if (!caller.status) {
          caller.status = caller.emergencyAlert ? "new_emergency" : "new_lead";
        }
      }

      if (!caller.demoRequested && !caller.makeSent) {
        sendLeadToMake(caller);
      }

      closeCall(twiml, caller);
      return res.type("text/xml").send(twiml.toString());
    }

    if (isYes(speech)) {
      caller.lastStep = "capture_additional_need";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Okay. Please tell me what else you would like to add."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "capture_additional_need";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Okay. Please tell me what else you would like to add."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "capture_additional_need") {
    caller.additionalNeed = cleanForSpeech(speech);

    if (caller.additionalNeed) {
      caller.issue = caller.issue
        ? `${caller.issue}. Additional request: ${caller.additionalNeed}`
        : `Additional request: ${caller.additionalNeed}`;
    }

    if (!caller.demoRequested && !caller.makeSent) {
      if (!caller.leadType) {
        caller.leadType = caller.emergencyAlert ? "emergency_service" : "standard_service";
      }
      if (!caller.status) {
        caller.status = caller.emergencyAlert ? "new_emergency" : "new_lead";
      }
      sendLeadToMake(caller);
    }

    closeCall(twiml, caller);
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_demo_name") {
    caller.demoName = toTitleCase(cleanName(speech));
    caller.lastStep = "confirm_demo_name";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, I have ${caller.demoName}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_demo_name") {
    if (isYes(speech)) {
      caller.lastStep = "confirm_demo_phone";
      caller.demoPhone = caller.phone;

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Is ${formatPhoneNumberForSpeech(caller.demoPhone)} the best number to reach you?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.demoName = null;
      caller.lastStep = "ask_demo_name";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "I'm sorry about that. May I have your full name again?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, I have ${caller.demoName || "your name"}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_demo_phone") {
    if (isYes(speech)) {
      caller.lastStep = "ask_demo_email";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "What is the best email address for the demo?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.lastStep = "ask_demo_phone";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Okay. What is the best number to reach you for the demo?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Is ${formatPhoneNumberForSpeech(caller.demoPhone)} the best number to reach you?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_demo_phone") {
    caller.demoPhone = cleanForSpeech(speech);
    caller.lastStep = "ask_demo_email";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "What is the best email address for the demo?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_demo_email") {
    caller.demoEmail = cleanEmail(speech);
    caller.lastStep = "confirm_demo_email";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, I have ${formatEmailForSpeech(caller.demoEmail)}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_demo_email") {
    if (isYes(speech)) {
      caller.leadType = "demo_request";
      caller.status = "new_demo_request";
      caller.makeSent = false;

      sendLeadToMake(caller);

      twiml.say(
        { voice: "alice" },
        "Perfect. We will follow up with you soon about the demo. Have a great day."
      );
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.demoEmail = null;
      caller.lastStep = "ask_demo_email";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "No problem. What is the correct email address for the demo?"
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, I have ${formatEmailForSpeech(caller.demoEmail)}. Is that correct?`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});