/**
 * Public facade of the TokenMeter/1.3.0 bridge protocol. Consumers import
 * everything from "./protocol"; the vocabulary lives in protocol-core.ts and
 * the strict request boundary parse lives in request-parse.ts. The login
 * command's wire types live in dispatch.ts next to the auth contracts.
 */

export * from "./protocol-core";
export { parseBridgeRequest, parseLoginRequest, parsePromptResponse } from "./request-parse";
