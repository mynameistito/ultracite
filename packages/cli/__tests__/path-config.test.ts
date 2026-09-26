import { describe, expect, test } from "bun:test";
import path from "node:path";

import { matchesPresetScope, resolvePathConfig } from "../src/path-config";

const fixture = path.join(import.meta.dir, "fixtures", "path-config");

describe("path config", () => {
  test("resolves root overrides and explicit workspace inheritance", async () => {
    const config = await resolvePathConfig(fixture, [
      path.join(fixture, "ultracite.config.mjs"),
      path.join(fixture, "apps", "web", "ultracite.config.mjs"),
    ]);

    expect(config?.scopes.map((scope) => scope.presets)).toEqual([
      ["core"],
      ["react"],
      ["astro"],
      ["tanstack"],
    ]);
    expect(
      config?.scopes.some(
        (scope) =>
          scope.presets.includes("react") &&
          matchesPresetScope(
            path.join(fixture, "apps", "web", "src", "bad-component.tsx"),
            scope
          )
      )
    ).toBe(true);
  });

  test("keeps framework scopes isolated from shared packages", async () => {
    const config = await resolvePathConfig(fixture);
    const shared = path.join(fixture, "packages", "shared", "src", "index.ts");

    expect(
      config?.scopes
        .filter((scope) => scope.presets.includes("core"))
        .every((scope) => matchesPresetScope(shared, scope))
    ).toBe(true);
    expect(
      config?.scopes
        .filter((scope) => !scope.presets.includes("core"))
        .some((scope) => matchesPresetScope(shared, scope))
    ).toBe(false);
  });

  test("reports invalid globs and config cycles with actionable errors", async () => {
    await expect(
      resolvePathConfig(fixture, [
        path.join(fixture, "invalid-glob.config.mjs"),
      ])
    ).rejects.toThrow("Invalid Ultracite config glob");
    await expect(
      resolvePathConfig(fixture, [
        path.join(fixture, "cycle-a.config.mjs"),
        path.join(fixture, "cycle-b.config.mjs"),
      ])
    ).rejects.toThrow("Circular Ultracite config inheritance");
    await expect(
      resolvePathConfig(fixture, [
        path.join(fixture, "unsupported-preset.config.mjs"),
      ])
    ).rejects.toThrow('Unknown Ultracite preset "ultracite/not-a-preset"');
    await expect(
      resolvePathConfig(fixture, [path.join(fixture, "unknown-key.config.mjs")])
    ).rejects.toThrow('Unrecognized key: "unsupported"');
    await expect(
      resolvePathConfig(fixture, [path.resolve(fixture, "..", "outside.mjs")])
    ).rejects.toThrow("is outside project root");
  });

  test("matches brace alternatives and recursive glob segments", () => {
    const scope = {
      directory: fixture,
      files: ["apps/{web,docs}/src/**/*.tsx"],
      presets: ["react"],
    };

    expect(
      matchesPresetScope(
        path.join(fixture, "apps", "web", "src", "bad-component.tsx"),
        scope
      )
    ).toBe(true);
    expect(
      matchesPresetScope(
        path.join(fixture, "apps", "docs", "src", "bad-component.tsx"),
        scope
      )
    ).toBe(true);
    expect(
      matchesPresetScope(
        path.join(fixture, "packages", "shared", "src", "bad-component.tsx"),
        scope
      )
    ).toBe(false);
  });
});
