const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function loadWithTestStubs(request, parent, isMain) {
  if (request === "ws") {
    return {
      WebSocketServer: class WebSocketServer {
        constructor() {}
        on() {}
        handleUpgrade(_request, _socket, _head, callback) {
          if (typeof callback === "function") callback({});
        }
        emit() {}
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.INTAKE_VERTICAL = "appliance";
process.env.RESPONSE_THINK_DELAY_MS = "0";

const {
  __test: {
    afterCallbackDetailsUpdated,
    getOrCreateCaller,
    handlePrompt,
    isPostIntakeContactUpdateIntent
  }
} = require("../server");

function freshCaller(key) {
  return getOrCreateCaller(key);
}

function fakeWs(sessionKey) {
  return {
    readyState: 0,
    sessionKey,
    send() {}
  };
}

async function run() {
  assert.strictEqual(
    isPostIntakeContactUpdateIntent("I'd like to change it to Thursday afternoon"),
    false,
    "scheduling changes should not be treated as contact updates"
  );
  assert.strictEqual(
    isPostIntakeContactUpdateIntent("I'd like to change my contact number"),
    true,
    "explicit contact-number changes should still route to contact update"
  );

  {
    const caller = freshCaller("resume-scheduling-after-phone-update");
    caller.resumeStepAfterPhoneUpdate = "ask_appointment_time";
    caller.lastStep = "capture_updated_callback_number";

    afterCallbackDetailsUpdated(fakeWs(caller.sessionKey), caller);

    assert.strictEqual(
      caller.lastStep,
      "ask_appointment_time",
      "contact updates should resume the saved scheduling step instead of skipping to notes"
    );
  }

  {
    const caller = freshCaller("appliance-hard-emergency-exit");
    caller.lastStep = "appliance_service_intake";
    caller.leadType = "service";
    caller.issue = "My refrigerator is not cooling";
    caller.issueSummary = "a refrigerator that is not cooling";
    caller.applianceIntakeMergedIssue = caller.issue;
    caller.applianceTypeDetail = "refrigerator";
    caller.applianceSymptomCaptured = true;

    await handlePrompt(fakeWs(caller.sessionKey), caller, "Actually a pipe burst and the kitchen is flooding");

    assert.strictEqual(caller.emergencyAlert, true, "hard emergencies during appliance intake should be marked immediately");
    assert.notStrictEqual(caller.lastStep, "appliance_service_intake", "hard emergencies should exit appliance detail intake");
  }

  {
    const caller = freshCaller("appliance-coverage-affirmative-exit");
    caller.lastStep = "appliance_service_intake";
    caller.leadType = "service";
    caller.issue = "My refrigerator is not cooling";
    caller.issueSummary = "a refrigerator that is not cooling";
    caller.applianceIntakeMergedIssue = caller.issue;
    caller.applianceTypeDetail = "refrigerator";
    caller.applianceSymptomCaptured = true;

    await handlePrompt(fakeWs(caller.sessionKey), caller, "yes");

    assert.strictEqual(caller.applianceCoverage, "unknown", "ambiguous coverage confirmations should not trap callers");
    assert.notStrictEqual(caller.lastStep, "appliance_service_intake", "coverage-only ambiguity should proceed to contact collection");
  }
}

run()
  .then(() => {
    console.log("critical correctness tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
