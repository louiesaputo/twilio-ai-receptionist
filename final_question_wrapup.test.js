"use strict";

const assert = require("assert");
const { __test } = require("./server");

const wrapUp = __test.isFinalQuestionWrapUpAnswer;

[
  "no",
  "no thanks",
  "nothing else",
  "that's all",
  "yeah, that's all",
  "okay bye",
].forEach((phrase) => {
  assert.strictEqual(wrapUp(phrase), true, `"${phrase}" should close the final question`);
});

[
  "yes",
  "yeah",
  "sure",
  "okay",
  "yes, also the sink is leaking",
  "No, also tell them the side door is unlocked",
  "no the gate code is 1234",
].forEach((phrase) => {
  assert.strictEqual(wrapUp(phrase), false, `"${phrase}" should be captured as an added note`);
});

console.log("final_question_wrapup.test.js passed");
