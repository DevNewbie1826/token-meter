import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION, USAGE_UNITS } from "../src/protocol";

type Schema = {
  readonly $id?: string;
  readonly type?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean | Schema;
  readonly $defs?: Readonly<Record<string, Schema>>;
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minItems?: number;
};

function readSchema(name: string): Schema {
  return JSON.parse(readFileSync(`schemas/${name}.schema.json`, "utf8")) as Schema;
}

describe("published TokenMeter/1.3.0 JSON schemas", () => {
  test("migrates every wire schema identifier and version together", () => {
    expect(readSchema("common").$defs?.["schemaVersion"]?.const).toBe("1.3.0");
    expect(PROTOCOL_VERSION).toBe("1.3.0");
    for (const name of ["common", "request", "response"]) {
      expect(readSchema(name).$id).toBe(`https://token-meter.app/schemas/TokenMeter/1.3.0/${name}.schema.json`);
    }
  });

  test("publishes credits and bounded remaining fields without opening window objects", () => {
    const common = readSchema("common");
    expect(common.$defs?.["usageUnit"]?.enum).toEqual(USAGE_UNITS);
    expect(common.$defs?.["usageUnit"]?.enum).toContain("credits");
    const window = common.$defs?.["usageWindow"];
    expect(window).toMatchObject({ additionalProperties: false });
    expect(window?.properties?.["remaining"]).toEqual({ type: "number", minimum: 0 });
    expect(window?.properties?.["remainingFraction"]).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(Object.keys(window?.properties ?? {}).sort()).toEqual([
      "id", "label", "limit", "remaining", "remainingFraction", "resetCredits",
      "resetsAtMs", "resolvedFraction", "severity", "unit", "used",
    ]);
  });

  test("credential union publishes none, static, and OAuth arms", () => {
    const credential = readSchema("common").$defs?.["credential"];
    const arms = credential?.oneOf ?? [];
    const kinds = arms.flatMap(arm => {
      const kind = arm.properties?.["kind"];
      if (typeof kind?.const === "string") return [kind.const];
      return (kind?.enum ?? []).filter((value): value is string => typeof value === "string");
    });

    expect(kinds).toEqual(["none", "bearer", "apiKey", "oauth"]);
    expect(arms[2]?.properties?.["oauth"]?.required).toContain("access");
  });

  test("empty no-quota reports and credential writeback are published", () => {
    const common = readSchema("common");
    const windows = common.$defs?.["usageReport"]?.properties?.["windows"];
    expect(windows?.minItems).toBeUndefined();

    const branches = readSchema("response").oneOf ?? [];
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.properties).toHaveProperty("refreshedCredential");
    }
  });

  test("usage windows require one runtime utilization representation", () => {
    const window = readSchema("common").$defs?.["usageWindow"];
    const requiredAlternatives = (window?.anyOf ?? []).flatMap(
      alternative => alternative.required ?? [],
    );

    expect(requiredAlternatives).toEqual([
      "resolvedFraction",
      "used",
      "limit",
      "remaining",
      "remainingFraction",
      "resetCredits",
    ]);
  });
});
