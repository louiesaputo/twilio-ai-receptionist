/*************************************************
 AI EXTRACTOR PHASE 1
 PURPOSE:
 - Structured AI extraction for the key caller-response steps that have been causing repeated regressions
 - Keeps the server state machine in control
 - Uses OpenAI Structured Outputs through the Chat Completions API
 - Falls back cleanly to deterministic logic if AI is disabled, unavailable, or times out

 REQUIRED ENV VARS:
 - OPENAI_API_KEY
 - AI_INTERPRETER_ENABLED=true

 OPTIONAL ENV VARS:
 - AI_INTERPRETER_MODEL          (default: gpt-4o-mini)
 - AI_INTERPRETER_TIMEOUT_MS     (default: 2500)

 IMPORTANT:
 - Requires the `openai` package:
     npm install openai
*************************************************/

let OpenAI = null;
try {
  const openaiPkg = require("openai");
  OpenAI = openaiPkg.default || openaiPkg;
} catch (err) {
  OpenAI = null;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const AI_INTERPRETER_ENABLED = String(process.env.AI_INTERPRETER_ENABLED || "false").toLowerCase() === "true";
const AI_INTERPRETER_MODEL = process.env.AI_INTERPRETER_MODEL || "gpt-4o-mini";
const AI_INTERPRETER_TIMEOUT_MS = Number(process.env.AI_INTERPRETER_TIMEOUT_MS || 2500);

let client = null;

function canUseAI() {
  return Boolean(AI_INTERPRETER_ENABLED && OPENAI_API_KEY && OpenAI);
}

function getClient() {
  if (!canUseAI()) return null;
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI extractor timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function coerceBoolean(value) {
  return value === true;
}

function parseJsonContent(messageContent) {
  if (typeof messageContent === "string") {
    return JSON.parse(messageContent);
  }

  if (Array.isArray(messageContent)) {
    const textPart = messageContent.find((part) => part && part.type === "text" && typeof part.text === "string");
    if (textPart) return JSON.parse(textPart.text);
  }

  return null;
}

async function runStructuredExtraction({ schemaName, schema, developerPrompt, payload }) {
  const aiClient = getClient();
  if (!aiClient) return null;

  try {
    const completion = await withTimeout(
      aiClient.chat.completions.create({
        model: AI_INTERPRETER_MODEL,
        temperature: 0,
        messages: [
          { role: "developer", content: developerPrompt },
          { role: "user", content: JSON.stringify(payload) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            strict: true,
            schema
          }
        }
      }),
      AI_INTERPRETER_TIMEOUT_MS
    );

    const message = completion && completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message
      : null;

    if (!message || message.refusal) return null;
    return parseJsonContent(message.content);
  } catch (err) {
    console.error("[AI EXTRACTOR ERROR]", err.message);
    return null;
  }
}

const OPENING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["name_plus_issue", "name_only", "issue_only", "social_greeting_only", "unclear"]
    },
    full_name: { type: "string" },
    first_name: { type: "string" },
    issue_text: { type: "string" },
    lead_type_guess: {
      type: "string",
      enum: ["service", "emergency", "quote", "demo", "unknown"]
    },
    emergency_candidate: { type: "boolean" }
  },
  required: ["intent", "full_name", "first_name", "issue_text", "lead_type_guess", "emergency_candidate"]
};

const PHONE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["confirm_existing_phone", "request_phone_change", "provide_new_phone_number", "yes_waiting_for_number", "reject_phone", "unclear"]
    },
    phone_number: { type: "string" }
  },
  required: ["intent", "phone_number"]
};

const ADDRESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["confirm_address", "reject_address", "correct_address", "unclear"]
    },
    corrected_address: { type: "string" }
  },
  required: ["intent", "corrected_address"]
};

const SCHEDULING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["accept_offered_time", "reject_offered_time", "request_alternate_time", "request_first_available", "request_office_callback", "unclear"]
    },
    alternate_scope: {
      type: "string",
      enum: ["same_day_later", "next_day", "generic", "none"]
    },
    requested_time_preference: {
      type: "string",
      enum: ["morning", "afternoon", "evening", "anytime", "none"]
    }
  },
  required: ["intent", "alternate_scope", "requested_time_preference"]
};

