import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Schema = {
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

describe("published TokenMeter/1.2.0 JSON schemas", () => {
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
      "resetCredits",
    ]);
  });
});
