const assert = require("node:assert/strict");
const test = require("node:test");

process.env.INTAKE_VERTICAL = "appliance";

const { __test } = require("./server");

test("post-intake scheduling changes are not treated as contact updates", () => {
  assert.equal(__test.isPostIntakeContactUpdateIntent("Can we change it to Thursday afternoon?"), false);
  assert.equal(__test.isPostIntakeContactUpdateIntent("I'd like to change my appointment to next Monday."), false);
});

test("explicit post-intake contact updates still route to contact capture", () => {
  assert.equal(__test.isPostIntakeContactUpdateIntent("Please change my callback number."), true);
  assert.equal(__test.isPostIntakeContactUpdateIntent("Can you change the contact person to Jane Doe?"), true);
});

test("appliance water leaks are not suppressed from leak emergency triage", () => {
  assert.equal(__test.shouldSuppressHomeLeakEmergencyForApplianceIssue("My dishwasher is leaking water all over the floor."), false);
  assert.equal(__test.shouldSuppressHomeLeakEmergencyForApplianceIssue("The washer is not draining and is out of warranty."), true);
});
