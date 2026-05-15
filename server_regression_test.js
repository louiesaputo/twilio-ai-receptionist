const assert = require("assert");

process.env.RESPONSE_THINK_DELAY_MS = "0";

const { _test } = require("./server");

function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
}

function waitForSend() {
  return new Promise((resolve) => setTimeout(resolve, 170));
}

async function testContactUpdateResumesAddressCapture() {
  const ws = makeWs();
  const caller = {
    resumeStepAfterPhoneUpdate: "ask_address",
    lastStep: "confirm_contact_person_after_phone_change",
    leadType: "service",
    firstName: "Jane",
    fullName: "Jane Doe"
  };

  _test.afterCallbackDetailsUpdated(ws, caller);
  await waitForSend();

  assert.strictEqual(caller.lastStep, "ask_address");
  assert.strictEqual(caller.resumeStepAfterPhoneUpdate, "");
  assert.strictEqual(ws.sent.length, 1);
  assert.match(ws.sent[0].token, /service address/i);
}

async function testContactUpdateStillFallsBackToNotesWithoutResume() {
  const ws = makeWs();
  const caller = {
    resumeStepAfterPhoneUpdate: "",
    lastStep: "confirm_contact_person_after_phone_change",
    leadType: "service",
    firstName: "Jane",
    fullName: "Jane Doe"
  };

  _test.afterCallbackDetailsUpdated(ws, caller);
  await waitForSend();

  assert.strictEqual(caller.lastStep, "ask_notes");
  assert.strictEqual(ws.sent.length, 1);
  assert.match(ws.sent[0].token, /technician/i);
}

(async () => {
  await testContactUpdateResumesAddressCapture();
  await testContactUpdateStillFallsBackToNotesWithoutResume();
  console.log("server regression tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
