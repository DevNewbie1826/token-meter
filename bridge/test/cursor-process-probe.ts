/** Test-only actual Cursor adapter process; fixture responses and credentials enter via stdin. */
import { cursorConnector, extractCursorAccessTokenUserId } from "../src/providers/cursor";
import { failureEnvelope } from "../src/cli";
import { encodeBridgeResponse, isRecord, parseBridgeRequest } from "../src/protocol";
import type { Fetcher } from "../src/connectors/provider-http";

const input: unknown = JSON.parse(await Bun.stdin.text());
if (!isRecord(input)) throw new Error("invalid Cursor probe input");
const request = parseBridgeRequest(JSON.stringify(input["request"]));
const credential = request.credential;
if (!credential) throw new Error("missing synthetic credential");
let access = credential.kind === "oauth" ? credential.oauth.access : credential.secret;
const calls: string[] = [];
const fetcher: Fetcher = async (url, init) => {
  const outgoing = new Request(url, init);
  calls.push(`${outgoing.method} ${outgoing.url}`);
  if (outgoing.url === "https://api2.cursor.sh/auth/exchange_user_api_key") {
    if (credential.kind !== "oauth" || outgoing.method !== "POST" ||
      outgoing.headers.get("Authorization") !== `Bearer ${credential.oauth.refresh}` ||
      await outgoing.text() !== "{}") throw new Error("incorrect Cursor rotation request");
    const rotation = input["rotation"];
    if (!isRecord(rotation) || typeof rotation["accessToken"] !== "string") throw new Error("missing rotation fixture");
    access = rotation["accessToken"];
    return Response.json(rotation);
  }
  if (outgoing.url === "https://api2.cursor.sh/auth/usage") {
    if (outgoing.method !== "GET" || outgoing.headers.get("Authorization") !== `Bearer ${access}` ||
      outgoing.headers.get("Accept") !== "application/json" || outgoing.headers.has("Cookie")) throw new Error("incorrect Cursor bearer request");
    if (input["nonJson"] === true) return new Response("not-json{", { headers: { "Content-Type": "application/json" } });
    return Response.json(input["payload"]);
  }
  if (outgoing.url === "https://cursor.com/api/usage-summary") {
    const userId = extractCursorAccessTokenUserId(access);
    if (credential.kind !== "oauth" || outgoing.method !== "GET" || !userId ||
      outgoing.headers.get("Cookie") !== `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${access}`)}` ||
      outgoing.headers.has("Authorization")) throw new Error("incorrect Cursor dashboard request");
    return Response.json(input["summary"] ?? {});
  }
  throw new Error("unexpected Cursor fixture route");
};
try {
  const response = await cursorConnector.fetchUsage({ request, fetcher, nowMs: Date.now() });
  process.stdout.write(`${encodeBridgeResponse(response)}\n`);
} catch (error) {
  process.stdout.write(`${encodeBridgeResponse(failureEnvelope(request, error))}\n`);
  process.exitCode = 1;
}
process.stderr.write(`${JSON.stringify({ calls })}\n`);
