console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V52-CLASSIFIER-FIX";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const callerStore = {};

function getOrCreateCaller(phone) {
  if (!callerStore[phone]) {
    const now = new Date().toISOString();
    callerStore[phone] = {
      phone,
      name: null,
      firstName: null,
      callbackNumber: null,
      address: null,
      issue: null,
      issueSummary: null,
      emergencyAlert: false,
      unclearEmergency: false,
      notes: null,
      lastStep: null,
      makeSent: false,
      createdAt: now,
      updatedAt: now,
    };
  }
  callerStore[phone].updatedAt = new Date().toISOString();
  return callerStore[phone];
}

function resetCallerForNewCall(caller, phone) {
  caller.phone = phone;
  caller.name = null;
  caller.firstName = null;
  caller.callbackNumber = phone;
  caller.address = null;
  caller.issue = null;
  caller.issueSummary = null;
  caller.emergencyAlert = false;
  caller.unclearEmergency = false;
  caller.notes = null;
  caller.lastStep = "ask_issue";
  caller.makeSent = false;
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
  return cleanForSpeech(input)
    .replace(/\bcomma\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function toTitleCase(value) {
  if (!value) return "";
  return value
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return fullName.split(" ")[0];
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
  return phrases.some(p => text.includes(p));
}

function normalizedText(text) {
  return cleanForSpeech(text || "").toLowerCase();
}

function isAffirmative(text) {
  const t = normalizedText(text);
  return containsAny(t, ["yes","yeah","yep","correct","right","ok","okay","sure"]);
}

function isNegative(text) {
  const t = normalizedText(text);
  return containsAny(t, ["no","nope","nah"]);
}

function isEndCallPhrase(text) {
  const t = normalizedText(text);
  return containsAny(t, ["no","that's all","nothing else","i'm good","all set"]);
}

/* FIXED ISSUE CLASSIFIER */
function classifyIssue(issue) {
  const text = normalizedText(issue);

  // EMERGENCIES
  if (containsAny(text, ["burst pipe","pipe burst"])) {
    return { summary: "a burst pipe", urgency: "emergency" };
  }

  if (containsAny(text, ["sewer backup","sewage backup"])) {
    return { summary: "a sewer backup", urgency: "emergency" };
  }

  if (containsAny(text, ["house is flooding","home is flooding","flooding"])) {
    return { summary: "flooding", urgency: "emergency" };
  }

  // UNCLEAR POSSIBLE EMERGENCY
  if (
    (text.includes("pooling") || text.includes("standing water")) &&
    (text.includes("yard") || text.includes("outside") || text.includes("ground"))
  ) {
    return { summary: "water pooling in your yard", urgency: "unclear" };
  }

  // ROOF LEAK
  if (text.includes("roof") && text.includes("leak")) {
    return { summary: "a roof leak", urgency: "non-emergency" };
  }

  // FAUCET / SINK
  if ((text.includes("faucet") || text.includes("sink")) && text.includes("leak")) {
    return { summary: "a leaking faucet", urgency: "non-emergency" };
  }

  // WATER HEATER
  if (text.includes("water heater") && text.includes("leak")) {
    return { summary: "a leaking water heater", urgency: "non-emergency" };
  }

  // DRAIN
  if (containsAny(text, ["clog","clogged","drain"])) {
    return { summary: "a clogged drain", urgency: "non-emergency" };
  }

  // GENERIC LEAK
  if (text.includes("leak")) {
    return { summary: "a water leak", urgency: "non-emergency" };
  }

  return { summary: "your service issue", urgency: "non-emergency" };
}

function sendLeadToMake(caller) {
  if (caller.makeSent) return;

  try {
    const data = JSON.stringify({
      timestamp: new Date().toISOString(),
      phone: caller.phone,
      name: caller.name,
      address: caller.address,
      issueSummary: caller.issueSummary,
      emergency: caller.emergencyAlert,
      notes: caller.notes
    });

    const url = new URL(MAKE_WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const makeReq = https.request(options);
    makeReq.write(data);
    makeReq.end();

    caller.makeSent = true;
  } catch (err) {
    console.error(err);
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
    speechTimeout: 3,
    timeout: 10,
    language: "en-US",
  });

  gather.say({ voice: "alice" }, text);
  return res.type("text/xml").send(twiml.toString());
}

/* INCOMING CALL */
app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  resetCallerForNewCall(caller, phone);

  twiml.say(
    { voice: "alice" },
    "Thank you for calling Blue Caller Automation. This is Alex, our automated receptionist demo. Please speak to me just like one of your customers would if they were calling to book a service call or request a quote. Let's get this demo started."
  );

  twiml.pause({ length: 1 });

  return buildAndSend(
    twiml,
    res,
    baseUrl,
    "Thank you for calling Blue Caller Automation, this is Alex. How can I help you today?"
  );
});

