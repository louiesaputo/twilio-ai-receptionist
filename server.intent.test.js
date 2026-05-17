const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isChangeContactPersonIntent,
  isPostIntakeContactUpdateIntent,
  isExplicitPostIntakeContactPersonUpdateIntent,
  looksLikeAddressCorrection
} = require("./server")._test;

test("address corrections are not hijacked as post-intake contact updates", () => {
  const correction = "No, change it to 456 Oak Street";

  assert.equal(isChangeContactPersonIntent(correction), true);
  assert.equal(isPostIntakeContactUpdateIntent(correction), false);
  assert.equal(looksLikeAddressCorrection(correction), true);
});

test("explicit contact-name updates still trigger the post-intake contact flow", () => {
  assert.equal(
    isExplicitPostIntakeContactPersonUpdateIntent("Please change the contact name to Sarah Connor"),
    true
  );
  assert.equal(
    isPostIntakeContactUpdateIntent("Please change the contact name to Sarah Connor"),
    true
  );
});
