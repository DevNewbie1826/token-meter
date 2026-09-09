#!/usr/bin/env node
import { spawn } from "node:child_process";

const [providerId, method] = process.argv.slice(2);
if (!providerId || !method) {
  console.error("usage: live-login-usage.mjs <provider> <method>");
  process.exit(2);
}

const bridge =
  process.env.TOKEN_METER_BRIDGE
  ?? new URL("../../.omo/build/TokenMeter.app/Contents/Resources/token-meter-bridge", import.meta.url).pathname;
const now = Date.now();
const request = {
  schemaVersion: "1.3.0",
  providerId,
  method,
  requestedAtMs: now,
  deadlineAtMs: now + 10 * 60 * 1000,
};

function runBridge(args, input) {
  const child = spawn(bridge, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(input));
  return child;
}

async function collect(stream, onLine) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) await onLine(line);
    }
  }
  if (buffer.trim()) await onLine(buffer);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

const login = runBridge(["login", "--stdin"], request);
let loginStdout = "";
let opened = false;
const stdoutTask = collect(login.stdout, async line => {
  loginStdout += line;
});
const eventsTask = collect(login.stderr, async line => {
  const event = JSON.parse(line);
  if (event.type === "openUrl" && !opened) {
    opened = true;
    const opener = spawn("/usr/bin/open", [event.url], {
      stdio: "ignore",
    });
    await waitForExit(opener);
    console.log("EVENT openUrl opened=true");
    return;
  }
  console.log(`EVENT ${event.type}`);
});

const [loginExit] = await Promise.all([
  waitForExit(login),
  stdoutTask,
  eventsTask,
]);
const loginResult = JSON.parse(loginStdout);
if (!loginResult.credential) {
  console.log(JSON.stringify({
    providerId,
    method,
    loginExit,
    status: "error",
    errorKind: loginResult.error?.kind,
  }));
  process.exit(loginExit || 1);
}

const usageNow = Date.now();
const usage = runBridge(["usage", "--stdin"], {
  schemaVersion: "1.3.0",
  requestId: `live-${providerId}-${method}`,
  operation: "fetchUsage",
  providerId,
  connectorId: providerId,
  accountRef: "redacted",
  requestedAtMs: usageNow,
  deadlineAtMs: usageNow + 30_000,
  credential: loginResult.credential,
});
let usageStdout = "";
const [usageExit] = await Promise.all([
  waitForExit(usage),
  collect(usage.stdout, async line => {
    usageStdout += line;
  }),
  collect(usage.stderr, async line => {
    const event = JSON.parse(line);
    console.log(`USAGE_EVENT ${event.type}`);
  }),
]);
const usageResult = JSON.parse(usageStdout);
delete usageResult.refreshedCredential;
console.log(JSON.stringify({
  providerId,
  method,
  loginExit,
  usageExit,
  status: usageResult.status,
  errorKind: usageResult.error?.kind,
  report: usageResult.report,
}, null, 2));
process.exit(usageExit);
