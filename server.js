console.log("🔥 NEW DEPLOY LOADED 🔥");

const express = require("express");
const twilio = require("twilio");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V10.7-TELEPHONY";
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

function getFirstName(fullName) {
  if (!fullName) return "";
  const parts = cleanForSpeech(fullName).split(/\s+/);
  return parts[0] || "";
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
    speechModel: options.speechModel || "telephony",
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

  if (!digits) return "unknown";

  return digits.split("").join(" ");
}

function isYes(text) {
  return /yes|yeah|yep|correct|right|it is|that is right/.test(
    (text || "").toLowerCase()
  );
}

function isNo(text) {
  return /no|nope|wrong|different/.test((text || "").toLowerCase());
}

function isEmergencyPhrase(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("emergency") ||
    t.includes("urgent") ||
    t.includes("urgent service") ||
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
    t.includes("water main") ||
    t.includes("sewage") ||
    t.includes("overflow") ||
    t.includes("sparking") ||
    t.includes("smoke")
  );
}

function detectUrgency(text) {
  return isEmergencyPhrase(text) ? "emergency" : "non-emergency";
}

function issueHasSpecificDetail(issue) {
  const text = (issue || "").toLowerCase();

  const detailKeywords = [
    "leak",
    "leaking",
    "drip",
    "dripping",
    "clogged",
    "running",
    "overflow",
    "overflowing",
    "backing up",
    "backup",
    "slow drain",
    "draining slowly",
    "no hot water",
    "not getting hot water",
    "not cooling",
    "not turning on",
    "not working",
    "blowing cold air",
    "cold air",
    "no power",
    "sparking",
    "making noise",
    "noise",
    "error",
    "not responding",
    "no water",
    "flood",
    "flooding",
    "smell gas"
  ];

  return detailKeywords.some((keyword) => text.includes(keyword));
}

function getFollowUpQuestion(issue) {
  const text = (issue || "").toLowerCase();

  if (issueHasSpecificDetail(text)) {
    return null;
  }

  if (text.includes("faucet")) return "Is the faucet leaking or not turning on?";
  if (text.includes("toilet")) return "Is the toilet clogged, leaking, or running constantly?";
  if (text.includes("water heater")) return "Are you not getting hot water, or is the water heater leaking?";
  if (text.includes("drain")) return "Is the drain completely clogged or draining slowly?";
  if (text.includes("sewer")) return "Is sewage backing up into the house?";
  if (text.includes("water main")) return "Is the water main leaking, or do you have no water at the house?";
  if (text.includes("ac") || text.includes("air conditioner")) return "Is the AC not cooling, or is it not turning on?";
  if (text.includes("heat")) return "Is the heat not working, or is it making noise?";
  if (text.includes("furnace")) return "Is the furnace not turning on, or is it blowing cold air?";
  if (text.includes("thermostat")) return "Is the thermostat not responding, or is it showing an error?";

  return null;
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

  const isBusinessHour = hour >= 8 && hour < 17;

  return isWeekday && isBusinessHour;
}

function getPromptForStep(caller) {
  const spokenNumber = formatPhoneNumberForSpeech(caller.callbackNumber);

  switch (caller.lastStep) {
    case "after_hours_ask_name":
      return "Thank you for calling Blue Caller Automation, this is Alex. Who am I speaking with?";
    case "after_hours_ask_issue":
      return `Hi, ${caller.firstName || "there"}. What can I help you with today?`;
    case "after_hours_emergency_check":
      return "Let me ask, is this an emergency, or is this something that can wait until normal business hours? Our normal business hours are Monday through Friday, 8 AM to 5 PM.";
    case "issue_followup_after_hours":
    case "issue_followup_after_hours_urgent":
    case "issue_followup":
      return getFollowUpQuestion(caller.issue) || "Can you tell me a little more about the problem?";
    case "ask_issue":
      return "Thanks for calling Blue Caller Automation. What is going on today?";
    case "ask_name":
      return "What is your full name?";
    case "confirm_callback":
    case "confirm_callback_after_hours":
      return `I have your callback number as ${spokenNumber}. Is this the best callback number to reach you?`;
    case "ask_callback":
      return "No problem. What is the best callback number to reach you?";
    case "ask_address":
      return "What is the address for the job?";
    case "ask_appt_date":
      return "Do you have a preferred day for the appointment?";
    case "ask_appt_time":
      return "What time of day works best? Morning, afternoon, or a specific time?";
    default:
      return "Please tell me again.";
  }
}

