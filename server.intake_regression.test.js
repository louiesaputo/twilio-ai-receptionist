const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("./server");

test("complete Connecticut service addresses accept CT before ZIP", () => {
  const result = __test.analyzeUsServiceAddressCompleteness("123 Main St, Hartford, CT 06103");
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("street suffix Ct does not satisfy a missing state", () => {
  const result = __test.analyzeUsServiceAddressCompleteness("123 Main Ct, Hartford, 06103");
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("state"));
});

test("final question preserves no-prefixed additional details", () => {
  assert.equal(__test.isFinalQuestionWrapUpAnswer("No, but please add gate code 1234"), false);
  assert.equal(__test.isFinalQuestionWrapUpAnswer("No, and the leak is also in the basement"), false);
});

test("final question still closes on explicit wrap-up answers", () => {
  assert.equal(__test.isFinalQuestionWrapUpAnswer("No thanks"), true);
  assert.equal(__test.isFinalQuestionWrapUpAnswer("No, that's all"), true);
  assert.equal(__test.isFinalQuestionWrapUpAnswer("Goodbye"), true);
});
