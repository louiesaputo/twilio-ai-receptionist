const assert = require("assert");
const Module = require("module");

process.env.RESPONSE_THINK_DELAY_MS = "0";

const originalLoad = Module._load;

function makeExpressStub() {
  const app = function app(_req, _res) {};
  app.set = function set() {};
  app.use = function use() {};
  app.get = function get() {};
  app.post = function post() {};
  return app;
}

makeExpressStub.urlencoded = () => (_req, _res, next) => {
  if (typeof next === "function") next();
};
makeExpressStub.json = () => (_req, _res, next) => {
  if (typeof next === "function") next();
};
makeExpressStub.static = () => (_req, _res, next) => {
  if (typeof next === "function") next();
};

class AccessTokenStub {
  addGrant() {}
  toJwt() {
    return "test-token";
  }
}

AccessTokenStub.VoiceGrant = class VoiceGrantStub {};

class VoiceResponseStub {
  connect() {
    return { conversationRelay() {} };
  }
  toString() {
    return "<Response/>";
  }
}

Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (request === "express") return makeExpressStub;
  if (request === "twilio") {
    return {
      jwt: { AccessToken: AccessTokenStub },
      twiml: { VoiceResponse: VoiceResponseStub },
      validateRequest: () => true
    };
  }
  if (request === "ws") {
    return {
      WebSocketServer: class WebSocketServerStub {
        on() {}
        handleUpgrade(_request, _socket, _head, callback) {
          callback({});
        }
        emit() {}
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { __test } = require("./server");

function makeWs() {
  return {
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
  };
}

function withImmediateTimers(fn) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => {
    callback();
    return 0;
  };
  try {
    fn();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

function testContactUpdateResumesSchedulingStep() {
  const ws = makeWs();
  const caller = {
    resumeStepAfterPhoneUpdate: "ask_appointment_day",
    lastStep: "capture_updated_callback_number",
    leadType: "service",
    issueSummary: "leaky faucet"
  };

  withImmediateTimers(() => {
    __test.afterCallbackDetailsUpdated(ws, caller);
  });

  assert.strictEqual(caller.lastStep, "ask_appointment_day");
  assert.strictEqual(caller.resumeStepAfterPhoneUpdate, "");
  assert.strictEqual(ws.sent.length, 1);
  assert.match(ws.sent[0].token, /updated the callback number/i);
  assert.match(ws.sent[0].token, /what day works best/i);
  assert.doesNotMatch(ws.sent[0].token, /technician/i);
}

testContactUpdateResumesSchedulingStep();
console.log("server regression tests passed");