function getRetryPromptForStep(caller) {
  switch (caller.lastStep) {
    case "ask_name":
    case "after_hours_ask_name":
      return "Sorry, I missed your name. What is your full name?";
    case "after_hours_ask_issue":
    case "ask_issue":
      return "Sorry, I missed that. What is going on today?";
    case "confirm_callback":
    case "confirm_callback_after_hours":
      return `Sorry, I missed that. ${getPromptForStep(caller)}`;
    case "ask_callback":
      return "Sorry, I missed that. What is the best callback number to reach you?";
    case "ask_address":
      return "Sorry, I missed that. What is the address for the job?";
    case "ask_appt_date":
      return "Sorry, I missed that. Do you have a preferred day for the appointment?";
    case "ask_appt_time":
      return "Sorry, I missed that. What time of day works best?";
    default:
      return `Sorry, I missed that. ${getPromptForStep(caller)}`;
  }
}

function getGatherOptionsForStep(step) {
  if (step === "ask_name" || step === "after_hours_ask_name") {
    return {
      timeout: 10,
      speechTimeout: "auto",
      speechModel: "telephony",
      language: "en-US",
    };
  }

  return {
    timeout: 8,
    speechTimeout: "auto",
    speechModel: "telephony",
    language: "en-US",
  };
}

async function sendLeadToMake(caller) {
  if (!MAKE_WEBHOOK_URL || MAKE_WEBHOOK_URL.includes("PASTE_YOUR_MAKE_WEBHOOK_URL_HERE")) {
    console.log("[MAKE] Webhook URL not configured. Skipping send.");
    return;
  }

  const payload = {
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
    afterHours: caller.afterHours,
    status: caller.status || "",
  };

  try {
    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const txt = await response.text();
      console.error(`[MAKE] Failed: ${response.status} ${response.statusText} - ${txt}`);
      return;
    }

    console.log("[MAKE] Lead sent successfully.");
  } catch (err) {
    console.error("[MAKE] Error:", err.message);
  }
}

app.get("/", (req, res) => {
  res.send(`Server is running - ${APP_VERSION}`);
});

app.get("/debug/callers", (req, res) => {
  res.json({
    version: APP_VERSION,
    callers: callerStore,
  });
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
  caller.followUpAsked = false;
  caller.retryCount = 0;
  caller.afterHours = !isWithinBusinessHoursEastern();

  if (caller.afterHours) {
    caller.lastStep = "after_hours_ask_name";
  } else {
    caller.lastStep = "ask_issue";
  }

  console.log(`[${APP_VERSION}] incoming-call from ${phone} afterHours=${caller.afterHours}`);

  buildSpeechGather(
    twiml,
    `${baseUrl}/handle-input`,
    getPromptForStep(caller),
    getGatherOptionsForStep(caller.lastStep)
  );

  return res.type("text/xml").send(twiml.toString());
});

