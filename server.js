console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V18-ISSUE-CONFIRM";
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
      name: null,
      firstName: null,
      callbackNumber: null,
      callbackConfirmed: null,
      address: null,
      urgency: null,
      appointmentDate: null,
      appointmentTime: null,
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

function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
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
    speechTimeout: options.speechTimeout || "auto",
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
  return /no|nope|wrong|different|not correct|that's wrong|that is wrong/.test(
    (text || "").toLowerCase()
  );
}

function isEmergencyPhrase(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("emergency") ||
    t.includes("urgent") ||
    t.includes("asap") ||
    t.includes("right away") ||
    t.includes("immediately") ||
    t.includes("burst pipe") ||
    t.includes("flood") ||
    t.includes("flooding") ||
    t.includes("gas leak") ||
    t.includes("smell gas") ||
    t.includes("no heat") ||
    t.includes("no water") ||
    t.includes("sewage") ||
    t.includes("overflow") ||
    t.includes("sparking") ||
    t.includes("smoke") ||
    t.includes("leak") ||
    t.includes("leaking") ||
    t.includes("leaky")
  );
}

function detectUrgency(text) {
  return isEmergencyPhrase(text) ? "emergency" : "non-emergency";
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
    t.includes("what does it cost")
  );
}

function pricingResponse() {
  return "Each job is different, so pricing depends on the details of the work. One of our team members will go over pricing with you when they call to review your request.";
}

function summarizeIssue(issue) {
  const text = (issue || "").toLowerCase().trim();

  if (!text) return "the issue you described";

  if (
    text.includes("kitchen faucet") &&
    (text.includes("leak") || text.includes("leaky") || text.includes("leaking"))
  ) {
    return "a leaking kitchen faucet";
  }

  if (
    text.includes("bathroom faucet") &&
    (text.includes("leak") || text.includes("leaky") || text.includes("leaking"))
  ) {
    return "a leaking bathroom faucet";
  }

  if (
    text.includes("faucet") &&
    (text.includes("leak") || text.includes("leaky") || text.includes("leaking"))
  ) {
    return "a leaking faucet";
  }

  if (text.includes("toilet") && text.includes("clog")) {
    return "a clogged toilet";
  }

  if (text.includes("toilet") && (text.includes("leak") || text.includes("running"))) {
    return "a toilet issue";
  }

  if (text.includes("drain") && text.includes("clog")) {
    return "a clogged drain";
  }

  if (
    text.includes("water heater") &&
    (text.includes("no hot water") || text.includes("not getting hot water"))
  ) {
    return "a water heater issue with no hot water";
  }

  if (
    text.includes("water heater") &&
    (text.includes("leak") || text.includes("leaking"))
  ) {
    return "a leaking water heater";
  }

  if (
    (text.includes("ac") || text.includes("air conditioner")) &&
    (text.includes("not cooling") || text.includes("no cooling"))
  ) {
    return "an air conditioning issue";
  }

  if (text.includes("heat") && (text.includes("not working") || text.includes("no heat"))) {
    return "a heating issue";
  }

  if (text.includes("leak") || text.includes("leaky") || text.includes("leaking")) {
    return "a leak";
  }

  return "the issue you described";
}

function parseAppointmentResponse(text) {
  const lowered = (text || "").toLowerCase();
  let date = null;
  let time = null;

  if (lowered.includes("today")) date = "today";
  else if (lowered.includes("tomorrow")) date = "tomorrow";
  else if (lowered.includes("monday")) date = "monday";
  else if (lowered.includes("tuesday")) date = "tuesday";
  else if (lowered.includes("wednesday")) date = "wednesday";
  else if (lowered.includes("thursday")) date = "thursday";
  else if (lowered.includes("friday")) date = "friday";
  else if (lowered.includes("saturday")) date = "saturday";
  else if (lowered.includes("sunday")) date = "sunday";

  if (lowered.includes("first thing")) time = "first thing in the morning";
  else if (lowered.includes("morning")) time = "morning";
  else if (lowered.includes("afternoon")) time = "afternoon";
  else if (lowered.includes("evening")) time = "evening";

  return { date, time };
}

function sendLeadToMake(caller) {
  try {
    const data = JSON.stringify({
      timestamp: new Date().toISOString(),
      phone: caller.phone || "",
      fullName: caller.name || "",
      firstName: caller.firstName || "",
      callbackNumber: caller.callbackNumber || "",
      callbackConfirmed: caller.callbackConfirmed ?? "",
      address: caller.address || "",
      issue: caller.issue || "",
      urgency: caller.urgency || "",
      appointmentDate: caller.appointmentDate || "",
      appointmentTime: caller.appointmentTime || "",
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

    const makeReq = https.request(options);
    makeReq.write(data);
    makeReq.end();

    console.log("[MAKE] Lead sent");
  } catch (err) {
    console.error("[MAKE ERROR]", err.message);
  }
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
  caller.name = null;
  caller.firstName = null;
  caller.callbackNumber = phone;
  caller.callbackConfirmed = null;
  caller.address = null;
  caller.urgency = null;
  caller.appointmentDate = null;
  caller.appointmentTime = null;
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

    let reprompt = "Now, please continue.";

    if (caller.lastStep === "confirm_issue") {
      const issueSummary = summarizeIssue(caller.issue);
      reprompt = `Now, just to confirm, you are calling about ${issueSummary}. Is that correct?`;
    } else if (caller.lastStep === "ask_name") {
      reprompt = "Now, can I have your full name?";
    } else if (caller.lastStep === "confirm_callback") {
      const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);
      reprompt = `Now, I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`;
    } else if (caller.lastStep === "ask_callback") {
      reprompt = "Now, what is the best callback number to reach you?";
    } else if (caller.lastStep === "ask_address") {
      reprompt = "Now, what is the address for the job?";
    } else if (caller.lastStep === "ask_appt") {
      reprompt = "Now, do you have a preferred day or time for the appointment?";
    } else if (caller.lastStep === "anything_else") {
      reprompt = "Other than that, is there anything else you would like to add before we finish up?";
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      reprompt
    );

    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_issue") {
    caller.issue = cleanForSpeech(speech);
    caller.urgency = detectUrgency(speech);
    caller.lastStep = "confirm_issue";

    const issueSummary = summarizeIssue(caller.issue);

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Just to confirm, you are calling about ${issueSummary}. Is that correct?`
    );
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

    if (isNo(speech)) {
      caller.lastStep = "ask_issue";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        "Okay. Please tell me briefly what is going on."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    const issueSummary = summarizeIssue(caller.issue);

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      `Sorry, I missed that. You are calling about ${issueSummary}. Is that correct?`
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
    sendLeadToMake(caller);

    twiml.say(
      `Thank you ${caller.firstName || ""}. This call has been marked ${
        caller.urgency === "emergency" ? "urgent" : "for normal service"
      }. Someone will call you shortly. Have a great day.`
    );

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