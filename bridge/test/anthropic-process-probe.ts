/** Test-only Anthropic adapter process: synthetic fixtures/credentials enter only on stdin. */
import { failureEnvelope, runLoginSession } from "../src/cli";
import { anthropicAuth, anthropicConnector, loginAnthropic } from "../src/providers/anthropic";
import { registerAuth } from "../src/dispatch";
import { encodeBridgeResponse, isRecord, parseBridgeRequest } from "../src/protocol";

const input: unknown = JSON.parse(await Bun.stdin.text());
if (!isRecord(input)) throw new Error("invalid probe input");
if (typeof input["loginMode"] === "string") {
  const controller = new AbortController();
  let firstLine = true;
  let pendingLine: ((line: string | undefined) => void) | undefined;
  let state = "";
  let prompts = 0;
  registerAuth({ ...anthropicAuth, login: (method, inputs, events, signal) =>
    loginAnthropic(method, inputs, events, AbortSignal.any([signal, controller.signal]), {
      fetcher: async (url, init) => {
        const outgoing = new Request(url, init);
        if (outgoing.url === "https://api.anthropic.com/v1/oauth/token") {
          const body: unknown = await outgoing.json();
          if (!isRecord(body) || body["code"] !== input["code"] || body["state"] !== state ||
              body["grant_type"] !== "authorization_code" || outgoing.headers.has("User-Agent") ||
              outgoing.headers.has("anthropic-beta") || outgoing.headers.has("Accept")) {
            throw new Error("unexpected authorization-code request");
          }
          return Response.json(input["tokenResponse"]);
        }
        if (input["loginMode"] !== "cancel-bootstrap" ||
            outgoing.url !== "https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8") {
          throw new Error("unexpected login fixture route");
        }
        return await new Promise<Response>((_resolve, reject) => {
          outgoing.signal.addEventListener("abort", () => reject(outgoing.signal.reason), { once: true });
          controller.abort(new DOMException("cancelled", "AbortError"));
        });
      },
    }),
  });
  process.exitCode = await runLoginSession({
    readLine: async () => {
      if (firstLine) { firstLine = false; return JSON.stringify(input["request"]); }
      return await new Promise<string | undefined>(resolve => { pendingLine = resolve; });
    },
    writeOutput: line => { process.stdout.write(`${line}\n`); },
    writeEvent: line => {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) throw new Error("invalid auth event");
      if (event["type"] === "openUrl" && typeof event["url"] === "string") {
        state = new URL(event["url"]).searchParams.get("state") ?? "";
      }
      // Keep event audit non-sensitive: no pasted code, token or nonce.
      process.stderr.write(`${JSON.stringify({ type: event["type"] })}\n`);
      if (event["type"] === "prompt") {
        prompts++;
        if (input["loginMode"] === "cancel-paste") { controller.abort(); return; }
        if (pendingLine === undefined || typeof input["code"] !== "string") throw new Error("missing prompt reader/code");
        const respond = pendingLine;
        pendingLine = undefined;
        const pastedState = input["loginMode"] === "forged-then-code" && prompts === 1 ? "forged" : state;
        respond(JSON.stringify({ type: "promptResponse", requestId: event["requestId"], value: `${input["code"]}#${pastedState}` }));
      }
    },
    closeInput: () => { pendingLine?.(undefined); pendingLine = undefined; },
  });
} else {
if (!Array.isArray(input["routes"])) throw new Error("invalid probe routes");
const request = parseBridgeRequest(JSON.stringify(input["request"]));
const routes: unknown[] = [...input["routes"]];
try {
  const response = await anthropicConnector.fetchUsage({ request, nowMs: request.requestedAtMs,
    fetcher: async (url, init) => {
      const outgoing = new Request(url, init);
      const route = routes.shift();
      if (!isRecord(route) || route["url"] !== outgoing.url || route["method"] !== outgoing.method ||
          typeof route["status"] !== "number" || !isRecord(route["headers"])) {
        throw new Error("unexpected Anthropic fixture route");
      }
      const body: unknown = outgoing.method === "POST" ? await outgoing.json() : undefined;
      const headerMatch = Object.entries(route["headers"]).every(([key, value]) => outgoing.headers.get(key) === value);
      const bodyMatch = route["requestBody"] === undefined || JSON.stringify(body) === JSON.stringify(route["requestBody"]);
      // Audit only public fingerprints and grant shape, never access/refresh/code values.
      process.stderr.write(`${JSON.stringify({ url: outgoing.url, method: outgoing.method,
        userAgent: outgoing.headers.get("User-Agent"), beta: outgoing.headers.get("anthropic-beta"),
        contentType: outgoing.headers.get("Content-Type"), accept: outgoing.headers.get("Accept"),
        bodyKeys: isRecord(body) ? Object.keys(body) : [], headerMatch, bodyMatch })}\n`);
      if (!headerMatch || !bodyMatch) return Response.json({ error: "unsupported_client" }, { status: 400 });
      if (route["malformed"] === true) return new Response("not-json{", { status: route["status"] });
      return Response.json(route["body"], { status: route["status"], headers: { "Retry-After": "17" } });
    },
  });
  process.stdout.write(`${encodeBridgeResponse(response)}\n`);
} catch (error) { // CLI boundary: same production error envelope and credential redaction.
  process.stdout.write(`${encodeBridgeResponse(failureEnvelope(request, error))}\n`);
  process.exitCode = 1;
}
}
