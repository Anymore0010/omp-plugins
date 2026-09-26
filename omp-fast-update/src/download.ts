/**
 * Parallel ranged downloader.
 *
 * The stock `omp update` fetches the release asset as one HTTP stream. On a
 * link that throttles per connection the result is ~0.2–0.7 MB/s, while eight
 * ranged connections to the same asset reach several MB/s. This module splits
 * the asset into fixed-size chunks, pulls them concurrently, writes each into a
 * preallocated file at its own offset, then verifies size and SHA-256 against
 * the GitHub release metadata.
 *
 * Correctness rules that matter here:
 * - Every chunk must deliver exactly its requested byte count; a short or
 *   partially-consumed body is an error, never accepted silently.
 * - Failures retry the whole chunk (never resume into the same range), so a
 *   truncated body can never overlap previously written bytes.
 * - The file is verified only after every chunk is complete, so a partial
 *   download is never presented as success.
 * - A server that refuses ranges falls back to a single streamed request with
 *   the same post-verification.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { once } from "node:events"

/** Verified asset descriptor: exactly what the GitHub release advertises. */
export interface RemoteAsset {
	url: string
	size: number
	/** `sha256:<64 hex>`. */
	digest: string
}

export interface DownloadOptions {
	asset: RemoteAsset
	targetPath: string
	connections: number
	chunkBytes: number
	/** Called with cumulative byte count and elapsed ms; throttled by the caller. */
	onProgress?: (done: number, total: number, bytesPerSecond: number) => void
	/** Aborting cancels the in-flight chunks and removes the partial file. */
	signal?: AbortSignal
	/** Attempts per chunk, including the first. */
	attempts?: number
}

/** Result of a successful ranged download. */
export interface DownloadResult {
	path: string
	bytes: number
	megabytesPerSecond: number
	connections: number
}

const RANGE_PROBE_BYTES = 1024
const DEFAULT_ATTEMPTS = 6
const RETRY_BASE_MS = 400
/**
 * Per-request deadline. Sized far above one chunk's transfer time (an 8 MiB
 * range even at 50 KB/s takes under 3 minutes) so it fires on a genuinely
 * stalled connection, not on a slow-but-progressing one. Without it a
 * half-open connection through a flaky proxy hangs the command forever.
 */
const CHUNK_TIMEOUT_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 30_000
/**
 * Overall deadline for one asset, mirroring the stock updater's 15-minute
 * download timeout. Generous enough for a 250 MB asset at ~300 KB/s.
 */
const OVERALL_TIMEOUT_MS = 20 * 60_000

/** Combine the caller's signal (cancel) with a deadline into one signal. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs)
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** True when the failure was a deadline rather than a caller cancellation. */
function isDeadlineError(error: unknown, signal: AbortSignal | undefined): boolean {
	return !(signal?.aborted ?? false) && (error as Error | undefined)?.name === "TimeoutError"
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("已取消"))
	const { promise, resolve, reject } = Promise.withResolvers<void>()
	const onAbort = (): void => {
		clearTimeout(timer)
		reject(new Error("已取消"))
	}
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort)
		resolve()
	}, ms)
	signal?.addEventListener("abort", onAbort, { once: true })
	return promise
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/** Probe whether the asset supports byte ranges and how large it really is. */
export async function probeAsset(
	url: string,
	signal?: AbortSignal,
): Promise<{ ranges: boolean; size?: number }> {
	const response = await fetch(url, {
		headers: { Range: `bytes=0-${RANGE_PROBE_BYTES - 1}` },
		redirect: "follow",
		signal: withDeadline(signal, PROBE_TIMEOUT_MS),
	})
	// Drain the probe body so the connection can be reused.
	await response.arrayBuffer().catch(() => undefined)
	if (response.status !== 206) return { ranges: false }
	const contentRange = response.headers.get("content-range")
	const size = contentRange === null ? undefined : Number.parseInt(contentRange.split("/").at(-1) ?? "", 10)
	return { ranges: true, size: Number.isSafeInteger(size) ? size : undefined }
}

async function hashFile(filePath: string): Promise<{ digest: string; bytes: number }> {
	const hash = createHash("sha256")
	let bytes = 0
	const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
	stream.on("data", chunk => {
		bytes += chunk.length
		hash.update(chunk)
	})
	await once(stream, "end")
	return { digest: `sha256:${hash.digest("hex")}`, bytes }
}

/**
 * Download one ranged chunk into an open handle, retrying from scratch on any
 * short/corrupt body.
 */
async function fetchChunk(
	url: string,
	handle: fs.promises.FileHandle,
	start: number,
	end: number,
	attempts: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const want = end - start + 1
	let lastError = "unknown"
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (signal?.aborted) throw new Error("已取消")
		try {
			const response = await fetch(url, {
				headers: { Range: `bytes=${start}-${end}` },
				redirect: "follow",
				signal: withDeadline(signal, CHUNK_TIMEOUT_MS),
			})
			if (response.status !== 206) {
				throw new Error(`分片请求返回 HTTP ${response.status}（期望 206）`)
			}
			if (!response.body) throw new Error("分片响应没有 body")

			let offset = start
			let received = 0
			for await (const chunk of response.body) {
				const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike)
				if (received + view.byteLength > want) throw new Error("分片响应超出请求范围")
				await handle.write(view, 0, view.byteLength, offset)
				offset += view.byteLength
				received += view.byteLength
			}
			if (received !== want) throw new Error(`分片不完整：收到 ${received}/${want} 字节`)
			return
		} catch (error) {
			if (signal?.aborted) throw new Error("已取消")
			lastError = isDeadlineError(error, signal) ? `请求超时（>${CHUNK_TIMEOUT_MS / 60_000} 分钟）` : describeError(error)
			if (attempt + 1 < attempts) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
		}
	}
	throw new Error(`分片 ${start}-${end} 重试 ${attempts} 次仍失败：${lastError}`)
}