app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);
  const phone = req.body.From || "unknown";
  const speech = cleanSpeechText(req.body.SpeechResult || "");
  const caller = getOrCreateCaller(phone);

  console.log(`[${APP_VERSION}] step=${caller.lastStep} speech="${speech}"`);

  if (!speech) {
    caller.retryCount = (caller.retryCount || 0) + 1;

    if (caller.retryCount <= 1) {
      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        getRetryPromptForStep(caller),
        getGatherOptionsForStep(caller.lastStep)
      );
    } else {
      twiml.say({ voice: "alice" }, "I am sorry, I still could not hear you. Please call back.");
      twiml.hangup();
    }

    return res.type("text/xml").send(twiml.toString());
  }

  caller.retryCount = 0;

  if (caller.lastStep === "after_hours_ask_name") {
    caller.name = cleanForSpeech(speech);
    caller.firstName = getFirstName(speech);
    caller.lastStep = "after_hours_ask_issue";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "after_hours_ask_issue") {
    caller.issue = cleanForSpeech(speech);
    caller.urgency = detectUrgency(speech);

    const followUp = getFollowUpQuestion(caller.issue);

    if (caller.urgency === "emergency") {
      if (followUp && !caller.followUpAsked) {
        caller.lastStep = "issue_followup_after_hours_urgent";
        caller.followUpAsked = true;

        buildSpeechGather(
          twiml,
          `${baseUrl}/handle-input`,
          `Got it. I am marking this as urgent. ${followUp}`,
          getGatherOptionsForStep(caller.lastStep)
        );

        return res.type("text/xml").send(twiml.toString());
      }

      caller.lastStep = "confirm_callback_after_hours";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        `Got it. I am marking this as urgent. ${getPromptForStep(caller)}`,
        getGatherOptionsForStep(caller.lastStep)
      );

      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "after_hours_emergency_check";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "after_hours_emergency_check") {
    const lowered = speech.toLowerCase();

    if (lowered.includes("emergency")) {
      caller.urgency = "emergency";
    } else if (lowered.includes("wait") || lowered.includes("can wait")) {
      if (!caller.urgency) caller.urgency = "non-emergency";
    } else if (isEmergencyPhrase(speech)) {
      caller.urgency = "emergency";
    } else if (!caller.urgency) {
      caller.urgency = "non-emergency";
    }

    const followUp = getFollowUpQuestion(caller.issue);

    if (followUp && !caller.followUpAsked) {
      caller.lastStep = "issue_followup_after_hours";
      caller.followUpAsked = true;

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        followUp,
        getGatherOptionsForStep(caller.lastStep)
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "confirm_callback_after_hours";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "issue_followup_after_hours" || caller.lastStep === "issue_followup_after_hours_urgent") {
    caller.issue = `${cleanForSpeech(caller.issue)} - ${cleanForSpeech(speech)}`;
    caller.lastStep = "confirm_callback_after_hours";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_issue") {
    caller.issue = cleanForSpeech(speech);
    caller.urgency = detectUrgency(speech);

    const followUp = getFollowUpQuestion(caller.issue);

    if (followUp && !caller.followUpAsked) {
      caller.lastStep = "issue_followup";
      caller.followUpAsked = true;

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        followUp,
        getGatherOptionsForStep(caller.lastStep)
      );
      return res.type("text/xml").send(twiml.toString());
    }

    caller.lastStep = "ask_name";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "issue_followup") {
    caller.issue = `${cleanForSpeech(caller.issue)} - ${cleanForSpeech(speech)}`;
    caller.lastStep = "ask_name";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_name") {
    caller.name = cleanForSpeech(speech);
    caller.firstName = getFirstName(speech);
    caller.lastStep = "confirm_callback";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "confirm_callback" || caller.lastStep === "confirm_callback_after_hours") {
    if (isYes(speech)) {
      caller.callbackConfirmed = true;
      caller.lastStep = "ask_address";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        getPromptForStep(caller),
        getGatherOptionsForStep(caller.lastStep)
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (isNo(speech)) {
      caller.callbackConfirmed = false;
      caller.lastStep = "ask_callback";

      buildSpeechGather(
        twiml,
        `${baseUrl}/handle-input`,
        getPromptForStep(caller),
        getGatherOptionsForStep(caller.lastStep)
      );
      return res.type("text/xml").send(twiml.toString());
    }

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_callback") {
    caller.callbackNumber = cleanForSpeech(speech);
    caller.lastStep = "ask_address";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_address") {
    caller.address = cleanForSpeech(speech);
    caller.lastStep = "ask_appt_date";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_appt_date") {
    caller.appointmentDate = cleanForSpeech(speech);
    caller.lastStep = "ask_appt_time";

    buildSpeechGather(
      twiml,
      `${baseUrl}/handle-input`,
      getPromptForStep(caller),
      getGatherOptionsForStep(caller.lastStep)
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (caller.lastStep === "ask_appt_time") {
    caller.appointmentTime = cleanForSpeech(speech);
    caller.lastStep = "complete";
    caller.status = "complete";

    if (caller.afterHours) {
      if (caller.urgency === "emergency") {
        twiml.say(
          { voice: "alice" },
          `Perfect, ${caller.firstName}. I have marked this as urgent so someone can reach out as soon as possible.`
        );
      } else {
        twiml.say(
          { voice: "alice" },
          `Perfect, ${caller.firstName}. Someone from the office will call you during normal business hours to confirm the appointment.`
        );
      }
    } else {
      if (caller.urgency === "emergency") {
        twiml.say(
          { voice: "alice" },
          `Perfect, ${caller.firstName}. I have marked this as urgent so someone can reach out as soon as possible.`
        );
      } else {
        twiml.say(
          { voice: "alice" },
          `Perfect, ${caller.firstName}. We will call to confirm your appointment time shortly.`
        );
      }
    }

    await sendLeadToMake(caller);
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());
  }

  caller.status = "error";
  twiml.say({ voice: "alice" }, "Something went wrong. Please call back.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} - ${APP_VERSION}`);
});