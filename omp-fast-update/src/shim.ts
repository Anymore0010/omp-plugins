/**
 * PATH shim for the standalone CLI.
 *
 * The host's CLI command table is fixed, so `omp fast-update` cannot exist.
 * Instead this writes a tiny launcher named `omp-fast-update` into the same
 * directory as the `omp` executable — that directory is already on `PATH` and
 * writable by the user — so a terminal invocation behaves like `omp update`.
 *
 * The shim does NOT bake in a path that a marketplace upgrade would invalidate:
 * a plugin upgrade installs into a new versioned cache directory
 * (`.../cache/plugins/omp-plugins___omp-fast-update___<version>`), so a baked
 * path would break on the upgrade the user is most likely to run next. Instead
 * the generated launchers resolve the newest installed copy at run time, then
 * fall back to the baking-in path, then fail with an actionable message.
 *
 * The plugin is also discoverable via `~/.omp/agent/config.yml` (a source
 * checkout), so both layouts are searched.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveLauncherPath } from "./replace"

/** Absolute path of the CLI entry of the currently running copy. */
export const CLI_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url))
const SHIM_NAME = "omp-fast-update"
/** Marks the generated file so an unrelated user file is never overwritten. */
const SHIM_MARKER = `${SHIM_NAME} shim`
/** Marketplace cache holding one directory per installed plugin version. */
const CACHE_PLUGIN_GLOB_DIR = path.join(os.homedir(), ".omp", "plugins", "cache", "plugins")
const CACHE_PLUGIN_PREFIX = "omp-plugins___omp-fast-update___"
/** Relative path of the CLI entry inside any install layout. */
const CLI_ENTRY_RELATIVE = path.join("src", "main.ts")

/** Result of an install/uninstall/status call, ready to print. */
export interface ShimResult {
	ok: boolean
	message: string
	/** Files written or inspected. */
	paths: string[]
}

/** Directory of the `omp` launcher — already on PATH and user-writable. */
function shimDir(): string | undefined {
	const launcher = resolveLauncherPath()
	return launcher === undefined ? undefined : path.dirname(launcher)
}

function shimPaths(dir: string): string[] {
	return process.platform === "win32"
		? [path.join(dir, `${SHIM_NAME}.cmd`), path.join(dir, `${SHIM_NAME}.ps1`)]
		: [path.join(dir, SHIM_NAME)]
}

/**
 * Newest installed copy of this plugin's CLI entry.
 *
 * Versions are compared numerically segment by segment so `0.1.10` outranks
 * `0.1.9` (a lexicographic sort would pick the wrong one).
 */
export function newestInstalledEntry(): string | undefined {
	let entries: string[]
	try {
		entries = fs.readdirSync(CACHE_PLUGIN_GLOB_DIR)
	} catch {
		return undefined
	}
	const candidates = entries
		.filter(name => name.startsWith(CACHE_PLUGIN_PREFIX))
		.map(name => ({
			name,
			version: name.slice(CACHE_PLUGIN_PREFIX.length).split("-")[0] ?? "",
			entry: path.join(CACHE_PLUGIN_GLOB_DIR, name, CLI_ENTRY_RELATIVE),
		}))
		.filter(candidate => fs.existsSync(candidate.entry))
		.sort((left, right) => compareVersionStrings(right.version, left.version))
	return candidates[0]?.entry
}

function compareVersionStrings(left: string, right: string): number {
	const parse = (value: string): number[] =>
		value
			.split(".")
			.map(part => Number.parseInt(part, 10))
			.map(number => (Number.isNaN(number) ? 0 : number))
	const a = parse(left)
	const b = parse(right)
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0)
		if (difference !== 0) return difference
	}
	return 0
}

/**
 * JavaScript launcher shared by the generated shims.
 *
 * Resolving at run time is what makes the shim survive `omp plugin upgrade`.
 * It is embedded rather than imported so the shim stays a single self-contained
 * file the user can read and delete.
 */