/* HANDLE INPUT */
app.post("/handle-input", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (caller.lastStep === "ask_issue") {
    caller.issue = speech;
    const classification = classifyIssue(speech);
    caller.issueSummary = classification.summary;

    if (classification.urgency === "emergency") {
      caller.emergencyAlert = true;
      caller.lastStep = "ask_name";

      return buildAndSend(
        twiml, res, baseUrl,
        `I'm sorry you're dealing with that. I have marked this as an emergency for ${caller.issueSummary} and will get this to our service team just as soon as I get all your information. Can I start by getting your full name, please?`
      );
    }

    if (classification.urgency === "unclear") {
      caller.lastStep = "unclear_emergency";
      return buildAndSend(
        twiml, res, baseUrl,
        `Alright, so you have ${caller.issueSummary}. If you'd like, I can mark this as an emergency and have someone get back to you as soon as possible.`
      );
    }

    caller.lastStep = "ask_name";
    return buildAndSend(
      twiml, res, baseUrl,
      `I can definitely help you with that. So this is ${caller.issueSummary}, correct? Can I start by getting your full name, please?`
    );
  }

  if (caller.lastStep === "unclear_emergency") {
    caller.lastStep = "ask_name";

    if (isAffirmative(speech)) {
      caller.emergencyAlert = true;
      return buildAndSend(
        twiml, res, baseUrl,
        "Alright, I've got this marked as an emergency. Can I start by getting your full name, please?"
      );
    }

    return buildAndSend(
      twiml, res, baseUrl,
      "Alright, no problem. Can I start by getting your full name, please?"
    );
  }

  if (caller.lastStep === "ask_name") {
    caller.name = toTitleCase(speech);
    caller.firstName = getFirstName(caller.name);
    caller.lastStep = "confirm_phone";

    return buildAndSend(
      twiml, res, baseUrl,
      `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "confirm_phone") {
    if (isNegative(speech)) {
      caller.lastStep = "get_new_phone";
      return buildAndSend(
        twiml, res, baseUrl,
        "No problem. What's the best number to reach you?"
      );
    }

    caller.lastStep = "ask_address";
    return buildAndSend(
      twiml, res, baseUrl,
      "What is the service address?"
    );
  }

  if (caller.lastStep === "get_new_phone") {
    caller.callbackNumber = speech;
    caller.lastStep = "ask_address";
    return buildAndSend(
      twiml, res, baseUrl,
      "What is the service address?"
    );
  }

  if (caller.lastStep === "ask_address") {
    caller.address = normalizeAddressInput(speech);
    caller.lastStep = "ask_notes";

    const prompt = caller.emergencyAlert
      ? "Before I submit this emergency call, are there any special notes I need to add to your case?"
      : "Got it. Before I submit this service call, are there any special notes I need to add to your case?";

    return buildAndSend(twiml, res, baseUrl, prompt);
  }

  if (caller.lastStep === "ask_notes") {
    if (!isEndCallPhrase(speech)) {
      caller.notes = speech;
    }

    caller.lastStep = "recap";

    const recap = caller.emergencyAlert
      ? `Okay, just to recap, I am marking this as an emergency for ${caller.issueSummary}, and I'm submitting it for review now. Someone from our service team will contact you shortly. Is there anything else I can do for you today?`
      : `Okay, just to recap, I'm submitting your service call for ${caller.issueSummary} now, and someone from the office will give you a call shortly to go over this and get you scheduled. Is there anything else I can add to your case before I submit this?`;

    return buildAndSend(twiml, res, baseUrl, recap);
  }

  if (caller.lastStep === "recap") {
    if (!isEndCallPhrase(speech)) {
      caller.notes = (caller.notes || "") + " " + speech;
    }

    sendLeadToMake(caller);

    const goodbye = caller.emergencyAlert
      ? "Thank you for calling. Take care."
      : "Perfect. Thank you for calling, and have a great day.";

    twiml.say({ voice: "alice" }, goodbye);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say("Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});