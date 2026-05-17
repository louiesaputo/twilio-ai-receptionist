const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithWsStub(request, parent, isMain) {
  if (request === "ws") {
    return { WebSocketServer: class WebSocketServerStub { on() {} } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const serverTestExports = require("./server")._test;
Module._load = originalLoad;

const {
  isChangeContactPersonIntent,
  isPostIntakeContactUpdateIntent,
  isExplicitPostIntakeContactPersonUpdateIntent,
  looksLikeAddressCorrection
} = serverTestExports;

test("address corrections are not hijacked as post-intake contact updates", () => {
  const correction = "Actually, change it to 456 Oak Street";

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
