import { readdirSync } from "node:fs";
import { readdir as readdirAsync } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { UltraciteSetupError } from "./config-resolution";
import { frameworks } from "./data/options";

const overrideSchema = z.strictObject({
  extends: z.array(z.string()),
  files: z.union([z.string(), z.array(z.string()).min(1)]),
});

const configSchema = z.strictObject({
  extends: z.array(z.string()).optional(),
  overrides: z.array(overrideSchema).optional(),
});

export type UltraciteConfig = z.infer<typeof configSchema>;

export interface PresetScope {
  directory: string;
  files: string[];
  presets: string[];
}

export interface ResolvedPathConfig {
  configFiles: string[];
  projectRoot: string;
  scopes: PresetScope[];
}

const configFileName = "ultracite.config.mjs";
const supportedPresets = new Set([
  "core",
  ...frameworks,
  "anti-slop",
  "js-plugins",
  "next/js-plugins",
  "shadcn",
  "tanstack/js-plugins",
  "type-aware",
]);
const discoverySafetyExclusions = new Set([".git", "node_modules"]);

const toPosix = (value: string): string => value.split(path.sep).join("/");

const globToRegExp = (glob: string): RegExp => {
  if (!glob || path.isAbsolute(glob) || glob.split(/[\\/]/u).includes("..")) {
    throw new UltraciteSetupError(
      `Invalid Ultracite config glob "${glob}". Use a non-empty project-relative pattern without "..".`
    );
  }
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end === -1 || !glob.slice(index + 1, end).includes(",")) {
        throw new UltraciteSetupError(
          `Invalid Ultracite config glob "${glob}". Brace groups must contain comma-separated alternatives.`
        );
      }
      const alternatives = glob
        .slice(index + 1, end)
        .split(",")
        .map((alternative) =>
          alternative.replaceAll(/[|\\{}()[\]^$+?.]/gu, "\\$&")
        );
      pattern += `(?:${alternatives.join("|")})`;
      index = end;
    } else if (char === "}") {
      throw new UltraciteSetupError(`Invalid Ultracite config glob "${glob}".`);
    } else if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end === -1) {
        throw new UltraciteSetupError(
          `Invalid Ultracite config glob "${glob}".`
        );
      }
      pattern += glob.slice(index, end + 1);
      index = end;
    } else {
      pattern += char.replaceAll(/[|\\()[\]^$+]/gu, "\\$&");
    }
  }
  try {
    return new RegExp(`${pattern}$`, "u");
  } catch (error) {
    throw new UltraciteSetupError(
      `Invalid Ultracite config glob "${glob}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const validateGlob = (glob: string): void => {
  globToRegExp(glob);
};

const discoverConfigs = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdirAsync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const workspaceRoot =
      directory === root ||
      entries.some((entry) => entry.name === "package.json");
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) {
          if (!discoverySafetyExclusions.has(entry.name)) {
            await visit(path.join(directory, entry.name));
          }
        } else if (entry.name === configFileName && workspaceRoot) {
          found.push(path.join(directory, entry.name));
        }
      })
    );
  };
  await visit(root);
  return found.toSorted((left, right) => left.localeCompare(right));
};

/** Find path configs without invoking async loading so no-config CLI calls stay synchronous. */
export const findPathConfigFiles = (root: string): string[] => {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const workspaceRoot =
      path.resolve(directory) === path.resolve(root) ||
      entries.some((entry) => entry.name === "package.json");
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!discoverySafetyExclusions.has(entry.name)) {
          visit(path.join(directory, entry.name));
        }
      } else if (entry.name === configFileName && workspaceRoot) {
        found.push(path.join(directory, entry.name));
      }
    }
  };
  visit(path.resolve(root));
  return found.toSorted((left, right) => left.localeCompare(right));
};

const loadConfig = async (configPath: string): Promise<UltraciteConfig> => {
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(configPath).href);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UltraciteSetupError(
      `Could not load ${configPath}: ${detail}. Ensure it is a valid Node.js ESM config.`
    );
  }

  const parsed = configSchema.safeParse(module.default);
  if (!parsed.success) {
    throw new UltraciteSetupError(
      `Invalid ${configPath}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  return parsed.data;
};

const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
};

