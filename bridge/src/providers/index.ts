/**
 * Provider registration index (side-effect module).
 *
 * Importing this module registers the connector and the auth module for every
 * locked provider with the dispatch layer (./dispatch), so both CLI commands
 * resolve every provider through lookupConnector/lookupAuth. The fixture
 * connector stays a CLI special case and is never registered here.
 *
 * Registration is idempotent: registerConnector/registerAuth write through a
 * Map keyed by providerId, so repeated imports (CLI entry, test files) only
 * overwrite a provider's entry with the same module instance.
 */

import { registerAuth, registerConnector } from "../dispatch";
import type { AuthModule, ConnectorModule } from "../dispatch";
import { alibabaTokenPlanAuth, alibabaTokenPlanConnector } from "./alibaba-token-plan";
import { anthropicAuth, anthropicConnector } from "./anthropic";
import { cursorAuth, cursorConnector } from "./cursor";
import { githubCopilotAuth, githubCopilotConnector } from "./github-copilot";
import { googleAntigravityAuth, googleAntigravityConnector } from "./google-antigravity";
import { googleGeminiCliAuth, googleGeminiCliConnector } from "./google-gemini-cli";
import { kimiCodeAuth, kimiCodeConnector } from "./kimi-code";
import { minimaxCodeAuth, minimaxCodeConnector } from "./minimax-code";
import { nekosAuth, nekosConnector } from "./nekos";
import { ollamaAuth, ollamaConnector } from "./ollama";
import { ollamaCloudAuth, ollamaCloudConnector } from "./ollama-cloud";
import { openaiCodexAuth, openaiCodexConnector } from "./openai-codex";
import { opencodeGoAuth, opencodeGoConnector } from "./opencode-go";
import { syntheticAuth, syntheticConnector } from "./synthetic";
import { umansAuth, umansConnector } from "./umans";
import { xaiOauthAuth, xaiOauthConnector } from "./xai-oauth";
import { zaiAuth, zaiConnector } from "./zai";

const REGISTERED_MODULES: ReadonlyArray<readonly [connector: ConnectorModule, auth: AuthModule]> = [
  [alibabaTokenPlanConnector, alibabaTokenPlanAuth],
  [anthropicConnector, anthropicAuth],
  [cursorConnector, cursorAuth],
  [githubCopilotConnector, githubCopilotAuth],
  [googleAntigravityConnector, googleAntigravityAuth],
  [googleGeminiCliConnector, googleGeminiCliAuth],
  [kimiCodeConnector, kimiCodeAuth],
  [minimaxCodeConnector, minimaxCodeAuth],
  [nekosConnector, nekosAuth],
  [ollamaConnector, ollamaAuth],
  [ollamaCloudConnector, ollamaCloudAuth],
  [openaiCodexConnector, openaiCodexAuth],
  [opencodeGoConnector, opencodeGoAuth],
  [syntheticConnector, syntheticAuth],
  [umansConnector, umansAuth],
  [xaiOauthConnector, xaiOauthAuth],
  [zaiConnector, zaiAuth],
];

for (const [connector, auth] of REGISTERED_MODULES) {
  registerConnector(connector);
  registerAuth(auth);
}
