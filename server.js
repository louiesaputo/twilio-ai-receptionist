console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V20-NAME-DETECTION";
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

function extractName(text) {
  if (!text) return null;

  const patterns = [
    /my name is (.+)/i,
    /this is (.+)/i,
    /i am (.+)/i,
    /it's (.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return fullName.split(" ")[0];
}

function summarizeIssue(issue) {
  const text = (issue || "").toLowerCase();

  if (text.includes("kitchen") && text.includes("leak")) return "a leak in your kitchen faucet";
  if (text.includes("bathroom") && text.includes("leak")) return "a leak in your bathroom faucet";
  if (text.includes("toilet") && text.includes("clog")) return "a clogged toilet";
  if (text.includes("toilet") && text.includes("running")) return "a running toilet";
  if (text.includes("water heater") && text.includes("leak")) return "a leaking water heater";
  if (text.includes("water heater") && text.includes("no hot water")) return "no hot water from your water heater";
  if (text.includes("ac") && text.includes("not cooling")) return "an AC that is not cooling";
  if (text.includes("heat") && text.includes("not working")) return "a heater that is not working";
  if (text.includes("water main") && text.includes("leak")) return "a water main leak";
  if (text.includes("leak")) return "a leak";

  return "the issue you described";
}

function isEmergency(text) {
  const t = (text || "").toLowerCase();
  return t.includes("emergency") || t.includes("urgent") || t.includes("leak") || t.includes("flood") || t.includes("no heat") || t.includes("no ac");
}

function isPricingQuestion(text) {
  const t = (text || "").toLowerCase();
  return t.includes("price") || t.includes("cost") || t.includes("how much") || t.includes("estimate") || t.includes("quote");
}

function pricingResponse() {
  return "Each job is different, so pricing depends on the details of the work. One of our team members will go over pricing with you when they call to review your request.";
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

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || "https";
  return `${proto}://${req.get("host")}`;
}

function gather(twiml, url, message) {
  const g = twiml.gather({
    input: "speech",
    action: url,
    method: "POST",
    speechTimeout: "auto",
  });
  g.say({ voice: "alice" }, message);
}

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  caller.lastStep = "ask_issue";

  gather(twiml, `${baseUrl}/handle-input`, "Thanks for calling Blue Caller Automation. What is going on today?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From;
  const speech = cleanSpeechText(req.body.SpeechResult);
  const caller = getOrCreateCaller(phone);

  if (isPricingQuestion(speech)) {
    twiml.say(pricingResponse());
    gather(twiml, `${baseUrl}/handle-input`, "Now, please continue.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_issue") {
    caller.issue = speech;
    caller.issueSummary = summarizeIssue(speech);
    caller.urgency = isEmergency(speech) ? "emergency" : "normal";
    caller.emergencyAlert = caller.urgency === "emergency";

    const detectedName = extractName(speech);
    if (detectedName) {
      caller.name = detectedName;
      caller.firstName = getFirstName(detectedName);
      caller.lastStep = "confirm_issue";

      gather(
        twiml,
        `${baseUrl}/handle-input`,
        `Thank you ${caller.firstName}. Just to confirm, you are calling about ${caller.issueSummary}. Is that correct?`
      );
    } else {
      caller.lastStep = "confirm_issue";
      gather(
        twiml,
        `${baseUrl}/handle-input`,
        `Just to confirm, you are calling about ${caller.issueSummary}. Is that correct?`
      );
    }

    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_issue") {
    if (!caller.name) {
      caller.lastStep = "ask_name";
      gather(twiml, `${baseUrl}/handle-input`, "Can I have your full name?");
    } else {
      caller.lastStep = "ask_callback";
      gather(twiml, `${baseUrl}/handle-input`, "Is this the best callback number to reach you?");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_name") {
    caller.name = speech;
    caller.firstName = getFirstName(speech);
    caller.lastStep = "ask_callback";
    gather(twiml, `${baseUrl}/handle-input`, "Is this the best callback number to reach you?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_callback") {
    caller.callbackConfirmed = speech;
    caller.lastStep = "ask_address";
    gather(twiml, `${baseUrl}/handle-input`, "What is the address for the job?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_address") {
    caller.address = speech;
    caller.lastStep = "ask_appt";
    gather(twiml, `${baseUrl}/handle-input`, "Do you have a preferred day or time for the appointment?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_appt") {
    caller.appointmentDate = speech;
    caller.lastStep = "anything_else";
    gather(twiml, `${baseUrl}/handle-input`, "Is there anything else I can help you with today?");
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

  twiml.say("Sorry, something went wrong.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});