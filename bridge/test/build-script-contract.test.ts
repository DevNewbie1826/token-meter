import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "../src/protocol";
import { REGISTRY_VERSION } from "../src/registry";

describe("bundled bridge smoke contract", () => {
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
