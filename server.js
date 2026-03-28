console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V60-LOCKED-SCHEMA";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const callerStore = {};

function getOrCreateCaller(phone) {
  if (!callerStore[phone]) {
    const now = new Date().toISOString();
    callerStore[phone] = {
      phone,
      fullName: null,
      firstName: null,
      callbackNumber: null,
      address: null,

      issue: null,
      issueSummary: null,
      urgency: "normal",
      emergencyAlert: false,
      unclearEmergency: false,

      leadType: "service",
      projectType: "",
      timeline: "",
      proposalDeadline: "",
      demoEmail: "",

      notes: "",
      makeSent: false,
      lastStep: null,
      createdAt: now,
      updatedAt: now,
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
  caller.address = null;

  caller.issue = null;
  caller.issueSummary = null;
  caller.urgency = "normal";
  caller.emergencyAlert = false;
  caller.unclearEmergency = false;

  caller.leadType = "service";
  caller.projectType = "";
  caller.timeline = "";
  caller.proposalDeadline = "";
  caller.demoEmail = "";

  caller.notes = "";
  caller.makeSent = false;
  caller.lastStep = "ask_issue";
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

  value = value.replace(/^(\d)\s+(\d{2,})(\b.*)$/i, (match, first, second, rest) => {
    if (second.startsWith(first)) {
      return `${second}${rest}`;
    }
    return match;
  });

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
    "alex",
    "emergency",
    "urgent",
    "leak",
    "leaking",
    "flood",
    "flooding",
    "burst",
    "broken",
    "pipe",
    "pipes",
    "water",
    "roof",
    "ceiling",
    "sink",
    "faucet",
    "drain",
    "yard",
    "outside",
    "ground",
    "call",
    "calling",
    "demo",
    "quote",
    "estimate",
    "project",
    "have",
    "need",
    "issue",
    "problem",
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
    "it's",
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
    " calling regarding ",
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
        .replace(/^[,.-\s]+|[,.-\s]+$/g, "");
      const issueRaw = afterMarker.slice(sepIndex + separator.length).trim();

      const possibleName = normalizeNameCandidate(possibleNameRaw);
      const issueText = stripIssueLeadIn(issueRaw);

      if (possibleName && issueText) {
        return { name: possibleName, issueText };
      }
    }

    const commaParts = afterMarker.split(",");
    if (commaParts.length >= 2) {
      const possibleName = normalizeNameCandidate(commaParts[0].trim());
      const issueText = stripIssueLeadIn(commaParts.slice(1).join(",").trim());
      if (possibleName && issueText) {
        return { name: possibleName, issueText };
      }
    }
  }

  return { name: null, issueText: original };
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.substring(1);
  }
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
  return containsAny(t, [
    "yes",
    "yeah",
    "yep",
    "correct",
    "right",
    "ok",
    "okay",
    "sure",
  ]);
}

function isNegative(text) {
  const t = normalizedText(text);
  return containsAny(t, ["no", "nope", "nah"]);
}

