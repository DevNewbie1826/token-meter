// A separately compiled QA executable, never a release CLI flag or import.
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAuth } from "../src/dispatch";
import { listProviderCapabilities } from "../src/registry";
import { failureEnvelope, runLoginSession } from "../src/cli";
import { encodeBridgeResponse, parseBridgeRequest } from "../src/protocol";
import type { BridgeRequest } from "../src/protocol";
import { parseScenario } from "./fixtures";
import { fixtureRuntime } from "./runtime";

export async function main(args: string[]): Promise<number> {
  const runtime = fixtureRuntime(parseScenario(process.env["TOKEN_METER_QA_SCENARIO"]),
    join(tmpdir(), `TokenMeter-QA-${process.ppid}-installation`));
  if (args.length !== 2 || args[1] !== "--stdin") throw new Error("QA bridge requires command --stdin");
  if (args[0] === "login") {
    for (const provider of listProviderCapabilities()) registerAuth(runtime.auth(provider.id));
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const iterator = reader[Symbol.asyncIterator]();
    return await runLoginSession({
      readLine: async () => { const line = await iterator.next(); return line.done ? undefined : line.value; },
      writeOutput: line => process.stdout.write(`${line}\n`),
      writeEvent: line => process.stderr.write(`${line}\n`), closeInput: () => reader.close(),
    });
  }
  if (args[0] !== "usage") throw new Error("Unknown QA command");
  let request: BridgeRequest | undefined;
  try {
    request = parseBridgeRequest(await Bun.stdin.text());
    process.stdout.write(`${encodeBridgeResponse(await runtime.usage(request))}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${encodeBridgeResponse(failureEnvelope(request, error))}\n`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