function resolverScript(): string {
	return `import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
const HOME = homedir();
const CACHE = join(HOME, ".omp", "plugins", "cache", "plugins");
const PREFIX = "${CACHE_PLUGIN_PREFIX}";
const REL = ${JSON.stringify(CLI_ENTRY_RELATIVE)};
const BAKED = ${JSON.stringify(CLI_ENTRY)};
const NAME = "${SHIM_NAME}";
const cmp = (a, b) => {
  const p = v => v.split(".").map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};
// A config.yml \`extensions:\` entry that points at this plugin wins over any
// marketplace copy: that is the documented development mode (edit the repo,
// restart omp), and the marketplace cache would otherwise silently shadow the
// user's own checkout. Candidate configs are project then user, matching the
// host's own precedence (project config shadows user config).
const configCandidates = [
  join(process.cwd(), ".omp", "config.yml"),
  join(HOME, ".omp", "agent", "config.yml"),
  join(HOME, ".omp", "config.yml"),
];
const configuredEntries = [];
for (const cfg of configCandidates) {
  if (!existsSync(cfg)) continue;
  let lines;
  try { lines = readFileSync(cfg, "utf8").split(/\\r?\\n/); } catch { continue; }
  let inBlock = false;
  for (const line of lines) {
    if (/^extensions:\\s*$/.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    const item = /^\\s+-\\s+(.*\\S)\\s*$/.exec(line);
    if (!item) { if (/^\\S/.test(line)) inBlock = false; continue; }
    configuredEntries.push(item[1].replace(/^["']|["']$/g, ""));
  }
  if (configuredEntries.length > 0) break;
}
const fromConfig = configuredEntries
  .map(raw => (raw.startsWith("~") ? join(HOME, raw.slice(1)) : raw))
  .map(raw => (isAbsolute(raw) ? raw : resolve(raw)))
  .map(dir => join(dir, REL))
  .find(entry => existsSync(entry));

// A baked path outside the marketplace cache is a source checkout the user
// pointed at deliberately; a baked path inside the cache belongs to one
// version directory that the next upgrade abandons.
const bakedInCache = BAKED.startsWith(CACHE);
const direct = fromConfig ?? (!bakedInCache && existsSync(BAKED) ? BAKED : undefined);
if (direct) {
  const child = Bun.spawn(["bun", direct, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await child.exited);
}
const candidates = [];
try {
  for (const name of readdirSync(CACHE)) {
    if (!name.startsWith(PREFIX)) continue;
    const entry = join(CACHE, name, REL);
    if (existsSync(entry)) candidates.push({ v: name.slice(PREFIX.length).split("-")[0], entry });
  }
} catch {}
candidates.sort((a, b) => cmp(b.v, a.v));
const entry = candidates[0]?.entry ?? (existsSync(BAKED) ? BAKED : undefined);
if (entry === undefined) {
  console.error(NAME + ": 找不到插件安装位置（请先 omp plugin install omp-fast-update@omp-plugins，或重跑 --install-cli）");
  process.exit(1);
}
const child = Bun.spawn(["bun", entry, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
`
}

/**
 * Config-declared source checkout for this plugin, if the user mounted one.
 *
 * Mirrors the resolver embedded in the generated shim: project `.omp/config.yml`
 * first, then `~/.omp/agent/config.yml`, taking the first file that lists any
 * `extensions:` entry resolving to this plugin's CLI entry.
 */
export function configuredSourceEntry(): string | undefined {
	const configs = [
		path.join(process.cwd(), ".omp", "config.yml"),
		path.join(os.homedir(), ".omp", "agent", "config.yml"),
		path.join(os.homedir(), ".omp", "config.yml"),
	]
	for (const config of configs) {
		if (!fs.existsSync(config)) continue
		const entries = readExtensionEntries(config)
		const found = entries
			.map(raw => (raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw))
			.map(raw => (path.isAbsolute(raw) ? raw : path.resolve(raw)))
			.map(dir => path.join(dir, CLI_ENTRY_RELATIVE))
			.find(entry => fs.existsSync(entry))
		if (found !== undefined) return found
	}
	return undefined
}

