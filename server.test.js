const assert = require("assert");
const Module = require("module");

process.env.RESPONSE_THINK_DELAY_MS = "0";

const originalLoad = Module._load;

function makeExpressStub() {
  const app = {
    set() {},
    use() {},
    get() {},
    post() {}
  };
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

function makeCaller(resumeStep) {
  return {
    leadType: "service",
    resumeStepAfterPhoneUpdate: resumeStep,
    address: "248 Lake Street, Orlando",
    issueSummary: "a leaking faucet",
    callbackNumber: "9045551212",
    phone: "7146975005"
  };
}

function makeClosedSocket() {
  return {
    readyState: 0,
    send() {
      throw new Error("closed test socket should not send");
    }
  };
}

function assertResumesStep(step) {
  const caller = makeCaller(step);
  __test.afterCallbackDetailsUpdated(makeClosedSocket(), caller);
  assert.strictEqual(caller.lastStep, step);
  assert.strictEqual(caller.resumeStepAfterPhoneUpdate, "");
}

assertResumesStep("confirm_address");
assertResumesStep("ask_address");
assertResumesStep("schedule_or_callback");
assertResumesStep("confirm_first_available");

{
  const caller = makeCaller("ask_notes");
  __test.afterCallbackDetailsUpdated(makeClosedSocket(), caller);
  assert.strictEqual(caller.lastStep, "ask_notes");
  assert.strictEqual(caller.resumeStepAfterPhoneUpdate, "");
}

console.log("server regression tests passed");
