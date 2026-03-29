/*************************************************
 BLUE CALLER AUTOMATION - VOICE SERVER
 VERSION: V69
 DATE: 2026-03-28
 NOTES:
 - Added schedule vs callback option
 - Added appointment date capture
 - Added appointment time capture
 - Fixed name capture (John and issue)
 - Fixed emergency logic
*************************************************/

console.log("🔥 BLUE CALLER SERVER V69 LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V69";
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
      notes: "",
      status: "new_lead",
      appointmentDate: "",
      appointmentTime: "",
      makeSent: false,
      lastStep: null
    };
  }
  return callerStore[phone];
}

function cleanSpeechText(input) {
  if (!input) return "";
  return String(input).trim().replace(/\s+/g, " ");
}

function toTitleCase(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function getFirstName(name) {
  if (!name) return "";
  return name.split(" ")[0];
}

function hasFullName(name) {
  if (!name) return false;
  return name.trim().split(" ").length >= 2;
}

function normalizedText(text) {
  return cleanSpeechText(text).toLowerCase();
}

function isAffirmative(text) {
  const t = normalizedText(text);
  return t.includes("yes") || t.includes("yeah") || t.includes("correct") || t.includes("right");
}

function isNegative(text) {
  const t = normalizedText(text);
  return t.includes("no") || t.includes("not") || t.includes("whenever") || t.includes("business hours");
}

function isLeak(text) {
  const t = normalizedText(text);
  return t.includes("leak") || t.includes("drip") || t.includes("dripping");
}

function isEmergencyWords(text) {
  const t = normalizedText(text);
  return t.includes("gushing") || t.includes("pouring") || t.includes("flooding") || t.includes("burst");
}

function formatPhoneForSpeech(phone) {
  return phone.replace(/\D/g, "").split("").join(" ");
}

function sendToMake(caller) {
  if (caller.makeSent) return;

  const payload = JSON.stringify(caller);
  const url = new URL(MAKE_WEBHOOK_URL);

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": payload.length
    }
  };

  const req = https.request(options);
  req.write(payload);
  req.end();

  caller.makeSent = true;
}

function sayGather(twiml, res, action, text) {
  twiml.say({ voice: "alice" }, text);
  twiml.gather({
    input: "speech",
    action,
    method: "POST",
    speechTimeout: "auto"
  });
  res.type("text/xml").send(twiml.toString());
}

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  caller.lastStep = "ask_issue";

  twiml.say({ voice: "alice" },
    "Thank you for calling Blue Caller Automation. This is Alex, your virtual receptionist. This is a demo line so you can experience how I would answer calls for your business. How can I help you today?"
  );

  twiml.gather({
    input: "speech",
    action: "/handle-input",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From;
  const speech = cleanSpeechText(req.body.SpeechResult);
  const caller = getOrCreateCaller(phone);

  if (caller.lastStep === "ask_issue") {
    caller.issue = speech;
    caller.issueSummary = speech;

    if (isEmergencyWords(speech)) {
      caller.emergencyAlert = true;
      caller.status = "new_emergency";
      caller.lastStep = "ask_name";
      return sayGather(twiml, res, "/handle-input",
        "I'm sorry you're dealing with this. I am marking this as an emergency. Can I start with your full name?"
      );
    }

    if (isLeak(speech)) {
      caller.lastStep = "leak_emergency";
      return sayGather(twiml, res, "/handle-input",
        "I'm sorry you're dealing with this leak. Should I mark this as an emergency, or handle it during normal business hours?"
      );
    }

    caller.lastStep = "ask_name";
    return sayGather(twiml, res, "/handle-input",
      "I'd be happy to help with that. Can I get your full name?"
    );
  }

  if (caller.lastStep === "leak_emergency") {
    if (isAffirmative(speech)) {
      caller.emergencyAlert = true;
      caller.status = "new_emergency";
    }
    caller.lastStep = "ask_name";
    return sayGather(twiml, res, "/handle-input",
      "Can I start with your full name?"
    );
  }

  if (caller.lastStep === "ask_name") {
    caller.fullName = toTitleCase(speech);
    caller.firstName = getFirstName(caller.fullName);

    if (!hasFullName(caller.fullName)) {
      caller.lastStep = "ask_last_name";
      return sayGather(twiml, res, "/handle-input",
        `Thank you, ${caller.firstName}. Can I get your last name as well?`
      );
    }

    caller.lastStep = "confirm_phone";
    return sayGather(twiml, res, "/handle-input",
      `Thank you, ${caller.firstName}. Is ${formatPhoneForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "ask_last_name") {
    caller.fullName = `${caller.firstName} ${toTitleCase(speech)}`;
    caller.lastStep = "confirm_phone";
    return sayGather(twiml, res, "/handle-input",
      `Thank you. Is ${formatPhoneForSpeech(caller.callbackNumber)} a good number to reach you?`
    );
  }

  if (caller.lastStep === "confirm_phone") {
    caller.lastStep = "ask_address";
    return sayGather(twiml, res, "/handle-input",
      "What is the service address?"
    );
  }

  if (caller.lastStep === "ask_address") {
    caller.address = speech;

    if (!caller.emergencyAlert) {
      caller.lastStep = "schedule_or_callback";
      return sayGather(twiml, res, "/handle-input",
        "Would you like to schedule a service appointment now, or would you prefer someone to call you to schedule it?"
      );
    }

    caller.lastStep = "ask_notes";
    return sayGather(twiml, res, "/handle-input",
      "Before I submit this, are there any notes you'd like me to add?"
    );
  }

  if (caller.lastStep === "schedule_or_callback") {
    if (speech.toLowerCase().includes("schedule")) {
      caller.lastStep = "ask_day";
      return sayGather(twiml, res, "/handle-input",
        "What day works best for you?"
      );
    } else {
      caller.status = "callback_requested";
      caller.lastStep = "ask_notes";
      return sayGather(twiml, res, "/handle-input",
        "Perfect. Someone will call you to schedule this. Any notes you'd like me to add?"
      );
    }
  }

  if (caller.lastStep === "ask_day") {
    caller.appointmentDate = speech;
    caller.lastStep = "ask_time";
    return sayGather(twiml, res, "/handle-input",
      "What time works best for you?"
    );
  }

  if (caller.lastStep === "ask_time") {
    caller.appointmentTime = speech;
    caller.status = "scheduled";
    caller.lastStep = "ask_notes";
    return sayGather(twiml, res, "/handle-input",
      "Before I submit this, are there any notes you'd like me to add?"
    );
  }

  if (caller.lastStep === "ask_notes") {
    caller.notes = speech;
    sendToMake(caller);

    twiml.say({ voice: "alice" },
      "Perfect. I am submitting this now and someone will contact you shortly. Thank you for calling."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});