function isEndCallPhrase(text) {
  const t = normalizedText(text);
  return containsAny(t, [
    "no",
    "that's all",
    "that is all",
    "nothing else",
    "i'm good",
    "im good",
    "all set",
    "no thank you",
    "no thanks",
  ]);
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

function classifyIssue(issue) {
  const text = normalizedText(issue);

  if (containsAny(text, ["burst pipe", "pipe burst"])) {
    return { summary: "a burst pipe", urgency: "emergency" };
  }

  if (containsAny(text, ["sewer backup", "sewage backup"])) {
    return { summary: "a sewer backup", urgency: "emergency" };
  }

  if (containsAny(text, ["flood", "flooding"])) {
    return { summary: "flooding", urgency: "emergency" };
  }

  if (
    (text.includes("pooling") || text.includes("standing water")) &&
    (text.includes("yard") || text.includes("outside") || text.includes("ground"))
  ) {
    return { summary: "water pooling in your yard", urgency: "unclear" };
  }

  if (text.includes("water main")) {
    return { summary: "a possible water main leak", urgency: "emergency" };
  }

  if (text.includes("roof") && text.includes("leak")) {
    return { summary: "a roof leak", urgency: "normal" };
  }

  if (text.includes("ceiling") && text.includes("leak")) {
    return { summary: "a ceiling leak", urgency: "normal" };
  }

  if ((text.includes("faucet") || text.includes("sink")) && text.includes("leak")) {
    return { summary: "a leaking faucet", urgency: "normal" };
  }

  if (text.includes("water heater") && text.includes("leak")) {
    return { summary: "a leaking water heater", urgency: "normal" };
  }

  if (containsAny(text, ["clog", "clogged", "drain"])) {
    return { summary: "a clogged drain", urgency: "normal" };
  }

  if (text.includes("leak")) {
    return { summary: "a water leak", urgency: "normal" };
  }

  return { summary: "your service issue", urgency: "normal" };
}

function buildMakePayload(caller) {
  return {
    leadType: caller.leadType || (caller.emergencyAlert ? "emergency" : "service"),
    fullName: caller.fullName || "",
    firstName: caller.firstName || "",
    phone: caller.phone || "",
    callbackNumber: caller.callbackNumber || "",
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
    source: "AI Receptionist",
    timestamp: new Date().toISOString(),
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
  } catch (err) {
    console.error("[MAKE ERROR]", err.message);
  }
}

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || "https";
  return `${proto}://${req.get("host")}`;
}

function buildAndSend(twiml, res, baseUrl, text) {
  const gather = twiml.gather({
    input: "speech",
    action: `${baseUrl}/handle-input`,
    method: "POST",
    speechTimeout: 5,
    timeout: 12,
    language: "en-US",
  });

  gather.say({ voice: "alice" }, text);
  return res.type("text/xml").send(twiml.toString());
}