/**
 * Verify a finished file against the release metadata: exact size and SHA-256.
 * Removes the file and throws on any mismatch, so a returned path is always a
 * fully verified artifact.
 */
async function verifyFile(filePath: string, asset: RemoteAsset): Promise<{ bytes: number; digest: string }> {
	const { digest, bytes } = await hashFile(filePath)
	if (bytes !== asset.size) {
		await fs.promises.rm(filePath, { force: true })
		throw new Error(`下载大小不符：${bytes}/${asset.size} 字节`)
	}
	if (digest !== asset.digest.toLowerCase()) {
		await fs.promises.rm(filePath, { force: true })
		throw new Error(`SHA-256 校验失败：期望 ${asset.digest}，实际 ${digest}`)
	}
	return { bytes, digest }
}

/** Single-stream fallback used when the host refuses ranged requests. */
async function downloadSingleStream(options: DownloadOptions, startedAt: number): Promise<DownloadResult> {
	const { asset, targetPath, signal } = options
	const response = await fetch(asset.url, { redirect: "follow", signal })
	if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
	const handle = await fs.promises.open(targetPath, "w")
	let received = 0
	try {
		for await (const chunk of response.body) {
			const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike)
			await handle.write(view)
			received += view.byteLength
			options.onProgress?.(received, asset.size, received / Math.max((Date.now() - startedAt) / 1000, 0.001))
		}
	} catch (error) {
		await handle.close()
		await fs.promises.rm(targetPath, { force: true }).catch(() => undefined)
		throw error
	}
	await handle.close()
	try {
		await verifyFile(targetPath, asset)
	} catch (error) {
		await fs.promises.rm(targetPath, { force: true }).catch(() => undefined)
		throw error
	}
	const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001)
	return { path: targetPath, bytes: received, megabytesPerSecond: received / 1024 / 1024 / elapsed, connections: 1 }
}

/**
 * Download `options.asset` to `options.targetPath` with N parallel ranged
 * connections, verifying size and digest before returning.
 *
 * The caller owns the destination path: on any failure the partial file is
 * removed, so a returned path is always a fully verified artifact.
 */
export async function downloadRanged(options: DownloadOptions): Promise<DownloadResult> {
	const { asset, targetPath } = options
	const startedAt = Date.now()
	await fs.promises.rm(targetPath, { force: true })

	// One deadline for the whole asset, on top of the per-request one, so a
	// connection that keeps trickling forever cannot extend the command
	// indefinitely. Cancellation still propagates from the caller's signal.
	const deadline = withDeadline(options.signal, OVERALL_TIMEOUT_MS)
	const scoped: DownloadOptions = { ...options, signal: deadline }
	try {
		return await downloadScoped(scoped, startedAt)
	} catch (error) {
		if (isDeadlineError(error, options.signal)) {
			throw new Error(`下载超时（>${OVERALL_TIMEOUT_MS / 60_000} 分钟），已取消`)
		}
		throw error
	}
}

async function downloadScoped(options: DownloadOptions, startedAt: number): Promise<DownloadResult> {
	const { asset, targetPath } = options

	const probe = await probeAsset(asset.url, options.signal)
	if (!probe.ranges) return downloadSingleStream(options, startedAt)
	if (probe.size !== undefined && probe.size !== asset.size) {
		throw new Error(`服务器报告的资产大小 ${probe.size} 与发布元数据 ${asset.size} 不一致`)
	}

	// An explicit --chunk is a ceiling, not a target: splitting a 225 MB asset
	// into 8 MB chunks yields only 29 pieces, so asking for 64 connections would
	// silently run 29. Shrink the chunk as needed to make the requested
	// connection count reachable, floored at 1 MB so a small asset does not turn
	// into thousands of requests (the CLI enforces the same 1 MB minimum).
	const requestedChunk = Math.max(options.chunkBytes, 1024 * 1024)
	const chunkBytes = Math.max(
		1024 * 1024,
		Math.min(requestedChunk, Math.ceil(asset.size / options.connections)),
	)
	const chunkCount = Math.ceil(asset.size / chunkBytes)
	const connections = Math.max(1, Math.min(options.connections, chunkCount))
	const handle = await fs.promises.open(targetPath, "w+")
	await handle.truncate(asset.size)

	let done = 0
	let nextChunk = 0
	let lastReport = 0
	try {
		const worker = async (): Promise<void> => {
			for (;;) {
				if (options.signal?.aborted) throw new Error("已取消")
				const index = nextChunk++
				if (index >= chunkCount) return
				const start = index * chunkBytes
				const end = Math.min(start + chunkBytes, asset.size) - 1
				await fetchChunk(asset.url, handle, start, end, options.attempts ?? DEFAULT_ATTEMPTS, options.signal)
				done += end - start + 1
				const now = Date.now()
				if (options.onProgress && now - lastReport > 250) {
					lastReport = now
					const elapsed = Math.max((now - startedAt) / 1000, 0.001)
					options.onProgress(done, asset.size, done / elapsed)
				}
			}
		}
		await Promise.all(Array.from({ length: connections }, () => worker()))
	} catch (error) {
		await handle.close()
		await fs.promises.rm(targetPath, { force: true })
		throw error
	}
	await handle.close()

	const { bytes } = await verifyFile(targetPath, asset)

	const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001)
	return { path: targetPath, bytes, megabytesPerSecond: bytes / 1024 / 1024 / elapsed, connections }
}
