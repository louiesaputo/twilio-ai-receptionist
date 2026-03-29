/*************************************************
 BLUE CALLER AUTOMATION - VOICE SERVER
 VERSION: V75
 DATE: 2026-03-29
 NOTES:
 - Fixed quote flow asking timeline twice
 - Hardened quote payload so leadType/status stay quote
 - Sets quote issueSummary to project type
 - Removed awkward "Hi" from intro
 - Keeps current service/emergency/scheduling flow
*************************************************/

console.log("🔥 BLUE CALLER SERVER V75 LOADED 🔥");

const express = require("express");
const twilio = require("twilio");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "VOICE-FLOW-V75";
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

      leadType: "service",
      projectType: "",
      timeline: "",
      proposalDeadline: "",
      demoEmail: "",

      notes: "",
      status: "new_lead",
      appointmentDate: "",
      appointmentTime: "",
      pendingOfferedDate: "",
      pendingOfferedTime: "",

      makeSent: false,
      lastStep: "ask_issue",
      silenceCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  callerStore[phone].updatedAt = new Date().toISOString();
  return callerStore[phone];
}

function resetCallerForNewCall(caller, phone) {
  caller.phone = phone;
  caller.fullName = null;
  caller.firstName = null;
  caller.callbackNumber = phone;
  caller.callbackConfirmed = null;
  caller.address = null;

  caller.issue = null;
  caller.issueSummary = null;
  caller.urgency = "normal";
  caller.emergencyAlert = false;
  caller.leakNeedsEmergencyChoice = false;

  caller.leadType = "service";
  caller.projectType = "";
  caller.timeline = "";
  caller.proposalDeadline = "";
  caller.demoEmail = "";

  caller.notes = "";
  caller.status = "new_lead";
  caller.appointmentDate = "";
  caller.appointmentTime = "";
  caller.pendingOfferedDate = "";
  caller.pendingOfferedTime = "";

  caller.makeSent = false;
  caller.lastStep = "ask_issue";
  caller.silenceCount = 0;
  caller.updatedAt = new Date().toISOString();
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

  let value = cleanForSpeech(input)
    .replace(/\bcomma\b/gi, "")
    .replace(/\bdot\b/gi, "")
    .replace(/[.,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = value.replace(
    /^(\d)\s+(\d{2,})(\b.*)$/i,
    (match, first, second, rest) => {
      if (second.startsWith(first)) return `${second}${rest}`;
      return match;
    }
  );

  value = value.replace(/^(\d{1,6})\s+\1(\b.*)$/i, "$1$2");

  return value.trim();
}

function cleanName(input) {
  if (!input) return "";
  return cleanForSpeech(input)
    .replace(/^my name is\s+/i, "")
    .replace(/^this is\s+/i, "")
    .replace(/^it is\s+/i, "")
    .replace(/^it's\s+/i, "")
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
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function getFirstName(fullName) {
  if (!fullName) return "";
  return cleanForSpeech(fullName).split(/\s+/)[0] || "";
}

function hasFullName(name) {
  if (!name) return false;
  return cleanForSpeech(name).split(/\s+/).filter(Boolean).length >= 2;
}

function normalizeNameCandidate(rawName) {
  if (!rawName) return "";

  const cleaned = cleanName(rawName).toLowerCase();

  const stopWords = new Set([
    "and",
    "i",
    "have",
    "need",
    "calling",
    "about",
    "with",
    "for",
    "regarding",
    "because",
    "alex"
  ]);

  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !stopWords.has(word))
    .map((word) => word.replace(/[^a-zA-Z'-]/g, ""))
    .filter(Boolean);

  if (words.length === 0 || words.length > 4) return "";

  return toTitleCase(words.join(" "));
}

function stripIssueLeadIn(text) {
  if (!text) return "";
  return cleanForSpeech(text)
    .replace(/^(and\s+)?i\s+have\s+/i, "")
    .replace(/^(and\s+)?i've\s+got\s+/i, "")
    .replace(/^(and\s+)?i\s+need\s+/i, "")
    .replace(/^calling\s+about\s+/i, "")
    .replace(/^calling\s+with\s+/i, "")
    .replace(/^calling\s+for\s+/i, "")
    .replace(/^calling\s+regarding\s+/i, "")
    .replace(/^about\s+/i, "")
    .replace(/^with\s+/i, "")
    .replace(/^regarding\s+/i, "")
    .replace(/^because\s+/i, "")
    .replace(/^for\s+/i, "")
    .trim();
}

function extractOpeningNameAndIssue(text) {
  const original = cleanSpeechText(text || "");
  if (!original) return { name: null, issueText: "" };

  let normalized = original
    .replace(/^(hi|hello|hey)\s*,?\s*alex\s*,?\s*/i, "")
    .replace(/^(hi|hello|hey)\s*,?\s*/i, "")
    .trim();

  const markerPatterns = [
    "this is",
    "my name is",
    "i am",
    "i'm",
    "it is",
    "it's"
  ];

  const issueSeparators = [
    " and i have ",
    " and i've got ",
    " and i need ",
    ", i have ",
    ", i've got ",
    ", i need ",
    " i have ",
    " i've got ",
    " i need ",
    " calling about ",
    " calling with ",
    " calling for ",
    " calling regarding "
  ];

  const lower = normalized.toLowerCase();

  for (const marker of markerPatterns) {
    const markerIndex = lower.indexOf(marker);
    if (markerIndex === -1) continue;

    const afterMarker = normalized.slice(markerIndex + marker.length).trim();
    const afterMarkerLower = afterMarker.toLowerCase();

    for (const separator of issueSeparators) {
      const sepIndex = afterMarkerLower.indexOf(separator);
      if (sepIndex === -1) continue;

      const possibleNameRaw = afterMarker
        .slice(0, sepIndex)
        .trim()
        .replace(/^[,.\-\s]+|[,.\-\s]+$/g, "");
      const issueRaw = afterMarker.slice(sepIndex + separator.length).trim();

      const possibleName = normalizeNameCandidate(possibleNameRaw);
      const issueText = stripIssueLeadIn(issueRaw);

      if (possibleName && issueText) {
        return { name: possibleName, issueText };
      }
    }

    const possibleNameOnly = normalizeNameCandidate(afterMarker);
    if (possibleNameOnly) {
      return { name: possibleNameOnly, issueText: "" };
    }
  }

  return { name: null, issueText: original };
}

function formatPhoneNumberForSpeech(phone) {
  if (!phone) return "unknown";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.substring(1);
  return digits.split("").join(" ");
}

function containsAny(text, phrases) {
  return phrases.some((p) => text.includes(p));
}

function normalizedText(text) {
  return cleanForSpeech(text || "").toLowerCase();
}

function isAffirmative(text) {
  const t = normalizedText(text);

  if (t.includes("not an emergency")) return false;
  if (t.includes("not emergency")) return false;
  if (t.includes("non emergency")) return false;
  if (t.includes("non-emergency")) return false;
  if (t.includes("not urgent")) return false;
  if (t.includes("non urgent")) return false;
  if (t.includes("non-urgent")) return false;

  return (
    t === "yes" ||
    t === "yeah" ||
    t === "yep" ||
    t === "correct" ||
    t === "right" ||
    t === "ok" ||
    t === "okay" ||
    t === "sure" ||
    t.includes("mark it emergency") ||
    t.includes("make it emergency") ||
    t.includes("this is an emergency") ||
    t.includes("it's an emergency") ||
    t.includes("it is an emergency") ||
    t.includes("urgent") ||
    t.includes("as soon as possible") ||
    t.includes("right away") ||
    t.includes("immediately") ||
    t.includes("that works") ||
    t.includes("that would work") ||
    t.includes("that works for me") ||
    t.includes("thatll work") ||
    t.includes("that will work")
  );
}

function isNegative(text) {
  const t = normalizedText(text);

  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("not an emergency") ||
    t.includes("not emergency") ||
    t.includes("non emergency") ||
    t.includes("non-emergency") ||
    t.includes("not urgent") ||
    t.includes("non urgent") ||
    t.includes("non-urgent") ||
    t.includes("standard") ||
    t.includes("normal") ||
    t.includes("regular") ||
    t.includes("during business hours") ||
    t.includes("normal business hours