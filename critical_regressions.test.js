const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadServerInternals() {
  const filename = path.join(__dirname, "server.js");
  const source = `${fs.readFileSync(filename, "utf8")}

module.exports = {
  getOrCreateCaller,
  isFinalQuestionWrapUpAnswer,
  isPostIntakeContactUpdateIntent,
  sendBookingToMake
};`;

  class AccessToken {
    constructor() {}
    addGrant() {}
    toJwt() {
      return "test-token";
    }
  }
  AccessToken.VoiceGrant = class VoiceGrant {};

  const express = function express() {
    const app = function app() {};
    for (const method of ["set", "use", "get", "post"]) {
      app[method] = () => app;
    }
    return app;
  };
  express.static = () => () => {};

  const context = {
    __dirname,
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    clearTimeout,
    console: { error() {}, log() {}, warn() {} },
    module: { exports: {} },
    process: { env: {} },
    require(request) {
      if (request === "express") return express;
      if (request === "http") return { createServer: () => ({ listen() {}, on() {} }) };
      if (request === "twilio") {
        return {
          jwt: { AccessToken },
          twiml: {
            VoiceResponse: class VoiceResponse {
              connect() {
                return { conversationRelay() {} };
              }
              toString() {
                return "<Response />";
              }
            }
          },
          validateRequest: () => true
        };
      }
      if (request === "ws") {
        return {
          WebSocketServer: class WebSocketServer {
            emit() {}
            handleUpgrade() {}
            on() {}
          }
        };
      }
      if (request === "./ai_extractor") {
        return {
          extractOpeningTurn: async () => null,
          interpretAddressStep: async () => null,
          interpretPhoneStep: async () => null,
          interpretSchedulingStep: async () => null
        };
      }
      return require(request);
    },
    setTimeout
  };
  context.exports = context.module.exports;

  vm.runInNewContext(source, context, { filename });
  return { context, internals: context.module.exports };
}

test("final-question wrap-up does not drop substantive corrections", () => {
  const { internals } = loadServerInternals();

  assert.equal(internals.isFinalQuestionWrapUpAnswer("No, my phone number is wrong"), false);
  assert.equal(internals.isFinalQuestionWrapUpAnswer("yes the basement is flooding too"), false);
  assert.equal(internals.isFinalQuestionWrapUpAnswer("no thanks"), true);
  assert.equal(internals.isFinalQuestionWrapUpAnswer("that's all"), true);
  assert.equal(internals.isFinalQuestionWrapUpAnswer("yes"), false);
});

test("post-intake contact updates do not hijack scheduling changes", () => {
  const { internals } = loadServerInternals();

  assert.equal(internals.isPostIntakeContactUpdateIntent("Can we change it to Friday morning?"), false);
  assert.equal(internals.isPostIntakeContactUpdateIntent("Switch it to my wife Sarah"), true);
  assert.equal(internals.isPostIntakeContactUpdateIntent("No, my phone number is wrong"), true);
});

test("overlapped booking submit retries after the in-flight attempt fails", async () => {
  const { context, internals } = loadServerInternals();
  const caller = internals.getOrCreateCaller("booking-retry-test");
  caller.fullName = "Jane Caller";
  caller.callbackNumber = "2035551212";
  caller.issueSummary = "Leaking dishwasher";
  caller.calendarSlotConfirmed = true;
  caller.appointmentDate = "Monday, June 1";
  caller.appointmentTime = "9:00 AM";

  let calls = 0;
  context.postJsonToWebhook = async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    }
    return { statusCode: 200, body: "ok" };
  };

  const first = internals.sendBookingToMake(caller);
  const second = internals.sendBookingToMake(caller);
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(calls, 2);
  assert.equal(caller.bookingSent, true);
});
