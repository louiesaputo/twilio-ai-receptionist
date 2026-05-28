"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHelpers() {
  const serverPath = path.join(__dirname, "server.js");
  let source = fs.readFileSync(serverPath, "utf8");
  source = source.replace(
    /server\.listen\(PORT, BIND_HOST, \(\) => \{\n  console\.log\(`Server listening on \$\{BIND_HOST\}:\$\{PORT\} \(\$\{APP_VERSION\}\)`\);\n\}\);\s*$/,
    `module.exports.__test = {
  analyzeUsServiceAddressCompleteness,
  isFinalQuestionWrapUpAnswer
};
`
  );

  function sandboxRequire(request) {
    if (request === "ws") {
      return {
        WebSocketServer: class {
          constructor() {}
          on() {}
          handleUpgrade() {}
        }
      };
    }
    return require(request);
  }

  const sandbox = {
    require: sandboxRequire,
    module: { exports: {} },
    exports: null,
    console: { log() {}, error() {}, warn() {} },
    process: { ...process, env: { ...process.env, PORT: "0" } },
    __dirname,
    __filename: serverPath,
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox, { filename: serverPath });
  return sandbox.module.exports.__test;
}

const helpers = loadServerHelpers();
assert(helpers, "expected server helpers to load");

{
  const result = helpers.analyzeUsServiceAddressCompleteness("123 Main St, Hartford, CT 06103");
  assert.equal(result.ok, true, "Connecticut abbreviation should count as a complete state");
}

{
  const result = helpers.analyzeUsServiceAddressCompleteness("123 Main Ct, Hartford, 06103");
  assert.equal(result.ok, false, "street suffix Court must not be mistaken for Connecticut");
  assert(result.missing.includes("state"), "missing facets should include state");
}

assert.equal(
  helpers.isFinalQuestionWrapUpAnswer("No, one more thing -- the gate code is 4739"),
  false,
  "final-question extra details after a leading no should be captured, not treated as hangup"
);

assert.equal(
  helpers.isFinalQuestionWrapUpAnswer("Yes, actually please note the dog is loose"),
  false,
  "final-question extra details after a leading yes should be captured"
);

assert.equal(
  helpers.isFinalQuestionWrapUpAnswer("No, that's all"),
  true,
  "clear no-more-details answer should still close"
);

console.log("critical regressions passed");
