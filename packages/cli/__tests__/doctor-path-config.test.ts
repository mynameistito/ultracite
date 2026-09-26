import { describe, expect, test } from "bun:test";
import path from "node:path";

import { validatePathConfigs } from "../src/commands/doctor";

const fixture = path.join(import.meta.dir, "fixtures", "path-config");

describe("doctor path-config diagnostics", () => {
  test("reports valid root and nested workspace configs", async () => {
    const diagnostic = await validatePathConfigs(fixture, [
      path.join(fixture, "ultracite.config.mjs"),
      path.join(fixture, "apps", "web", "ultracite.config.mjs"),
    ]);

    expect(diagnostic?.status).toBe("pass");
    expect(diagnostic?.message).toContain("across 4 preset scopes");
  });

  test("reports invalid config inheritance and glob errors", async () => {
    const diagnostic = await validatePathConfigs(fixture, [
      path.join(fixture, "invalid-glob.config.mjs"),
    ]);

    expect(diagnostic?.status).toBe("fail");
    expect(diagnostic?.message).toContain("Invalid Ultracite config glob");
  });
});
