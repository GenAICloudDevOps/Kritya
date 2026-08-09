import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DiscoveredPlugin {
  name: string;
  /** Absolute path to the plugin's folder. */
  dir: string;
  /** Full contents of plugin.json, including name/version and any forward-compatible fields. */
  manifest: Record<string, unknown>;
}

export interface SkippedPlugin {
  /** The folder name -- often the problem itself, e.g. when it doesn't match the manifest name. */
  name: string;
  dir: string;
  reason: string;
}

export interface PluginScanResult {
  loaded: DiscoveredPlugin[];
  skipped: SkippedPlugin[];
}

/**
 * Scans each root for `<name>/plugin.json` folders, in name order, and reports
 * both what loaded and why anything didn't. Roots that don't exist are
 * skipped silently -- an unconfigured plugins directory isn't noteworthy. A
 * folder without a plugin.json is not a plugin and isn't reported at all. On
 * a name collision across or within roots, the first one found wins.
 */
export function scanPluginsDetailed(roots: string[]): PluginScanResult {
  const seen = new Map<string, DiscoveredPlugin>();
  const skipped: SkippedPlugin[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirs) {
      const dir = path.join(root, entry.name);
      const manifestFile = path.join(dir, "plugin.json");
      let raw: string;
      try {
        raw = fs.readFileSync(manifestFile, "utf8");
      } catch {
        continue;
      }
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(raw);
      } catch {
        skipped.push({ name: entry.name, dir, reason: "invalid JSON in plugin.json" });
        continue;
      }
      const name = manifest.name;
      const version = manifest.version;
      if (typeof name !== "string" || typeof version !== "string") {
        skipped.push({
          name: entry.name,
          dir,
          reason: 'plugin.json must include "name" and "version"',
        });
        continue;
      }
      if (name !== entry.name) {
        skipped.push({
          name: entry.name,
          dir,
          reason: `folder name "${entry.name}" does not match manifest name "${name}"`,
        });
        continue;
      }
      const existing = seen.get(name);
      if (existing) {
        skipped.push({
          name: entry.name,
          dir,
          reason: `duplicate plugin name "${name}" (already loaded from ${existing.dir})`,
        });
        continue;
      }
      seen.set(name, { name, dir, manifest });
    }
  }
  return { loaded: [...seen.values()], skipped };
}

let warnSink: (message: string) => void = (message) => {
  process.stderr.write(`kritya: ${message}\n`);
};

function warn(message: string): void {
  warnSink(message);
}

/** For testing: override the warning sink. Returns the previous sink. */
export function _setWarnSink(sink: (message: string) => void): (message: string) => void {
  const prev = warnSink;
  warnSink = sink;
  return prev;
}

/**
 * Same scan as scanPluginsDetailed, but for the common case that only wants
 * the loaded list, warning (once per skip) about anything malformed.
 */
export function scanPlugins(roots: string[]): DiscoveredPlugin[] {
  const { loaded, skipped } = scanPluginsDetailed(roots);
  for (const s of skipped) {
    warn(`skipping ${path.join(s.dir, "plugin.json")}: ${s.reason}`);
  }
  return loaded;
}

export function pluginsDir(workspace: string): string {
  return path.join(workspace, ".kritya", "plugins");
}

/** User-global plugins root, available across all workspaces. */
export function userPluginsDir(): string {
  return path.join(os.homedir(), ".kritya", "plugins");
}

export interface PluginSkillsRoot {
  /** Absolute path to the plugin's skills/ subfolder, for feeding into scanSkills. */
  dir: string;
  pluginName: string;
}

/** Maps each discovered plugin to its skills/ subfolder, for use as extra skill roots. */
export function pluginSkillsRoots(plugins: DiscoveredPlugin[]): PluginSkillsRoot[] {
  return plugins.map((p) => ({ dir: path.join(p.dir, "skills"), pluginName: p.name }));
}
