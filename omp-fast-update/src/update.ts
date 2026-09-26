/**
 * `/omp-update` orchestration: resolve → download in parallel → verify → install.
 *
 * The flow deliberately mirrors `omp update`'s observable behaviour (channel
 * selection, "already up to date" short-circuit, version verification by
 * executing the launcher) while replacing only the transfer: one HTTP stream
 * becomes N ranged connections, then the same digest/size gate the stock
 * updater applies before the swap.
 */

import * as fs from "node:fs"
import { downloadRanged, type DownloadResult } from "./download"
import {
	binaryNameForHost,
	compareVersions,
	resolveLatestVersion,
	resolveReleaseAsset,
	type Channel,
} from "./release"
import { classifyTarget, installStagedBinary, resolveLauncherPath, stagingPathFor, sweepStaleArtifacts } from "./replace"
import type { FastUpdateOptions } from "./cli"

/** Side effects the flow needs, injected so the command layer owns presentation. */
export interface UpdateIo {
	notify: (message: string, type: "info" | "warning" | "error") => void
	progress: (line: string) => void
	clearProgress: () => void
}

export interface UpdateContext {
	/** Version of the omp the extension is loaded into. */
	version: string
	io: UpdateIo
	/**
	 * Launcher to replace. Defaults to {@link resolveLauncherPath}; set it when
	 * the host runs the code outside its own launcher (tests, embedding).
	 */
	launcherPath?: string
}

/** Default concurrency; the CLI restricts requested values to its tier list. */
const DEFAULT_CONNECTIONS = 64
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024

function formatRate(bytesPerSecond: number): string {
	const mbps = bytesPerSecond / 1024 / 1024
	return `${mbps.toFixed(2)} MB/s`
}

function formatMegabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Resolve the release to install.
 *
 * With `--version` the version is taken verbatim (its release still has to
 * exist and be published, which {@link resolveReleaseAsset} enforces). Without
 * it, the channel's newest version comes from the npm registry — the same
 * source the stock updater uses, so both agree on what "latest" means.
 */
async function resolveTargetVersion(options: FastUpdateOptions, channel: Channel): Promise<string> {
	if (options.version !== undefined) return options.version
	return await resolveLatestVersion(channel)
}

/**
 * Run the update. Returns after the launcher has been replaced and verified, or
 * after reporting why nothing was installed.
 */
export async function runFastUpdate(options: FastUpdateOptions, context: UpdateContext): Promise<void> {
	const { io } = context
	const channel: Channel = options.channel ?? "stable"
	io.progress(`当前版本 omp/${context.version}，渠道 ${channel}`)

	const version = await resolveTargetVersion(options, channel)
	const comparison = compareVersions(version, context.version)
	const forced = options.force === true || options.version !== undefined

	if (comparison <= 0 && !forced) {
		io.clearProgress()
		io.notify(`已是最新版本（omp/${context.version}）`, "info")
		return
	}
	if (options.check === true) {
		io.clearProgress()
		io.notify(
			comparison > 0
				? `发现新版本：omp/${version}（当前 omp/${context.version}）。运行 /omp-update 安装。`
				: `omp/${version} 可重装（当前 omp/${context.version}）；--check 未做改动。`,
			"info",
		)
		return
	}
	io.progress(
		comparison > 0
			? `发现新版本 omp/${version}（当前 omp/${context.version}）`
			: `强制重装 omp/${version}（当前 omp/${context.version}）`,
	)

	const launcher = context.launcherPath ?? resolveLauncherPath()
	if (launcher === undefined) {
		io.clearProgress()
		io.notify("找不到 omp 启动器路径；请用 `omp update` 更新。", "error")
		return
	}
	const ownership = await classifyTarget(launcher)
	if (ownership.kind === "unsupported") {
		io.clearProgress()
		io.notify(`${ownership.reason}：${ownership.path}\n请用 \`omp update\` 更新该安装。`, "warning")
		return
	}

	const binaryName = binaryNameForHost()
	// Canary releases are published as GitHub prereleases, so the channel has to
	// authorize them here or `--canary` could never install anything.
	const asset = await resolveReleaseAsset(version, binaryName, channel === "canary")
	// Leftovers from earlier runs whose owning process has exited (a backup that
	// was still the running image back then, or a temp from a killed download).
	await sweepStaleArtifacts(ownership.path).catch(() => undefined)
	io.progress(`下载 ${binaryName}（${formatMegabytes(asset.size)}）…`)

	// The CLI validates the tier; the chunk count caps it further for small assets.
	const connections = options.connections ?? DEFAULT_CONNECTIONS
	const stagedPath = stagingPathFor(ownership.path)
	const startedAt = Date.now()
	let downloaded: DownloadResult
	try {
		downloaded = await downloadRanged({
			asset,
			targetPath: stagedPath,
			connections,
			chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
			onProgress: (done, total, rate) => {
				const percent = ((done / total) * 100).toFixed(1)
				io.progress(`下载中 ${percent}%（${formatMegabytes(done)}/${formatMegabytes(total)}，${formatRate(rate)}）`)
			},
		})
	} catch (error) {
		await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined)
		throw error
	}

	const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
	const rate = downloaded.bytes / elapsedSeconds
	if (downloaded.connections === 1) {
		io.progress(`服务器不支持分片，已用单连接下载；校验通过（${formatRate(rate)}）`)
	} else {
		io.progress(`校验通过（sha256），${downloaded.connections} 连接，${formatRate(rate)}`)
	}

	io.progress("正在替换启动器…")
	const result = await installStagedBinary({
		targetPath: ownership.path,
		stagedPath: downloaded.path,
		expectedVersion: version,
	})
	io.clearProgress()
	io.notify(
		`已更新到 omp/${version}（原 omp/${result.previousVersion ?? "未知"}），重启 omp 生效。`,
		"info",
	)
}
