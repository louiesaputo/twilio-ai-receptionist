/**
 * Deterministic regression for US address completeness + incremental merge logic.
 * No API keys; shared implementation lives in address_validation.js (same as server.js imports).
 */

const fs = require("fs");
const path = require("path");
const {
  analyzeUsServiceAddressCompleteness,
  mergeIncrementalServiceAddress,
} = require("./address_validation");

const casesPath = path.join(__dirname, "address_validation_cases.json");

function checkExpect(result, expect) {
  const failures = [];
  if (!expect || typeof expect !== "object") return failures;

  if (Object.prototype.hasOwnProperty.call(expect, "ok") && Boolean(result.ok) !== Boolean(expect.ok)) {
    failures.push(`expected ok=${expect.ok} but got ok=${result.ok}`);
  }

  if (expect.missing_includes && expect.missing_includes.length) {
    for (const key of expect.missing_includes) {
      if (!result.missing.includes(key)) {
        failures.push(`expected missing to include "${key}" but missing=${JSON.stringify(result.missing)}`);
      }
    }
  }

  return failures;
}

function runAnalyzeCase(tc) {
  const result = analyzeUsServiceAddressCompleteness(tc.address);
  return checkExpect(result, tc.expect || {});
}

function runMergeCase(tc) {
  const merged = mergeIncrementalServiceAddress(tc.previous || "", tc.utterance || "");
  const chk = analyzeUsServiceAddressCompleteness(merged);

  let failures = checkExpect(chk, tc.expect || {});

  if (tc.merged_must_include && Array.isArray(tc.merged_must_include)) {
    const lower = merged.toLowerCase();
    for (const frag of tc.merged_must_include) {
      if (!lower.includes(String(frag).toLowerCase())) {
        failures.push(`merged string should include "${frag}" but merged=${JSON.stringify(merged)}`);
      }
    }
  }

  return { failures, merged, chk };
}

function main() {
  let passed = 0;
  let total = 0;

  let cases;
  try {
    cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  } catch (err) {
    console.error("Could not load address_validation_cases.json:", err.message);
    process.exit(1);
  }

  for (const tc of cases) {
    total += 1;
    let failures;

    if (tc.merge) {
      const out = runMergeCase(tc);
      failures = out.failures;
    } else {
      failures = runAnalyzeCase(tc);
    }

    if (failures.length === 0) {
      passed += 1;
      console.log(`PASS  ${tc.name}`);
    } else {
      console.log(`FAIL  ${tc.name}`);
      for (const f of failures) console.log(`  - ${f}`);
    }
  }

  console.log("");
  console.log(`Passed ${passed} of ${total} address validation cases.`);
  if (passed < total) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error("address validation regression failed:", err);
  process.exit(1);
}
