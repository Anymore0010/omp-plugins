/**
 * Release resolution for omp self-update.
 *
 * Mirrors the stock updater's resolution order so the installed version is the
 * same one `omp update` would have chosen:
 *
 * 1. npm registry manifest (`latest`, or the `canary` dist-tag) — no rate
 *    limit, which is why omp uses it instead of the GitHub API;
 * 2. GitHub release metadata for `v<version>`, which supplies the asset URL,
 *    size, and `sha256:` digest that the download is verified against.
 *
 * The npm manifest is also the channel switch: `omp.dist` decides binary vs
 * npm distribution, and higher-major releases fall back to the binary asset.
 */

import * as fs from "node:fs"

import type { RemoteAsset } from "./download"

/** Distribution channel selected for this run. */
export type Channel = "stable" | "canary"

const REPO = "can1357/oh-my-pi"
const PACKAGE = "@oh-my-pi/pi-coding-agent"
const NPM_REGISTRY = "https://registry.npmjs.org/"
const GITHUB_API = "https://api.github.com"
const METADATA_TIMEOUT_MS = 30_000

/** npm's `latest` can lag or lead the GitHub release; the asset must exist for the resolved version. */
export interface ReleaseInfo {
	version: string
	/** True when the release's own manifest declares a non-npm distribution. */
	binaryOnly: boolean
}

function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
}

interface JsonObject {
	[key: string]: unknown
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

/**
 * Resolve the newest version for a channel from the npm registry.
 *
 * Returns the registry's exact version string; callers MUST treat a GitHub
 * release with that tag as authoritative before downloading, because a fresh
 * publish can be visible in npm before its release assets finish uploading.
 */
export async function resolveLatestVersion(channel: Channel): Promise<string> {
	const tag = channel === "canary" ? "canary" : "latest"
	const response = await fetchWithTimeout(`${NPM_REGISTRY}${PACKAGE}/${tag}`)
	if (response.status === 404 && channel === "canary") {
		throw new Error("尚无 canary 版本发布；用 --stable 回到稳定渠道")
	}
	if (!response.ok) throw new Error(`查询 npm registry 失败：HTTP ${response.status}`)
	const body = asObject(await response.json())
	const version = body?.["version"]
	if (typeof version !== "string") throw new Error("npm registry 返回的清单缺少 version 字段")
	return version
}

/** Platform asset name for the running host, mirroring omp's own mapping. */
export function binaryNameForHost(platform: string = process.platform, arch: string = process.arch): string {
	const archName = arch === "arm64" ? "arm64" : "x64"
	if (platform === "win32") return `omp-windows-${archName}.exe`
	if (platform === "darwin") return `omp-darwin-${archName}`
	const os = isMuslHost() ? "linux-musl" : "linux"
	return `omp-${os}-${archName}`
}

/**
 * Detect a musl libc host so an Alpine install is updated with the musl asset
 * instead of the glibc one (which fails to start). The presence of the Alpine
 * marker file is decisive; otherwise `ldd --version` names the libc.
 */
function isMuslHost(): boolean {
	if (process.platform !== "linux") return false
	if (fs.existsSync("/etc/alpine-release")) return true
	try {
		const result = Bun.spawnSync(["ldd", "--version"])
		const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
		return /\bmusl\b/iu.test(output)
	} catch {
		return false
	}
}

/** Resolve the asset URL, size, and digest for a release from GitHub metadata. */
export async function resolveReleaseAsset(version: string, binaryName: string): Promise<RemoteAsset> {
	const tag = `v${version}`
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	}
	const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]
	if (token !== undefined && token.length > 0) headers["Authorization"] = `Bearer ${token}`

	const response = await fetchWithTimeout(`${GITHUB_API}/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
		headers,
	})
	if (response.status === 403 || response.status === 429) {
		throw new Error("GitHub API 限流；设置 GITHUB_TOKEN 或 GH_TOKEN 后重试")
	}
	if (!response.ok) throw new Error(`获取 GitHub release ${tag} 失败：HTTP ${response.status}`)

	const release = asObject(await response.json())
	if (release === undefined) throw new Error(`GitHub release ${tag} 元数据格式无效`)
	if (release["tag_name"] !== tag) throw new Error(`GitHub release tag 不匹配：期望 ${tag}`)
	if (release["draft"] !== false) throw new Error(`GitHub release ${tag} 仍是草稿`)
	if (release["prerelease"] !== false) throw new Error(`GitHub release ${tag} 是预发布版本`)

	const assets = release["assets"]
	if (!Array.isArray(assets)) throw new Error(`GitHub release ${tag} 没有资产列表`)
	const matches = assets.filter(asset => asObject(asset)?.["name"] === binaryName)
	if (matches.length !== 1) throw new Error(`GitHub release ${tag} 中名为 ${binaryName} 的资产有 ${matches.length} 个`)
	const asset = asObject(matches[0])
	if (asset === undefined || asset["state"] !== "uploaded") throw new Error(`资产 ${binaryName} 尚未上传完成`)
	const size = asset["size"]
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
		throw new Error(`资产 ${binaryName} 的 size 无效`)
	}
	const digestField = asset["digest"]
	const digest = typeof digestField === "string" ? /^sha256:([0-9a-f]{64})$/iu.exec(digestField)?.[1] : undefined
	if (digest === undefined) throw new Error(`资产 ${binaryName} 缺少可用的 sha256 digest`)

	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`
	if (asset["browser_download_url"] !== url) throw new Error(`资产 ${binaryName} 的下载地址不符合预期`)

	return { url, size, digest: `sha256:${digest.toLowerCase()}` }
}

/** Compare two dotted versions; a missing prerelease sorts above the bare release. */
export function compareVersions(left: string, right: string): number {
	const split = (value: string): { numbers: number[]; pre: string } => {
		const [core = "", pre = ""] = value.split("-", 2) as [string, string?]
		return { numbers: core.split(".").map(part => Number.parseInt(part, 10) || 0), pre }
	}
	const a = split(left)
	const b = split(right)
	for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index++) {
		const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
		if (difference !== 0) return difference > 0 ? 1 : -1
	}
	if (a.pre === b.pre) return 0
	if (a.pre.length === 0) return 1
	if (b.pre.length === 0) return -1
	return a.pre > b.pre ? 1 : -1
}
