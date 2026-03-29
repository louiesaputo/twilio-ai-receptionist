console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");
const path = require("path");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V33-BROWSER-CALLING";

// ======== IMPORTANT ========
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/a4sztq97ypc71jc2jsk1kkgqvope891i";

// ======== MIDDLEWARE ========
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// This allows us to host a webpage for browser calling
app.use(express.static("public"));

// ======== TEMP CALLER MEMORY ========
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
      createdAt: now,
    };
  }
  return callerStore[phone];
}

// ======== SEND DATA TO MAKE ========
function sendToMake(data) {
  return new Promise((resolve, reject) => {
    const url = new URL(MAKE_WEBHOOK_URL);

    const payload = JSON.stringify(data);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      },
    };

    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", resolve);
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ======== INCOMING CALL ========
app.post("/incoming-call", (req, res) => {
  console.log("📞 Incoming call");

  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/handle-input",
    method: "POST",
    speechTimeout: "auto",
    timeout: 5,
    bargeIn: true,
  });

  gather.say(
    "Thank you for calling. Please tell me what is going on today."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// ======== HANDLE SPEECH INPUT ========
app.post("/handle-input", async (req, res) => {
  const speech = req.body.SpeechResult || "";
  const phone = req.body.From || "unknown";

  console.log("🗣 Speech:", speech);

  const caller = getOrCreateCaller(phone);

  if (!caller.issue) {
    caller.issue = speech;
    caller.issueSummary = speech;
  }

  // Send to Make
  try {
    await sendToMake(caller);
  } catch (err) {
    console.error("Make error:", err);
  }

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    "Thank you. A team member will review your request and contact you shortly. Goodbye."
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ======== BROWSER TOKEN ROUTE ========
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
    incomingAllow: false,
  });

  token.addGrant(voiceGrant);

  res.json({ token: token.toJwt() });
});

// ======== SERVER START ========
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📦 Version: ${APP_VERSION}`);
});
