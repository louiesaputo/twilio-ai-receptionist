/*************************************************
 RUN REGRESSION CASES
 PURPOSE:
 - Runs the structured AI extraction cases against ai_extractor.js
 - Verifies the extractor returns the expected intent and key fields
 - Intended to reduce live-call testing during development

 IMPORTANT:
 - Save ai_extractor_structured_phase1_20260409.txt as ai_extractor.js
 - Save regression_cases_structured_phase1_20260409.txt as regression_cases.json
 - Requires OPENAI_API_KEY and AI_INTERPRETER_ENABLED=true if you want live model results
*************************************************/

const fs = require("fs");
const path = require("path");
const {
  extractOpeningTurn,
  interpretPhoneStep,
  interpretAddressStep,
  interpretSchedulingStep
} = require("./ai_extractor");

const casesPath = path.join(__dirname, "regression_cases.json");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));

async function runCase(testCase) {
  let result = null;

  if (testCase.extractor === "opening") {
    result = await extractOpeningTurn(testCase.text, testCase.context || {});
  } else if (testCase.extractor === "phone") {
    result = await interpretPhoneStep(testCase.text, testCase.context || {});
  } else if (testCase.extractor === "address") {
    result = await interpretAddressStep(testCase.text, testCase.context || {});
  } else if (testCase.extractor === "scheduling") {
    result = await interpretSchedulingStep(testCase.text, testCase.context || {});
  } else {
    throw new Error(`Unknown extractor: ${testCase.extractor}`);
  }

  const failures = [];
  const expected = testCase.expected || {};

  if ((expected.intent || "") && (!result || result.intent !== expected.intent)) {
    failures.push(`intent expected "${expected.intent}" but got "${result && result.intent}"`);
  }

  if (expected.full_name_contains && !(result && String(result.full_name || "").toLowerCase().includes(String(expected.full_name_contains).toLowerCase()))) {
    failures.push(`full_name does not contain "${expected.full_name_contains}"`);
  }

  if (expected.issue_contains && !(result && String(result.issue_text || "").toLowerCase().includes(String(expected.issue_contains).toLowerCase()))) {
    failures.push(`issue_text does not contain "${expected.issue_contains}"`);
  }

  if (expected.phone_contains && !(result && String(result.phone_number || "").includes(String(expected.phone_contains)))) {
    failures.push(`phone_number does not contain "${expected.phone_contains}"`);
  }

  if (expected.corrected_contains && !(result && String(result.corrected_address || "").toLowerCase().includes(String(expected.corrected_contains).toLowerCase()))) {
    failures.push(`corrected_address does not contain "${expected.corrected_contains}"`);
  }

  if (expected.alternate_scope && !(result && result.alternate_scope === expected.alternate_scope)) {
    failures.push(`alternate_scope expected "${expected.alternate_scope}" but got "${result && result.alternate_scope}"`);
  }

  return {
    name: testCase.name,
    ok: failures.length === 0,
    failures,
    result
  };
}

async function main() {
  let passed = 0;

  for (const testCase of cases) {
    const outcome = await runCase(testCase);
    if (outcome.ok) {
      passed += 1;
      console.log(`PASS  ${outcome.name}`);
    } else {
      console.log(`FAIL  ${outcome.name}`);
      for (const failure of outcome.failures) {
        console.log(`  - ${failure}`);
      }
      console.log(`  result: ${JSON.stringify(outcome.result)}`);
    }
  }

  console.log("");
  console.log(`Passed ${passed} of ${cases.length} cases.`);
}

main().catch((err) => {
  console.error("Regression runner failed:", err);
  process.exit(1);
});