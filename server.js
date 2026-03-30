/*************************************************
 BLUE CALLER AUTOMATION - VOICE SERVER
 VERSION: V79-EMERGENCY-LOOP-FIX
 DATE: 2026-03-29
*************************************************/

console.log("🔥 BLUE CALLER SERVER V79 LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");
const path = require("path");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V79-EMERGENCY-LOOP-FIX";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static("public"));

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
      notes: "",
      status: "new_lead",
      appointmentDate: "",
      appointmentTime: "",
      lastStep: "ask_issue",
      silenceCount: 0,
      makeSent: false
    };
  }
  return callerStore[phone];
}

function cleanSpeechText(input) {
  if (!input) return "";
  return String(input).trim().replace(/\s+/g, " ");
}

function normalizedText(text) {
  return cleanSpeechText(text || "").toLowerCase();
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.substring(1);
  return digits.split("").join(" ");
}

/* ---------- YES / NO DETECTION (FIXED) ---------- */

function isAffirmative(text) {
  const t = normalizedText(text).replace(/[^\w\s]/g, "").trim();

  return (
    t === "yes" ||
    t === "yeah" ||
    t === "yep" ||
    t === "yup" ||
    t === "correct" ||
    t === "right" ||
    t === "ok" ||
    t === "okay" ||
    t === "sure" ||
    t === "please do" ||
    t === "go ahead" ||
    t.includes("mark this as an emergency") ||
    t.includes("make this an emergency") ||
    t.includes("its an emergency") ||
    t.includes("it is an emergency") ||
    t.includes("urgent") ||
    t.includes("as soon as possible") ||
    t.includes("right away") ||
    t.includes("immediately")
  );
}

function isNegative(text) {
  const t = normalizedText(text).replace(/[^\w\s]/g, "").trim();

  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("not an emergency") ||
    t.includes("not urgent") ||
    t.includes("can wait") ||
    t.includes("no rush") ||
    t.includes("business hours")
  );
}

/* ---------- TWILIO SPEECH HANDLER ---------- */

function sayThenGather(twiml, res, actionUrl, prompt) {
  twiml.say({ voice: "alice" }, prompt);
  twiml.pause({ length: 1.5 });

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

/* ---------- INCOMING CALL ---------- */

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  caller.lastStep = "ask_issue";

  twiml.say(
    { voice: "alice" },
    "Thank you for calling Blue Caller Automation. This is Alex, your virtual receptionist. How can I help you today?"
  );

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

/* ---------- MAIN CALL LOGIC ---------- */

app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (!speech) {
    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "I'm sorry, I didn't catch that. Could you please repeat that?"
    );
  }

  /* ---------- ISSUE STEP ---------- */

  if (caller.lastStep === "ask_issue") {
    caller.issue = speech.toLowerCase();

    if (caller.issue.includes("leak")) {
      caller.issueSummary = "a leak";
      caller.leakNeedsEmergencyChoice = true;
      caller.lastStep = "leak_emergency_choice";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "I'm sorry you're dealing with a leak. Do you want me to mark this as an emergency?"
      );
    }

    caller.issueSummary = speech;
    caller.lastStep = "ask_name";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Can I start by getting your full name, please?"
    );
  }

  /* ---------- LEAK EMERGENCY STEP (FIXED LOOP) ---------- */

  if (caller.lastStep === "leak_emergency_choice") {
    if (isAffirmative(speech)) {
      caller.emergencyAlert = true;
      caller.leadType = "emergency";
      caller.status = "new_emergency";
      caller.lastStep = "ask_name";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Alright, I'm going to mark this as an emergency. Can I start by getting your full name?"
      );
    }

    if (isNegative(speech)) {
      caller.emergencyAlert = false;
      caller.leadType = "service";
      caller.status = "new_lead";
      caller.lastStep = "ask_name";

      return sayThenGather(
        twiml,
        res,
        "/handle-input",
        "Alright, I've got this as a standard service request. Can I start by getting your full name?"
      );
    }

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Do you want me to mark this as an emergency? Please say yes or no."
    );
  }

  /* ---------- NAME STEP ---------- */

  if (caller.lastStep === "ask_name") {
    caller.fullName = speech;
    caller.firstName = speech.split(" ")[0];
    caller.lastStep = "confirm_phone";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      `Thank you, ${caller.firstName}. Is ${formatPhoneNumberForSpeech(caller.callbackNumber || caller.phone)} a good number to reach you?`
    );
  }

  /* ---------- PHONE CONFIRM ---------- */

  if (caller.lastStep === "confirm_phone") {
    caller.callbackConfirmed = true;
    caller.lastStep = "ask_address";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "What is the service address?"
    );
  }

  /* ---------- ADDRESS ---------- */

  if (caller.lastStep === "ask_address") {
    caller.address = speech;
    caller.lastStep = "final_question";

    return sayThenGather(
      twiml,
      res,
      "/handle-input",
      "Before I submit this, are there any notes you'd like me to add?"
    );
  }

  /* ---------- FINAL ---------- */

  if (caller.lastStep === "final_question") {
    sendLeadToMake(caller);

    twiml.say(
      { voice: "alice" },
      caller.emergencyAlert
        ? "Perfect. I am submitting this emergency request now and someone will contact you shortly."
        : "Perfect. I am submitting your request now and someone will contact you shortly."
    );

    twiml.say({ voice: "alice" }, "Thank you for calling. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Sorry, something went wrong. Please call back.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

/* ---------- MAKE WEBHOOK ---------- */

function sendLeadToMake(caller) {
  if (caller.makeSent) return;

  const payload = JSON.stringify({
    leadType: caller.leadType,
    fullName: caller.fullName,
    phone: caller.phone,
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
      "Content-Length": Buffer.byteLength(payload)
    }
  };

  const req = https.request(options);
  req.write(payload);
  req.end();

  caller.makeSent = true;
}

/* ---------- BROWSER CALL TOKEN ---------- */

app.get("/twilio-token", (req, res) => {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

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
});

/* ---------- START SERVER ---------- */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});
