"use strict";

const assert = require("assert");

const {
  normalizeAddressInput,
  analyzeUsServiceAddressCompleteness,
  mergeIncrementalServiceAddress
} = require("./address_validation");

assert.strictEqual(
  normalizeAddressInput("123 123 Main Street comma Springfield Illinois 62704."),
  "123 Main Street, Springfield Illinois 62704"
);

assert.deepStrictEqual(
  analyzeUsServiceAddressCompleteness("123 Main Street, Springfield, IL 62704").missing,
  []
);

assert.deepStrictEqual(
  analyzeUsServiceAddressCompleteness("123 Main Street, Springfield").missing,
  ["state", "zip"]
);

assert.deepStrictEqual(
  analyzeUsServiceAddressCompleteness("PO Box 42, New York, NY 10001").missing,
  []
);

assert.strictEqual(
  mergeIncrementalServiceAddress("123 Main Street", "Springfield Illinois 62704"),
  "123 Main Street, Springfield Illinois 62704"
);

assert.strictEqual(
  mergeIncrementalServiceAddress("123 Main Street, Springfield, IL 62704", "456 Oak Avenue"),
  "456 Oak Avenue, Springfield, IL 62704"
);

require("./usps_address_verify");

console.log("address_validation tests passed");
