/**
 * Deterministic regression for final_question wrap-up intent matching.
 * Loads server.js in test mode (BLUE_CALLER_TEST_WRAP_UP=1) so matchers stay in sync with production.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const result = spawnSync(process.execPath, [path.join(__dirname, "server.js")], {
  env: { ...process.env, BLUE_CALLER_TEST_WRAP_UP: "1" },
  stdio: "inherit",
  cwd: __dirname,
});

process.exit(typeof result.status === "number" ? result.status : 1);