function moveToNameOrPhoneStep(twiml, res, baseUrl, caller) {
  if (caller.fullName && caller.firstName) {
    caller.lastStep = "confirm_phone";

    if (caller.emergencyAlert) {
      return buildAndSend(
        twiml,
        res,
        baseUrl,
        `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Let's start by confirming some information. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
      );
    }

    return buildAndSend(
      twiml,
      res,
      baseUrl,
      `Thank you, ${caller.firstName}. I'm sorry you're dealing with ${caller.issueSummary}. I'd be more than happy to help you with that. Let's start by confirming some information. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  caller.lastStep = "ask_name";

  if (caller.emergencyAlert) {
    return buildAndSend(
      twiml,
      res,
      baseUrl,
      `I'm sorry you're dealing with ${caller.issueSummary}. I have marked this as an emergency and will get this to our service team just as soon as I get all your information. Can I start by getting your full name, please?`
    );
  }

  return buildAndSend(
    twiml,
    res,
    baseUrl,
    `I'm sorry you're dealing with ${caller.issueSummary}. I'd be more than happy to help you with that. Can I start by getting your full name, please?`
  );
}

app.get("/", (req, res) => {
  res.send(`Server running - ${APP_VERSION}`);
});

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  resetCallerForNewCall(caller, phone);

  twiml.say(
    { voice: "alice" },
    "Thank you for calling Blue Caller Automation. Hi, this is Alex, and I could be your AI receptionist. Please speak to me just like one of your customers would if they were calling your business for service, an emergency, or a quote. Let's start the demo."
  );

  twiml.pause({ length: 1 });

  return buildAndSend(
    twiml,
    res,
    baseUrl,
    "Thank you for calling Blue Caller Automation, this is Alex. How can I help you today?"
  );
});

app.post("/handle-input", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (caller.lastStep === "ask_issue") {
    const parsed = extractOpeningNameAndIssue(speech);

    if (parsed.name) {
      caller.fullName = parsed.name;
      caller.firstName = getFirstName(parsed.name);
      console.log("✅ Captured opening name:", caller.fullName);
    } else {
      console.log("⚠️ No opening name captured");
    }

    caller.issue = cleanForSpeech(parsed.issueText || speech);
    const classification = classifyIssue(caller.issue);
    caller.issueSummary = classification.summary;
    caller.urgency = classification.urgency;

    if (classification.urgency === "emergency") {
      caller.emergencyAlert = true;
      caller.leadType = "emergency";
      return moveToNameOrPhoneStep(twiml, res, baseUrl, caller);
    }

    if (classification.urgency === "unclear") {
      caller.lastStep = "unclear_emergency";
      caller.unclearEmergency = true;

      if (caller.fullName && caller.firstName) {
        return buildAndSend(
          twiml,
          res,
          baseUrl,
          `Thank you, ${caller.firstName}. You mentioned ${caller.issueSummary}. If you'd like, I can mark this as an emergency and have someone get back to you as soon as possible.`
        );
      }

      return buildAndSend(
        twiml,
        res,
        baseUrl,
        `You mentioned ${caller.issueSummary}. If you'd like, I can mark this as an emergency and have someone get back to you as soon as possible.`
      );
    }

    caller.emergencyAlert = false;
    caller.leadType = "service";
    return moveToNameOrPhoneStep(twiml, res, baseUrl, caller);
  }

  if (caller.lastStep === "unclear_emergency") {
    if (isAffirmative(speech)) {
      caller.emergencyAlert = true;
      caller.urgency = "emergency";
      caller.leadType = "emergency";
      return moveToNameOrPhoneStep(twiml, res, baseUrl, caller);
    }

    caller.emergencyAlert = false;
    caller.urgency = "normal";
    caller.leadType = "service";
    return moveToNameOrPhoneStep(twiml, res, baseUrl, caller);
  }

  if (caller.lastStep === "ask_name") {
    caller.fullName = toTitleCase(cleanName(speech));
    caller.firstName = getFirstName(caller.fullName);
    caller.lastStep = "confirm_phone";

    return buildAndSend(
      twiml,
      res,
      baseUrl,
      `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "confirm_phone") {
    if (isNegative(speech)) {
      caller.lastStep = "get_new_phone";
      return buildAndSend(
        twiml,
        res,
        baseUrl,
        "No problem. What's the best number to reach you?"
      );
    }

    caller.lastStep = "ask_address";
    return buildAndSend(
      twiml,
      res,
      baseUrl,
      "What is the service address?"
    );
  }

  if (caller.lastStep === "get_new_phone") {
    caller.callbackNumber = speech;
    caller.lastStep = "ask_address";
    return buildAndSend(
      twiml,
      res,
      baseUrl,
      "What is the service address?"
    );
  }

  if (caller.lastStep === "ask_address") {
    caller.address = normalizeAddressInput(speech);
    caller.lastStep = "ask_notes";

    return buildAndSend(
      twiml,
      res,
      baseUrl,
      "Before I submit this, are there any notes or details you'd like me to add for the technician?"
    );
  }

  if (caller.lastStep === "ask_notes") {
    if (isPricingQuestion(speech)) {
      return buildAndSend(
        twiml,
        res,
        baseUrl,
        `${pricingResponse()} Before I submit this, are there any notes or details you'd like me to add for the technician?`
      );
    }

    if (!isEndCallPhrase(speech)) {
      caller.notes = speech;
    }

    caller.lastStep = "recap";

    const recap = caller.emergencyAlert
      ? `Okay, just to recap, I am marking this as an emergency for ${caller.issueSummary}, and I'm submitting it for review now. Someone from our service team will contact you shortly. Is there anything else I can do for you today?`
      : `Okay, just to recap, I'm submitting your service call for ${caller.issueSummary} now, and someone from the office will give you a call shortly to go over this and get you scheduled. Is there anything else I can add before I submit this?`;

    return buildAndSend(twiml, res, baseUrl, recap);
  }

  if (caller.lastStep === "recap") {
    if (isPricingQuestion(speech)) {
      return buildAndSend(
        twiml,
        res,
        baseUrl,
        `${pricingResponse()} ${caller.emergencyAlert ? "Is there anything else I can do for you today?" : "Is there anything else I can add before I submit this?"}`
      );
    }

    if (!isEndCallPhrase(speech)) {
      caller.notes = caller.notes ? `${caller.notes} ${speech}` : speech;
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
