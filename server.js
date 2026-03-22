console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V24-EMERGENCY-ROUTING";
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
    .trim();
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
}

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || "https";
  return `${proto}://${req.get("host")}`;
}

function buildSpeechGather(twiml, actionUrl, prompt) {
  const gather = twiml.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
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

  return digits.split("").join(" ");
}

function isYes(text) {
  return /yes|yeah|yep|correct|right|sure/.test((text || "").toLowerCase());
}

function isNo(text) {
  return /no|nope|wrong|different|nothing else|that is all|that's all|all set/.test(
    (text || "").toLowerCase()
  );
}

function isEmergencyPhrase(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("emergency") ||
    t.includes("urgent") ||
    t.includes("asap") ||
    t.includes("immediately") ||
    t.includes("flood") ||
    t.includes("burst") ||
    t.includes("leak") ||
    t.includes("gas") ||
    t.includes("smoke") ||
    t.includes("no water") ||
    t.includes("no heat")
  );
}

function detectUrgency(text) {
  return isEmergencyPhrase(text) ? "emergency" : "non-emergency";
}

function isPricingQuestion(text) {
  const t = (text || "").toLowerCase();
  return t.includes("price") || t.includes("cost") || t.includes("how much");
}

function pricingResponse() {
  return "Each job is different, so pricing depends on the details of the work. One of our team members will go over pricing with you when they call to review your request.";
}

function summarizeIssue(issue) {
  const text = (issue || "").toLowerCase();

  if (text.includes("front yard") && text.includes("leak")) {
    return "a possible water main leak in your front yard";
  }

  if (text.includes("kitchen faucet") && text.includes("leak")) {
    return "a leak in your kitchen faucet";
  }

  if (text.includes("bathroom faucet") && text.includes("leak")) {
    return "a leak in your bathroom faucet";
  }

  if (text.includes("toilet") && text.includes("clog")) {
    return "a clogged toilet";
  }

  if (text.includes("water heater") && text.includes("no hot water")) {
    return "a water heater issue with no hot water";
  }

  if (text.includes("ac") && text.includes("not cooling")) {
    return "an air conditioner that is not cooling";
  }

  if (text.includes("leak")) return "a leak";

  return "the issue you described";
}

function sendLeadToMake(caller) {
  try {
    const data = JSON.stringify(caller);
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

    const req = https.request(options);
    req.write(data);
    req.end();
  } catch (err) {
    console.error(err);
  }
}

function closeCall(twiml, caller) {
  sendLeadToMake(caller);

  twiml.say(
    `Thank you ${caller.firstName || ""}. This call has been marked ${
      caller.urgency === "emergency" ? "urgent" : "for normal service"
    }. Someone will contact you shortly. Have a great day.`
  );

  twiml.hangup();
}

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  caller.issue = null;
  caller.issueSummary = null;
  caller.name = null;
  caller.firstName = null;
  caller.callbackNumber = phone;
  caller.callbackConfirmed = null;
  caller.address = null;
  caller.urgency = null;
  caller.emergencyAlert = false;
  caller.status = "in_progress";
  caller.lastStep = "ask_issue";

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    "Thanks for calling Blue Caller Automation. What is going on today?"
  );

  res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (isPricingQuestion(speech)) {
    twiml.say(pricingResponse());
    buildSpeechGather(twiml, `${baseUrl}/handle-input`, "Now, please continue.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_issue") {
    caller.issue = cleanForSpeech(speech);
    caller.issueSummary = summarizeIssue(caller.issue);
    caller.urgency = detectUrgency(caller.issue);
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
      caller.lastStep = "ask_name";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Can I have your full name?"
      );

      return res.type("text/xml").send(twiml.toString());
    }
  }

  if (caller.lastStep === "ask_name") {
    caller.name = cleanName(speech);
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
      caller.lastStep = "ask_address";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "What is the address for the job?"
      );

      return res.type("text/xml").send(twiml.toString());
    }
  }

  if (caller.lastStep === "ask_address") {
    caller.address = cleanForSpeech(speech);

    // EMERGENCY → SKIP APPOINTMENT
    if (caller.urgency === "emergency") {
      caller.status = "new_emergency";
      closeCall(twiml, caller);
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
    caller.status = "new_lead";
    closeCall(twiml, caller);
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say("Sorry, something went wrong. Please call back.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});