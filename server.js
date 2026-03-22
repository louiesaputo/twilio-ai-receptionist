console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const fetch = require("node-fetch");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V12-STABLE";
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
      firstName: null,
      lastName: null,
      name: null,
      callbackNumber: null,
      callbackConfirmed: null,
      address: null,
      urgency: null,
      appointmentDate: null,
      appointmentTime: null,
      status: null,
      lastStep: null,
      followUpAsked: false,
      afterHours: false,
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
  return input.replace(/[.,]+$/g, "").trim();
}

function cleanNamePart(input) {
  return cleanForSpeech(input)
    .replace(/^my first name is\s+/i, "")
    .replace(/^my last name is\s+/i, "")
    .replace(/^my name is\s+/i, "")
    .replace(/^this is\s+/i, "")
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
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function rebuildFullName(caller) {
  caller.firstName = toTitleCase(caller.firstName);
  caller.lastName = toTitleCase(caller.lastName);
  caller.name = [caller.firstName, caller.lastName].filter(Boolean).join(" ").trim();
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
    language: options.language || "en-US",
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
  return /yes|yeah|yep|correct|right|it is|that is right/.test((text || "").toLowerCase());
}

function isNo(text) {
  return /no|nope|wrong|different/.test((text || "").toLowerCase());
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
    t.includes("gas leak") ||
    t.includes("no heat") ||
    t.includes("no water") ||
    t.includes("sewage") ||
    t.includes("sparking") ||
    t.includes("smoke")
  );
}

function detectUrgency(text) {
  return isEmergencyPhrase(text) ? "emergency" : "non-emergency";
}

function isWithinBusinessHoursEastern() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");

  const isWeekday =
    weekday === "Mon" ||
    weekday === "Tue" ||
    weekday === "Wed" ||
    weekday === "Thu" ||
    weekday === "Fri";

  return isWeekday && hour >= 8 && hour < 17;
}

function parseAppointmentResponse(text) {
  const lowered = (text || "").toLowerCase();
  let date = null;
  let time = null;

  if (lowered.includes("today")) date = "today";
  else if (lowered.includes("tomorrow")) date = "tomorrow";
  else if (lowered.includes("next week")) date = "next week";

  if (lowered.includes("first thing")) time = "first thing in the morning";
  else if (lowered.includes("morning")) time = "morning";
  else if (lowered.includes("afternoon")) time = "afternoon";

  return { date, time };
}

async function sendLeadToMake(caller) {
  try {
    await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone: caller.phone,
        fullName: caller.name,
        firstName: caller.firstName,
        lastName: caller.lastName,
        callbackNumber: caller.callbackNumber,
        address: caller.address,
        issue: caller.issue,
        urgency: caller.urgency,
        appointmentDate: caller.appointmentDate,
        appointmentTime: caller.appointmentTime,
        afterHours: caller.afterHours,
        status: caller.status,
      }),
    });
    console.log("[MAKE] Lead sent");
  } catch (err) {
    console.error("[MAKE ERROR]", err.message);
  }
}

/* ===================== ROUTES ===================== */

app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const caller = getOrCreateCaller(phone);

  caller.callbackNumber = phone;
  caller.afterHours = !isWithinBusinessHoursEastern();
  caller.lastStep = caller.afterHours ? "ask_first_name" : "ask_issue";

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    caller.afterHours
      ? "Thank you for calling Blue Caller Automation, this is Alex. What is your first name?"
      : "Thanks for calling Blue Caller Automation. What is going on today?"
  );

  return res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  if (!speech) {
    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      "Sorry, I missed that. Please say that again."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_issue") {
    caller.issue = speech;
    caller.urgency = detectUrgency(speech);
    caller.lastStep = "ask_first_name";

    buildSpeechGather(twiml, `${baseUrl}/handle-input`, "What is your first name?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_first_name") {
    caller.firstName = cleanNamePart(speech);
    caller.lastStep = "ask_last_name";

    buildSpeechGather(twiml, `${baseUrl}/handle-input`, "And your last name?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_last_name") {
    caller.lastName = cleanNamePart(speech);
    rebuildFullName(caller);
    caller.lastStep = "ask_address";

    buildSpeechGather(twiml, `${baseUrl}/handle-input`, "What is the address for the job?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_address") {
    caller.address = speech;
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

    await sendLeadToMake(caller);

    twiml.say(
      { voice: "alice" },
      `Thank you ${caller.firstName || ""}. This call has been marked ${
        caller.urgency === "emergency" ? "urgent" : "for normal service"
      }. Someone will call you shortly to confirm the appointment.`
    );

    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Sorry, something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});