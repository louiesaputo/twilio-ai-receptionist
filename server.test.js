const assert = require("assert");

process.env.RESPONSE_THINK_DELAY_MS = "0";

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
