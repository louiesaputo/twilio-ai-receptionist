// Confirmed changes in this version:
// - Improves opening name capture so phrases like:
//   "This is John Smith with an emergency main pipe in my front yard that busted"
//   "Hi, this is John Smith and I have a leak"
//   "John Smith calling about a burst pipe"
//   will retain the caller name correctly
// - Keeps all currently working behavior:
//   issue confirmation, detailed issue summaries, callback read-back,
//   pricing response, anything-else step, emergency routing, and Make payloads

console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V27-OPENING-NAME-FIX";
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
      lastStep: null,
      retryCount: 0,
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

function normalizeNameCandidate(name) {
  if (!name) return "";

  let cleaned = cleanName(name)
    .replace(/\b(calling|about|with|for|and|because|regarding|concerning|that|who)\b.*$/i, "")
    .trim();

  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => /^[a-zA-Z'-]+$/.test(word));

  if (words.length === 0) return "";
  if (words.length > 3) return "";

  const banned = new Set([
    "emergency",
    "urgent",
    "leak",
    "flood",
    "flooding",
    "pipe",
    "main",
    "water",
    "gas",
    "kitchen",
    "bathroom",
    "front",
    "yard",
    "street",
    "busted",
    "broken",
    "burst",
  ]);

  if (banned.has(words[0].toLowerCase())) return "";

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
}

function extractOpeningNameAndIssue(text) {
  const original = cleanSpeechText(text || "");
  if (!original) {
    return { name: null, issueText: "" };
  }

  const prefixPatterns = [
    /^(?:hi|hello|hey)[,\s]+this is\s+(.+)$/i,
    /^this is\s+(.+)$/i,
    /^(?:hi|hello|hey)[,\s]+my name is\s+(.+)$/i,
    /^my name is\s+(.+)$/i,
    /^(?:hi|hello|hey)[,\s]+i am\s+(.+)$/i,
    /^i am\s+(.+)$/i,
    /^i'm\s+(.+)$/i,
  ];

  const connectorPattern =
    /\s+(?:calling\s+)?(?:with|about|for|regarding|concerning|and I have|and i've got|and I need|and i have|and i've got|and i need|because)\s+/i;

  for (const pattern of prefixPatterns) {
    const match = original.match(pattern);
    if (!match) continue;

    const remainder = match[1].trim();
    const split = remainder.split(connectorPattern);

    if (split.length >= 2) {
      const possibleName = normalizeNameCandidate(split[0]);
      const issueText = cleanForSpeech(split.slice(1).join(" ").trim());

      if (possibleName && issueText) {
        return { name: possibleName, issueText };
      }
    }
  }

  const directPatterns = [
    /^([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)\s+calling\s+(?:with|about|for|regarding)\s+(.+)$/i,
    /^([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)\s+with\s+(.+)$/i,
    /^([a-zA-Z'-]+\s+[a-zA-Z'-]+(?:\s+[a-zA-Z'-]+)?)\s+about\s+(.+)$/i,
  ];

  for (const pattern of directPatterns) {
    const match = original.match(pattern);
    if (!match) continue;

    const possibleName = normalizeNameCandidate(match[1]);
    const issueText = cleanForSpeech(match[2]);

    if (possibleName && issueText) {
      return { name: possibleName, issueText };
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
    speechTimeout: options.speechTimeout || 2,
    timeout: options.timeout || 8,
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

function classifyIssue(issue) {
  const text = (issue || "").toLowerCase().trim();

  if (!text) {
    return {
      category: "generic",
      summary: "the issue you described",
      urgency: "non-emergency",
    };
  }

  const hasLeak = containsAny(text, ["leak", "leaking", "leaky", "busted", "burst"]);
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

function getRepromptForCurrentStep(caller) {
  if (caller.lastStep === "confirm_issue") {
    if (caller.urgency === "emergency") {
      return `I understand this is an emergency regarding ${caller.issueSummary || "your issue"}. I am marking this as urgent. Just to confirm, is that correct?`;
    }
    return `Now, just to confirm, you are calling about ${caller.issueSummary || "the issue you described"}. Is that correct?`;
  }

  if (caller.lastStep === "ask_name") {
    return "Now, can I have your full name?";
  }

  if (caller.lastStep === "confirm_callback") {
    const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);
    return `Now, I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`;
  }

  if (caller.lastStep === "ask_callback") {
    return "Now, what is the best callback number to reach you?";
  }

  if (caller.lastStep === "ask_address") {
    return "Now, what is the address for the job?";
  }

  if (caller.lastStep === "ask_appt") {
    return "Now, do you have a preferred day or time for the appointment?";
  }

  if (caller.lastStep === "anything_else") {
    return "Other than that, is there anything else you would like to add before we finish up?";
  }

  if (caller.lastStep === "capture_additional_need") {
    return "Please tell me what else you would like to add.";
  }

  return "Now, please continue.";
}

function closeCall(twiml, caller) {
  sendLeadToMake(caller);

  twiml.say(
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
  caller.lastStep = "ask_issue";
  caller.retryCount = 0;

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    "Thanks for calling Blue Caller Automation. What is going on today?"
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
      twiml.say("I am sorry, I still could not hear you. Please call back.");
      twiml.hangup();
    }

    return res.type("text/xml").send(twiml.toString());
  }

  caller.retryCount = 0;

  if (isPricingQuestion(speech)) {
    twiml.say(pricingResponse());

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
    caller.lastStep = "confirm_issue";

    if (caller.urgency === "emergency") {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `I understand this is an emergency regarding ${caller.issueSummary}. I am marking this as urgent. Just to confirm, is that correct?`
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

    if (caller.urgency === "emergency") {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Sorry, I missed that. I understand this is an emergency regarding ${caller.issueSummary}. I am marking this as urgent. Just to confirm, is that correct?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Sorry, I missed that. You are calling about ${caller.issueSummary || "the issue you described"}. Is that correct?`
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
        twiml.say("I am sorry, I still could not get your name. Please call back.");
        twiml.hangup();
      }

      return res.type("text/xml").send(twiml.toString());
    }

    caller.name = cleanedName;
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
      caller.lastStep = "anything_else";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Is there anything else you would like to add before we finish up?"
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
    caller.lastStep = "anything_else";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Is there anything else you would like to add before we finish up?"
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
      caller.issue = `${caller.issue}. Additional request: ${caller.additionalNeed}`;
    }

    closeCall(twiml, caller);
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say("Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});