async function extractOpeningTurn(text, callerContext = {}) {
  const result = await runStructuredExtraction({
    schemaName: "opening_turn_extraction_v1",
    schema: OPENING_SCHEMA,
    developerPrompt: [
      "You extract structured meaning from the very first caller utterance in a phone receptionist flow.",
      "Return only schema-matching JSON.",
      "Classify the utterance as one of:",
      "- name_plus_issue: the caller gave both an identifying name and a real service/demo/quote issue or request",
      "- name_only: the caller only identified themselves and did not give a real issue/request",
      "- issue_only: the caller gave an issue/request but no usable name",
      "- social_greeting_only: the caller only gave a greeting or small talk and no real issue/request",
      "- unclear: you genuinely cannot tell",
      "Rules:",
      "- Populate full_name and first_name only if the caller actually gave a name.",
      "- Populate issue_text only if the caller actually gave a real issue/request.",
      "- Do not copy greeting words into issue_text.",
      "- lead_type_guess should be service, emergency, quote, demo, or unknown.",
      "- emergency_candidate should only be true when the caller appears to describe an urgent/emergency situation."
    ].join(" "),
    payload: {
      caller_text: text,
      caller_context: callerContext
    }
  });

  if (!result) return null;
  return {
    intent: cleanString(result.intent),
    full_name: cleanString(result.full_name),
    first_name: cleanString(result.first_name),
    issue_text: cleanString(result.issue_text),
    lead_type_guess: cleanString(result.lead_type_guess),
    emergency_candidate: coerceBoolean(result.emergency_candidate)
  };
}

async function interpretPhoneStep(text, callerContext = {}) {
  const result = await runStructuredExtraction({
    schemaName: "phone_step_extraction_v1",
    schema: PHONE_SCHEMA,
    developerPrompt: [
      "You interpret caller responses during phone-number confirmation and phone-number collection steps in a receptionist workflow.",
      "Return only schema-matching JSON.",
      "Classify the utterance as one of:",
      "- confirm_existing_phone: caller confirms the current number is good",
      "- request_phone_change: caller wants to change the number but does not give the new one",
      "- provide_new_phone_number: caller provides a new callback number",
      "- yes_waiting_for_number: caller says yes but has not actually provided the number yet",
      "- reject_phone: caller rejects the current number without giving a new one",
      "- unclear: you cannot tell",
      "Rules:",
      "- If the caller both asks to change and provides the new number, intent must be provide_new_phone_number and phone_number must contain the new number.",
      "- If the current step is get_new_phone and the caller only says yes, use yes_waiting_for_number.",
      "- If the caller confirms a number that already exists, use confirm_existing_phone.",
      "- Extract phone_number as the callback number only when a new one is actually spoken."
    ].join(" "),
    payload: {
      caller_text: text,
      caller_context: callerContext
    }
  });

  if (!result) return null;
  return {
    intent: cleanString(result.intent),
    phone_number: cleanString(result.phone_number)
  };
}

async function interpretAddressStep(text, callerContext = {}) {
  const result = await runStructuredExtraction({
    schemaName: "address_step_extraction_v1",
    schema: ADDRESS_SCHEMA,
    developerPrompt: [
      "You interpret caller responses after the receptionist reads back an address and asks if it is correct.",
      "Return only schema-matching JSON.",
      "Classify the utterance as one of:",
      "- confirm_address: the caller confirms the address is correct",
      "- reject_address: the caller rejects the address and wants it re-entered",
      "- correct_address: the caller provides a changed or corrected address",
      "- unclear: you cannot tell",
      "Rules:",
      "- Phrases like 'it is', 'yes that's correct', 'that's right', and 'correct' must be confirm_address.",
      "- Do not treat those pure confirmations as corrected_address.",
      "- Only use corrected_address when the caller actually provides changed address content."
    ].join(" "),
    payload: {
      caller_text: text,
      caller_context: callerContext
    }
  });

  if (!result) return null;
  return {
    intent: cleanString(result.intent),
    corrected_address: cleanString(result.corrected_address)
  };
}

async function interpretSchedulingStep(text, callerContext = {}) {
  const result = await runStructuredExtraction({
    schemaName: "scheduling_step_extraction_v1",
    schema: SCHEDULING_SCHEMA,
    developerPrompt: [
      "You interpret caller responses after a receptionist offers a callback slot or asks about callback scheduling.",
      "Return only schema-matching JSON.",
      "Classify the utterance as one of:",
      "- accept_offered_time: caller accepts the offered slot",
      "- reject_offered_time: caller rejects the offered slot",
      "- request_alternate_time: caller asks for another time",
      "- request_first_available: caller asks for the earliest / first available time",
      "- request_office_callback: caller wants the office to call them instead of booking now",
      "- unclear: you cannot tell",
      "Rules:",
      "- Phrases like 'yeah that'll work', 'yes that works', 'book it', and 'schedule it' should be accept_offered_time.",
      "- Requests for another time later that day should set alternate_scope to same_day_later.",
      "- Requests for the next day should set alternate_scope to next_day.",
      "- Generic alternate requests should set alternate_scope to generic.",
      "- If there is no alternate request, alternate_scope should be none.",
      "- requested_time_preference should be morning, afternoon, evening, anytime, or none."
    ].join(" "),
    payload: {
      caller_text: text,
      caller_context: callerContext
    }
  });

  if (!result) return null;
  return {
    intent: cleanString(result.intent),
    alternate_scope: cleanString(result.alternate_scope),
    requested_time_preference: cleanString(result.requested_time_preference)
  };
}

module.exports = {
  extractOpeningTurn,
  interpretPhoneStep,
  interpretAddressStep,
  interpretSchedulingStep
};