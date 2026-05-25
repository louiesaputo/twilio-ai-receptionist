const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function fakeExpress() {
  return {
    set() {},
    use() {},
    get() {},
    post() {},
  };
}

fakeExpress.urlencoded = () => (_req, _res, next) => next && next();
fakeExpress.json = () => (_req, _res, next) => next && next();
fakeExpress.static = () => (_req, _res, next) => next && next();

function customRequire(id) {
  if (id === "express") return fakeExpress;
  if (id === "ws") {
    return {
      WebSocketServer: function WebSocketServer() {
        this.on = () => {};
        this.handleUpgrade = () => {};
        this.emit = () => {};
      }
    };
  }
  if (id === "twilio") {
    function AccessToken() {
      this.addGrant = () => {};
      this.toJwt = () => "token";
    }
    AccessToken.VoiceGrant = function VoiceGrant() {};
    return {
      jwt: { AccessToken },
      twiml: {
        VoiceResponse: function VoiceResponse() {
          this.connect = () => ({ conversationRelay() {} });
          this.toString = () => "<Response />";
        }
      }
    };
  }
  if (id === "./ai_extractor") {
    return {
      extractOpeningTurn: async () => null,
      interpretPhoneStep: async () => null,
      interpretAddressStep: async () => null,
      interpretSchedulingStep: async () => null,
    };
  }
  return require(id);
}

function loadServerInternals() {
  const serverPath = path.join(__dirname, "server.js");
  let source = fs.readFileSync(serverPath, "utf8");
  source = source.replace(
    /server\.listen\([\s\S]*?\n\}\);\s*$/,
    "globalThis.__test = { analyzeUsServiceAddressCompleteness };"
  );

  const context = {
    Buffer,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    fetch,
    process,
    require: customRequire,
    setInterval,
    setTimeout,
    __dirname,
    __filename: serverPath,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: serverPath });
  return context.__test;
}

const { analyzeUsServiceAddressCompleteness } = loadServerInternals();

function assertComplete(address) {
  const result = analyzeUsServiceAddressCompleteness(address);
  assert.strictEqual(result.ok, true, `${address} should be complete: ${JSON.stringify(result)}`);
}

function assertMissingCity(address) {
  const result = analyzeUsServiceAddressCompleteness(address);
  assert.strictEqual(result.ok, false, `${address} should be incomplete`);
  assert.deepStrictEqual(result.missing, ["city"]);
}

assertComplete("123 Main Street Springfield Illinois 62704");
assertComplete("123 Main Street New York New York 10001");
assertComplete("123 Main Street Los Angeles California 90001");
assertComplete("123 Main Street Springfield IL 62704");
assertComplete("123 Main Street New York NY 10001");
assertComplete("123 Main Street, Springfield Illinois 62704");

assertMissingCity("123 Main Street Illinois 62704");
assertMissingCity("123 Main Street NY 10001");
assertMissingCity("123 Main Street, Illinois 62704");

console.log("address completeness tests passed");
