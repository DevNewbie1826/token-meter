import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "../src/protocol";
import { REGISTRY_VERSION, listProviderCapabilities } from "../src/registry";

describe("bundled bridge smoke contract", () => {
  test("QA request producers use wire version independently of registry version", () => {
    for (const path of ["../scripts/qa/live-login-usage.mjs", "../scripts/qa/runtime-provider-audit.sh"]) {
      const script = readFileSync(path, "utf8");
      const versions = [...script.matchAll(/schemaVersion["']?\s*:\s*["']([^"']+)/g)].map(match => match[1]);
      expect(versions).toHaveLength(2);
      expect(versions.every(version => version === PROTOCOL_VERSION)).toBe(true);
    }
  });

  test("native management selectors enumerate precisely the shipped provider IDs", () => {
    const driver = readFileSync("../scripts/qa/TokenMeterAXDriver.swift", "utf8");
    const ids = [...driver.matchAll(/ExpectedProvider\(id: "([^"]+)"/g)].map(match => match[1]).sort();
    expect(ids).toEqual(listProviderCapabilities().map(provider => provider.id).sort());
    expect(ids).toHaveLength(17);
  });

  test("release and QA entrypoints have disjoint QA module graphs", async () => {
    for (const [entrypoint, expectsQA] of [["src/cli.ts", false], ["qa/provider-parity.ts", true]] as const) {
      const modules: string[] = [];
      const build = await Bun.build({ entrypoints: [entrypoint], target: "bun", plugins: [{ name: "module-graph", setup(builder) {
        builder.onLoad({ filter: /./ }, args => { modules.push(args.path); return undefined; });
      } }] });
      expect(build.success).toBe(true);
      expect(modules.some(path => path.endsWith("/qa/runtime.ts"))).toBe(expectsQA);
      expect(modules.some(path => path.endsWith("/qa/fixtures.ts"))).toBe(expectsQA);
      expect(modules.some(path => path.endsWith("/src/providers/index.ts"))).toBe(true);
    }
  });

  test("build-all sends wire 1.3.0 while asserting the separate registry schema", () => {
    const script = readFileSync("../scripts/build-all.sh", "utf8");
    const requestVersion = `"schemaVersion":"${PROTOCOL_VERSION}"`;
    const registryAssertion = "providers['schemaVersion'] == '1.2.0'";

    expect(PROTOCOL_VERSION).toBe("1.3.0");
    expect(script).toContain('rm -f bridge/build/token-meter-bridge');
    expect(script).toContain("(cd bridge && bun run build)");
    expect(script).toContain(requestVersion);
    expect(script).toContain(registryAssertion);
    expect(script).toContain("usage['schemaVersion'] == '1.3.0'");
  });

  test("build-all packages the Swift registry resource bundle and asserts its registry version", () => {
    const script = readFileSync("../scripts/build-all.sh", "utf8");
    expect(script).toContain("token-meter_TokenMeterCore.bundle");
    expect(script).toContain("provider-capabilities.json");
    expect(script).toContain("registry resource");
  });

  test("verify-bundle asserts the shipped registry resource and the bridge listing agree", () => {
    const script = readFileSync("../scripts/verify-bundle.sh", "utf8");
    expect(script).toContain("provider-capabilities.json");
    expect(script).toContain("providers --format json");
    expect(script).toContain("token-meter_TokenMeterCore.bundle");
    expect(script).toContain("find .omo/evidence -type f");
  });

  test("registry version is pinned separately from the wire version", () => {
    expect(REGISTRY_VERSION).toBe("1.2.0");
    expect(PROTOCOL_VERSION).toBe("1.3.0");
  });
});
