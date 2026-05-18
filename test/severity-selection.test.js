const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isEmergencySelection,
  isUrgentNonEmergencyRequest,
  isUrgentSelection
} = require("../server");

test("emergency selection accepts explicit emergency confirmations", () => {
  assert.equal(isEmergencySelection("It's an emergency."), true);
  assert.equal(isEmergencySelection("Mark it as an emergency, please."), true);
});

test("emergency selection rejects negated emergency phrases", () => {
  assert.equal(isEmergencySelection("Not an emergency, just urgent."), false);
  assert.equal(isEmergencySelection("No emergency, regular service is fine."), false);
  assert.equal(isEmergencySelection("Don't mark this as an emergency."), false);
});

test("urgent non-emergency phrasing remains urgent after emergency negation", () => {
  assert.equal(isUrgentSelection("Not an emergency, just urgent."), false);
  assert.equal(isUrgentNonEmergencyRequest("Not an emergency, just urgent."), true);
  assert.equal(isUrgentNonEmergencyRequest("No emergency, but please flag it as urgent."), true);
});