/** Parse the `extensions:` block of a YAML config into raw entry strings. */
function readExtensionEntries(configPath: string): string[] {
	let lines: string[]
	try {
		lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/u)
	} catch {
		return []
	}
	const entries: string[] = []
	let inBlock = false
	for (const line of lines) {
		if (/^extensions:\s*$/u.test(line)) {
			inBlock = true
			continue
		}
		if (!inBlock) continue
		const item = /^\s+-\s+(.*\S)\s*$/u.exec(line)
		if (item === null) {
			// A non-indented line ends the block.
			if (/^\S/u.test(line)) inBlock = false
			continue
		}
		entries.push((item[1] as string).replace(/^["']|["']$/gu, ""))
	}
	return entries
}

function shimBody(dir: string): string[] {
	const scriptPath = path.join(dir, `${SHIM_NAME}-run.mjs`)
	const invoke = `bun "${scriptPath}"`
	if (process.platform === "win32") {
		return [
			`@echo off\r\nrem ${SHIM_NAME} shim — generated, safe to delete\r\n${invoke} %*\r\n`,
			`# ${SHIM_NAME} shim — generated, safe to delete\n& ${invoke} @args\nexit $LASTEXITCODE\n`,
		]
	}
	return [`#!/bin/sh\n# ${SHIM_NAME} shim — generated, safe to delete\nexec ${invoke} "$@"\n`]
}

/** Files the shim comprises: the run-time resolver plus the entry launchers. */
function allShimFiles(dir: string): string[] {
	return [path.join(dir, `${SHIM_NAME}-run.mjs`), ...shimPaths(dir)]
}

/** Report where the shim is and whether it resolves to a real install. */
export async function shimStatus(): Promise<ShimResult> {
	const dir = shimDir()
	if (dir === undefined) return { ok: false, message: "找不到 omp 启动器路径，无法定位 PATH 目录。", paths: [] }
	const existing = allShimFiles(dir).filter(file => fs.existsSync(file))
	if (existing.length === 0) {
		return {
			ok: false,
			message: `未安装（可运行 omp-fast-update --install-cli 安装到 ${dir}）`,
			paths: allShimFiles(dir),
		}
	}
	// The shim resolves at run time, so a plugin upgrade does not invalidate it;
	// it is only stale if no installed copy can be found at all.
	const resolved = newestInstalledEntry()
	return {
		ok: resolved !== undefined,
		message:
			resolved !== undefined
				? `已安装（解析到 ${resolved}）`
				: `已安装但找不到任何插件安装副本；先 omp plugin install omp-fast-update@omp-plugins`,
		paths: existing,
	}
}

/**
 * Write the shim next to the omp launcher.
 *
 * Refuses to overwrite a file that is not one of ours, so a user's own
 * `omp-fast-update` in that directory is never clobbered.
 */
export async function installCliShim(): Promise<ShimResult> {
	const dir = shimDir()
	if (dir === undefined) {
		return { ok: false, message: "找不到 omp 启动器路径，请手动把 main.ts 加入 PATH。", paths: [] }
	}
	for (const existing of shimPaths(dir)) {
		if (!fs.existsSync(existing)) continue
		if (!fs.readFileSync(existing, "utf8").includes(SHIM_MARKER)) {
			return { ok: false, message: `${existing} 已存在且不是本插件生成的，未覆盖。`, paths: [existing] }
		}
	}
	const written: string[] = []
	await fs.promises.writeFile(path.join(dir, `${SHIM_NAME}-run.mjs`), resolverScript(), { mode: 0o755 })
	written.push(path.join(dir, `${SHIM_NAME}-run.mjs`))
	const bodies = shimBody(dir)
	const paths = shimPaths(dir)
	for (let index = 0; index < paths.length; index++) {
		const target = paths[index] as string
		await fs.promises.writeFile(target, bodies[index] as string, { mode: 0o755 })
		written.push(target)
	}
	const resolved = newestInstalledEntry()
	return {
		ok: true,
		message: `已安装，新开终端后可直接运行 ${SHIM_NAME}（路径 ${dir} 已在 PATH 上）${
			resolved === undefined ? "；注意：尚未检测到插件安装副本" : ""
		}。插件升级后无需重装。`,
		paths: written,
	}
}

/** Remove the generated shims. */
export async function uninstallCliShim(): Promise<ShimResult> {
	const dir = shimDir()
	if (dir === undefined) return { ok: false, message: "找不到 omp 启动器路径。", paths: [] }
	const removed: string[] = []
	for (const target of allShimFiles(dir)) {
		if (!fs.existsSync(target)) continue
		if (!fs.readFileSync(target, "utf8").includes(SHIM_MARKER)) continue
		await fs.promises.rm(target, { force: true })
		removed.push(target)
	}
	return {
		ok: true,
		message: removed.length > 0 ? `已删除：${removed.join(", ")}` : "没有可删除的 shim。",
		paths: removed,
	}
}
