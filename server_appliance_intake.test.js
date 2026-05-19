const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadServerHelpers() {
  const serverPath = path.join(__dirname, "server.js");
  const originalSource = fs.readFileSync(serverPath, "utf8");
  const source = originalSource.replace(
    /server\.listen\(PORT, \(\) => \{\s*console\.log\(`Server running on port \$\{PORT\} - \$\{APP_VERSION\}`\);\s*\}\);/,
    ""
  ) + `
module.exports = {
  applianceDetailSlotsComplete,
  harvestApplianceDetailSlots
};
`;

  const previousVertical = process.env.INTAKE_VERTICAL;
  process.env.INTAKE_VERTICAL = "appliance";

  try {
    const sandbox = {
      require,
      console,
      process,
      Buffer,
      URL,
      __dirname,
      __filename: serverPath,
      module: { exports: {} },
      exports: {},
      setTimeout,
      clearTimeout
    };
    vm.runInNewContext(source, sandbox, { filename: serverPath });
    return sandbox.module.exports;
  } finally {
    if (previousVertical === undefined) {
      delete process.env.INTAKE_VERTICAL;
    } else {
      process.env.INTAKE_VERTICAL = previousVertical;
    }
  }
}

function testUnknownApplianceTypeDoesNotBlockIntake() {
  const helpers = loadServerHelpers();
  const caller = {
    issue: "I have an appliance that is not working",
    applianceBrand: "",
    applianceTypeDetail: "",
    applianceCoverage: "",
    applianceSymptomCaptured: false,
    applianceIntakeMergedIssue: "I have an appliance that is not working"
  };

  assert.strictEqual(helpers.applianceDetailSlotsComplete(caller), false);

  helpers.harvestApplianceDetailSlots(caller, "I don't know");

  assert.strictEqual(caller.applianceTypeDetail, "appliance type/brand unknown");
  assert.strictEqual(caller.applianceCoverage, "unknown");
  assert.strictEqual(helpers.applianceDetailSlotsComplete(caller), true);
}

testUnknownApplianceTypeDoesNotBlockIntake();
console.log("PASS server appliance intake unknown detail regression");