/** Resolve path-based presets with deterministic parent-before-child ordering. */
export const resolvePathConfig = async (
  projectRoot: string,
  configs?: string[]
): Promise<ResolvedPathConfig | null> => {
  const root = path.resolve(projectRoot);
  const found = (configs ?? (await discoverConfigs(root)))
    .map((file) => path.resolve(file))
    .toSorted(
      (left, right) =>
        path.relative(root, path.dirname(left)).split(path.sep).length -
          path.relative(root, path.dirname(right)).split(path.sep).length ||
        left.localeCompare(right)
    );
  if (found.length === 0) {
    return null;
  }
  for (const file of found) {
    if (!isWithin(root, file)) {
      throw new UltraciteSetupError(
        `Ultracite config ${file} is outside project root ${root}.`
      );
    }
  }

  const configPaths = new Set(found);
  const cache = new Map<string, UltraciteConfig>();
  const scopes: PresetScope[] = [];
  const active: string[] = [];
  const resolved = new Set<string>();
  const resolveFile = async (file: string): Promise<void> => {
    if (active.includes(file)) {
      const cycle = [...active.slice(active.indexOf(file)), file]
        .map((entry) => path.relative(root, entry))
        .join(" -> ");
      throw new UltraciteSetupError(
        `Circular Ultracite config inheritance: ${cycle}`
      );
    }
    if (resolved.has(file)) {
      return;
    }
    active.push(file);
    let config = cache.get(file);
    if (!config) {
      config = await loadConfig(file);
      cache.set(file, config);
    }
    const directory = path.dirname(file);
    for (const parent of config.extends ?? []) {
      if (parent.startsWith("ultracite/")) {
        const preset = parent.slice("ultracite/".length);
        if (!supportedPresets.has(preset)) {
          throw new UltraciteSetupError(
            `Unknown Ultracite preset "${parent}".`
          );
        }
        scopes.push({ directory, files: ["**/*"], presets: [preset] });
        continue;
      }
      if (!parent.startsWith(".")) {
        throw new UltraciteSetupError(
          `Unsupported Ultracite config extension "${parent}" in ${file}. Use a relative config path or an "ultracite/<preset>" preset.`
        );
      }
      const parentPath = path.resolve(directory, parent);
      if (!isWithin(root, parentPath) || !configPaths.has(parentPath)) {
        throw new UltraciteSetupError(
          `Ultracite config extension "${parent}" in ${file} must resolve to a discovered config inside ${root}.`
        );
      }
      // Parent configs must be resolved before child scopes for stable merging.
      // oxlint-disable-next-line no-await-in-loop
      await resolveFile(parentPath);
    }
    for (const override of config.overrides ?? []) {
      const files = Array.isArray(override.files)
        ? override.files
        : [override.files];
      for (const glob of files) {
        validateGlob(glob);
      }
      for (const preset of override.extends) {
        if (!preset.startsWith("ultracite/")) {
          throw new UltraciteSetupError(
            `Override presets must use "ultracite/<preset>"; received "${preset}" in ${file}.`
          );
        }
        const name = preset.slice("ultracite/".length);
        if (!supportedPresets.has(name)) {
          throw new UltraciteSetupError(
            `Unknown Ultracite preset "${preset}".`
          );
        }
        scopes.push({ directory, files, presets: [name] });
      }
    }
    active.pop();
    resolved.add(file);
  };

  for (const file of found) {
    // Preserve ancestor-first ordering when scopes from multiple configs merge.
    // oxlint-disable-next-line no-await-in-loop
    await resolveFile(file);
  }
  return { configFiles: found, projectRoot: root, scopes };
};

/** Return whether a project-relative path is matched by a resolved scope. */
export const matchesPresetScope = (
  file: string,
  scope: PresetScope
): boolean => {
  const absoluteFile = path.resolve(file);
  const relative = toPosix(path.relative(scope.directory, absoluteFile));
  if (
    relative.startsWith("../") ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  return scope.files.some((pattern) => globToRegExp(pattern).test(relative));
};
