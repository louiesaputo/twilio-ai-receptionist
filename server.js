console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V40-STABLE";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const callerStore = {};

function getOrCreateCaller(phone) {
  if (!callerStore[phone]) {
    callerStore[phone] = {
      phone,
      name: null,
      firstName: null,
      issue: null,
      issueSummary: null,
      address: null,
      zip: null,
      emergencyAlert: false,
      demoRequested: false,
      quoteRequested: false,
      leadType: "service",
      timeline: null,
      notes: null,
      finished: false
    };
  }
  return callerStore[phone];
}

function sendToMake(data) {
  if (!data.phone || !data.issueSummary) {
    console.log("⚠️ Skipping Make webhook — missing data");
    return;
  }

  const payload = JSON.stringify(data);

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
}

function summarizeIssue(text) {
  text = text.toLowerCase();

  if (text.includes("roof")) return "a roof leak";
  if (text.includes("ceiling")) return "a ceiling leak";
  if (text.includes("water main")) return "a possible water main leak";
  if (text.includes("yard") || text.includes("pooling")) return "water pooling in your yard";
  if (text.includes("faucet")) return "a faucet leak";
  if (text.includes("toilet")) return "a toilet issue";
  if (text.includes("ac")) return "an AC issue";

  return "a service issue";
}

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  if (!caller.demoIntroPlayed) {
    caller.demoIntroPlayed = true;

    twiml.say(
      "Thank you for calling Blue Collar Automation. This is a demo of our AI receptionist. " +
      "Please speak to the system as if you are one of your customers calling your business. " +
      "Let's get this demo started for you."
    );

    twiml.pause({ length: 1 });

    twiml.say("Thank you for calling ABC Company, this is Alex, how can I help you today?");
  }

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/process",
    method: "POST"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/process", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  console.log("Caller said:", speech);

  const lower = speech.toLowerCase();

  // Capture name if said naturally
  if (!caller.name && lower.includes("this is")) {
    const namePart = speech.split("this is")[1];
    if (namePart) {
      caller.name = namePart.trim();
      caller.firstName = caller.name.split(" ")[0];
    }
  }

  // Detect issue
  if (!caller.issueSummary) {
    caller.issueSummary = summarizeIssue(lower);
    caller.issue = speech;

    twiml.say(
      `I can definitely help you with that. It sounds like you have ${caller.issueSummary}. ` +
      `If you would like, I can mark this as an emergency call and have someone get back to you as soon as possible. ` +
      `Would you like me to mark this as an emergency?`
    );

    const gather = twiml.gather({
      input: "speech",
      speechTimeout: "auto",
      action: "/emergency-check",
      method: "POST"
    });

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/emergency-check", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  if (speech.includes("yes") || speech.includes("yeah")) {
    caller.emergencyAlert = true;

    twiml.say(
      `I have marked this as an emergency and will get this to our service team just as soon as I get all your information. ` +
      `Can I start by getting your full name, please?`
    );
  } else {
    caller.emergencyAlert = false;

    twiml.say(
      `Okay, no problem. Let's go ahead and get your information so we can have someone reach out to you about your ${caller.issueSummary}. ` +
      `Can I start by getting your full name, please?`
    );
  }

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/get-name",
    method: "POST"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/get-name", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const speech = req.body.SpeechResult;
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  caller.name = speech;
  caller.firstName = speech.split(" ")[0];

  twiml.say(
    `Thank you, ${caller.firstName}. I'm showing your phone number as ${caller.phone}. ` +
    `Is this a good number to reach you?`
  );

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/confirm-phone",
    method: "POST"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/confirm-phone", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From;

  twiml.say("Great. Let me just get your service address.");

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/get-address",
    method: "POST"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/get-address", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const speech = req.body.SpeechResult;
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  caller.address = speech;

  twiml.say(`Your address is ${caller.address}. Do I have that down right?`);

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/notes",
    method: "POST"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/notes", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  twiml.say(
    "Before I submit this service call, are there any special notes or details you would like me to add to your case?"
  );

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/final",
    method: "POST"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/final", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const phone = req.body.From;
  const caller = getOrCreateCaller(phone);

  if (speech.includes("price") || speech.includes("cost")) {
    twiml.say(
      "Each job is a little different, so pricing depends on several factors. " +
      "One of our team members will go over all of that with you when they call you."
    );
  } else {
    caller.notes = speech;
  }

  twiml.say(
    `Okay, just to recap and make sure I have everything in here correctly. ` +
    `I am submitting a service request for ${caller.issueSummary}. ` +
    `Someone from our service team will contact you shortly. ` +
    `Is there anything else I can do for you today?`
  );

  sendToMake(caller);

  caller.finished = true;

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - ${APP_VERSION}`);
});