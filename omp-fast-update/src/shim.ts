/**
 * PATH shim for the standalone CLI.
 *
 * The host's CLI command table is fixed, so `omp fast-update` cannot exist.
 * Instead this writes a tiny launcher named `omp-fast-update` into the same
 * directory as the `omp` executable — that directory is already on `PATH` and
 * writable by the user — so a terminal invocation behaves like `omp update`.
 *
 * The shim bakes in the absolute path of {@link CLI_ENTRY}, so it must be
 * reinstalled after the plugin moves (a marketplace upgrade installs into a new
 * versioned cache directory). `status()` reports whether the recorded path
 * still matches, and every command prints that state rather than silently
 * running a stale target.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveLauncherPath } from "./replace"

/** Absolute path of the CLI entry this shim should invoke. */
const CLI_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url))
const SHIM_NAME = "omp-fast-update"
/** Marks the generated file so an unrelated user file is never overwritten. */
const SHIM_MARKER = `${SHIM_NAME} shim`

/** Result of an install/uninstall/status call, ready to print. */
export interface ShimResult {
	ok: boolean
	message: string
	/** Files written or inspected. */
	paths: string[]
}

function shimDir(): string | undefined {
	const launcher = resolveLauncherPath()
	return launcher === undefined ? undefined : path.dirname(launcher)
}

function shimPaths(dir: string): string[] {
	return process.platform === "win32"
		? [path.join(dir, `${SHIM_NAME}.cmd`), path.join(dir, `${SHIM_NAME}.ps1`)]
		: [path.join(dir, SHIM_NAME)]
}

function shimBody(): string[] {
	if (process.platform === "win32") {
		return [
			`@echo off\r\nrem ${SHIM_NAME} shim — generated, safe to delete\r\nbun "${CLI_ENTRY}" %*\r\n`,
			`# ${SHIM_NAME} shim — generated, safe to delete\n& bun "${CLI_ENTRY}" @args\nexit $LASTEXITCODE\n`,
		]
	}
	return [`#!/bin/sh\n# ${SHIM_NAME} shim — generated, safe to delete\nexec bun "${CLI_ENTRY}" "$@"\n`]
}

/** Report where the shim is and whether it still points at this install. */
export async function shimStatus(): Promise<ShimResult> {
	const dir = shimDir()
	if (dir === undefined) {
		return { ok: false, message: "找不到 omp 启动器路径，无法定位 PATH 目录。", paths: [] }
	}
	const paths = shimPaths(dir)
	const existing = paths.filter(p => fs.existsSync(p))
	if (existing.length === 0) {
		return { ok: false, message: `未安装（可运行 omp-fast-update --install-cli 安装到 ${dir}）`, paths }
	}
	const stale = existing.some(p => {
		const body = fs.readFileSync(p, "utf8")
		return !body.includes(SHIM_MARKER) || !body.includes(CLI_ENTRY)
	})
	return {
		ok: !stale,
		message: stale
			? `已安装但指向旧路径（插件可能已升级）；重新运行 --install-cli 刷新：${existing.join(", ")}`
			: `已安装：${existing.join(", ")}`,
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
	const paths = shimPaths(dir)
	const bodies = shimBody()
	for (const existing of paths) {
		if (!fs.existsSync(existing)) continue
		if (!fs.readFileSync(existing, "utf8").includes(SHIM_MARKER)) {
			return { ok: false, message: `${existing} 已存在且不是本插件生成的，未覆盖。`, paths: [existing] }
		}
	}
	const written: string[] = []
	for (let index = 0; index < paths.length; index++) {
		const target = paths[index] as string
		await fs.promises.writeFile(target, bodies[index] as string, { mode: 0o755 })
		written.push(target)
	}
	return { ok: true, message: `已安装，新开终端后可直接运行 ${SHIM_NAME}（路径 ${dir} 已在 PATH 上）。`, paths: written }
}

/** Remove the generated shims. */
export async function uninstallCliShim(): Promise<ShimResult> {
	const dir = shimDir()
	if (dir === undefined) return { ok: false, message: "找不到 omp 启动器路径。", paths: [] }
	const removed: string[] = []
	for (const target of shimPaths(dir)) {
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
