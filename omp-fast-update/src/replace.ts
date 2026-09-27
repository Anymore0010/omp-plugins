/**
 * Launcher replacement, mirroring `omp update`'s install step.
 *
 * Steps, in order, with the same guarantees the stock updater documents:
 *
 * 1. The target launcher must be a standalone omp executable — a script shim
 *    (`omp`, `omp.cmd`, `omp.ps1`), a symlink, or a foreign binary means the
 *    install is owned by bun/npm/brew/mise and must be updated by `omp update`.
 * 2. The download lands on `<target>.<stamp>.new` — unique per attempt so two
 *    overlapping updates never share a temp or delete each other's file.
 * 3. The swap renames the current launcher to `<target>.<stamp>.bak`, moves the
 *    temp into place, and runs `<target> --version`; a mismatch restores the
 *    backup. Renaming the running executable is permitted on Windows, deleting
 *    its mapped image is not, so the backup is left for a later run.
 * 4. The swap is serialized per target with an advisory lock file, matching the
 *    stock updater's `withFileLock(targetPath)`.
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** How the launcher is owned, which decides whether this updater may replace it. */
export type TargetOwnership =
	| { kind: "binary"; path: string }
	| { kind: "unsupported"; path: string; reason: string }

const SHELL_SHIM_EXTENSIONS: Record<string, true> = {
	"": true,
	".cmd": true,
	".bat": true,
	".ps1": true,
	".sh": true,
}
/** Mirrors the stock updater's download window: stale temps older than this are reapable. */
const DOWNLOAD_WINDOW_MS = 15 * 60_000

/**
 * Decide whether `launcherPath` may be replaced with the release binary.
 *
 * A `.exe` (or extensionless native binary) that is neither a symlink nor a
 * shebang script is the standalone install this updater owns. Everything else
 * is reported with the installer that does own it.
 */
export async function classifyTarget(launcherPath: string): Promise<TargetOwnership> {
	let stat: fs.Stats
	try {
		stat = await fs.promises.lstat(launcherPath)
	} catch {
		return { kind: "unsupported", path: launcherPath, reason: "找不到可执行文件" }
	}
	if (stat.isSymbolicLink()) {
		return { kind: "unsupported", path: launcherPath, reason: "启动器是符号链接（由 bun/npm 管理）" }
	}

	const extension = path.extname(launcherPath).toLowerCase()
	const head = await fs.promises
		.open(launcherPath, "r")
		.then(async handle => {
			try {
				const buffer = Buffer.alloc(2)
				await handle.read(buffer, 0, 2, 0)
				return buffer.toString("latin1")
			} finally {
				await handle.close()
			}
		})
		.catch(() => "")

	if (head === "#!") {
		return { kind: "unsupported", path: launcherPath, reason: "启动器是脚本 shim（由 npm/bun 管理）" }
	}
	if (process.platform === "win32" && extension !== ".exe") {
		return { kind: "unsupported", path: launcherPath, reason: `Windows 启动器不是 .exe（${extension || "无扩展名"}）` }
	}
	if (process.platform !== "win32" && SHELL_SHIM_EXTENSIONS[extension] === true) {
		return { kind: "unsupported", path: launcherPath, reason: "启动器是 shell 脚本（由包管理器管理）" }
	}
	return { kind: "binary", path: launcherPath }
}

/**
 * Path `omp` resolves to in PATH, or `process.execPath` as a fallback.
 *
 * `Bun.which` covers the launcher a shell would run; `execPath` covers a
 * bundled build whose launcher is not on PATH at all.
 */
export function resolveLauncherPath(): string | undefined {
	const found = Bun.which("omp")
	if (found !== null && !/^bun$/iu.test(path.basename(found))) return found
	const execPath = process.execPath
	if (execPath.length === 0) return undefined
	// A source run (`bun src/cli.ts`) has the bun runtime as execPath; replacing
	// that with the release binary would be wrong.
	if (/^bun(\.exe)?$/iu.test(path.basename(execPath))) return undefined
	return execPath
}

/** Exclusive advisory lock beside the target, so two updates never swap concurrently. */
async function withTargetLock<T>(targetPath: string, action: () => Promise<T>): Promise<T> {
	const lockPath = `${targetPath}.fast-update.lock`
	const deadline = Date.now() + 20_000
	let handle: fs.promises.FileHandle | undefined
	for (;;) {
		try {
			handle = await fs.promises.open(lockPath, "wx")
			break
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "EEXIST") throw error
			// A crashed run can leave the lock behind; reclaim it once it is old.
			const age = await fs.promises
				.stat(lockPath)
				.then(stat => Date.now() - stat.mtimeMs)
				.catch(() => 0)
			if (age > 60_000) {
				await fs.promises.rm(lockPath, { force: true })
				continue
			}
			if (Date.now() > deadline) throw new Error("等待其他 omp 更新释放锁超时")
			await Bun.sleep(150)
		}
	}
	try {
		return await action()
	} finally {
		await handle.close().catch(() => undefined)
		await fs.promises.rm(lockPath, { force: true }).catch(() => undefined)
	}
}

/** Version a launcher reports, parsed from `omp/X.Y.Z` output. */
export async function reportedVersionAt(binaryPath: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" })
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
		if (exitCode !== 0) return undefined
		const match = /^omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(stdout.trim())
		return match?.[1]
	} catch {
		return undefined
	}
}

export interface InstallOptions {
	targetPath: string
	/** Fully verified binary sitting beside the target. */
	stagedPath: string
	expectedVersion: string
}

export interface InstallResult {
	path: string
	previousVersion?: string
	/** Backup kept beside the target as a rollback point, when one was made. */
	backupPath?: string
}

/**
 * Swap `stagedPath` over `targetPath`, verifying by executing the launcher.
 *
 * Every failure after the launcher was moved aside restores it — a rename that
 * fails (a lock another process holds, a full disk) must not leave the host
 * with no `omp` at all. On success the previous binary is kept as `<target>`
 * plus {@link ARTIFACT_MARKER}, exactly the rollback point `omp update` leaves
 * behind, and reclaimed by age on later runs.
 */
export async function installStagedBinary(options: InstallOptions): Promise<InstallResult> {
	return await withTargetLock(options.targetPath, async () => {
		const stamp = `${Date.now()}.${process.pid}.${stagingSeq++}`
		const backupPath = `${options.targetPath}${ARTIFACT_MARKER}.${stamp}.bak`
		const previousVersion = await reportedVersionAt(options.targetPath)

		// Reap earlier backups BEFORE creating this one, so the retained rollback
		// point is always exactly the immediately previous version — the same
		// steady state `omp update` reaches (it deletes its backup too; on Windows
		// the running-image lock is what makes one survive). Doing this first also
		// keeps the fresh backup out of the sweep's reach, so no age bookkeeping
		// is needed to protect it.
		await sweepStaleArtifacts(options.targetPath, { keep: options.stagedPath })

		let backupReady = false
		try {
			await fs.promises.rename(options.targetPath, backupPath)
			backupReady = true
		} catch (error) {
			// A missing target is tolerated: the release binary is simply placed at
			// a vacant path, and there is nothing to restore on failure.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}

		/** Put the original launcher back, if one was moved aside. */
		const rollback = async (): Promise<void> => {
			if (!backupReady) return
			await fs.promises.rm(options.targetPath, { force: true }).catch(() => undefined)
			await fs.promises.rename(backupPath, options.targetPath).catch(() => undefined)
		}

		try {
			await fs.promises.rename(options.stagedPath, options.targetPath)
		} catch (error) {
			await rollback()
			throw new Error(
				`无法替换启动器：${error instanceof Error ? error.message : String(error)}${
					backupReady ? "；已恢复原启动器" : ""
				}`,
			)
		}
		try {
			if (process.platform !== "win32") await fs.promises.chmod(options.targetPath, 0o755)
		} catch {
			// A filesystem without POSIX modes is fine; the swap already landed.
		}

		const actual = await reportedVersionAt(options.targetPath)
		if (actual !== options.expectedVersion) {
			await rollback()
			throw new Error(
				`安装后版本校验失败：期望 ${options.expectedVersion}，实际 ${actual ?? "无法执行"}${
					backupReady ? "；已恢复原启动器" : ""
				}`,
			)
		}

		// Swap verified. The previous binary stays beside the target as the
		// rollback point — the steady state `omp update` also reaches. Earlier
		// backups were already reaped before this one was created, so exactly one
		// is kept and none accumulate.
		return { path: options.targetPath, previousVersion, backupPath: backupReady ? backupPath : undefined }
	})
}

/**
 * Marker embedded in this plugin's artifact names.
 *
 * The stock updater writes `<binary>.<timestamp>.<pid>.<seq>.(new|bak)` and
 * reclaims anything matching that numeric shape. If this plugin wrote the same
 * names, its sweeper and omp's would each delete the other's files — the user's
 * only rollback copy included. Every artifact this plugin creates carries
 * {@link ARTIFACT_MARKER}, and the sweeper ignores everything else, so the two
 * updaters can never reap each other's backups.
 */
const ARTIFACT_MARKER = ".ompfastupdate"

/**
 * Remove this plugin's own earlier `<target>.*.ompfastupdate.(new|bak)` files.
 *
 * Only artifacts carrying {@link ARTIFACT_MARKER} are considered, so the stock
 * updater's `<binary>.<numbers>.bak` is never touched — that one is the user's
 * rollback point and omp reclaims it itself.
 *
 * `.bak` files are reaped unconditionally, matching `omp update`'s own sweep
 * (`sweepStaleUpdateArtifacts` only age-gates `.new`). Callers therefore run
 * this BEFORE creating the new backup, which leaves exactly one backup behind:
 * the immediately previous version. `.new` keeps its age gate because a temp
 * file may belong to a download still in flight.
 *
 * Deletion is best effort: Windows refuses to unlink a mapped image, so a locked
 * file simply survives until its owning process exits.
 */
export async function sweepStaleArtifacts(targetPath: string, options: { keep?: string } = {}): Promise<void> {
	const dir = path.dirname(targetPath)
	const base = path.basename(targetPath)
	let entries: string[]
	try {
		entries = await fs.promises.readdir(dir)
	} catch {
		return
	}
	const now = Date.now()
	// Compare on resolved paths: `path.join` normalizes separators, so a caller's
	// forward-slash staging path would not string-match the joined entry.
	const keep = options.keep === undefined ? undefined : path.resolve(options.keep)
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.includes(ARTIFACT_MARKER)) continue
		const full = path.join(dir, entry)
		// Never reap a file this install is about to use (the staged binary shares
		// the marker and may carry an inherited mtime).
		if (keep !== undefined && path.resolve(full) === keep) continue
		const suffix = entry.endsWith(".new") ? ".new" : entry.endsWith(".bak") ? ".bak" : undefined
		if (suffix === undefined) continue
		if (suffix === ".new") {
			const age = await fs.promises
				.stat(full)
				.then(stat => now - stat.mtimeMs)
				.catch(() => 0)
			if (age < DOWNLOAD_WINDOW_MS) continue
		}
		await fs.promises.rm(full, { force: true }).catch(() => undefined)
	}
}

/**
 * Monotonic per-process counter so two stagings in the same millisecond (same
 * pid, same `Date.now()`) still get distinct paths — a collision would make the
 * second update delete the first one's temp file.
 */
let stagingSeq = 0

/**
 * Unique staging path beside the target, so the swap is a same-volume rename.
 *
 * The {@link ARTIFACT_MARKER} in the name is what keeps this plugin's sweeper
 * and the stock updater's from reclaiming each other's files.
 */
export function stagingPathFor(targetPath: string): string {
	return `${targetPath}${ARTIFACT_MARKER}.${Date.now()}.${process.pid}.${stagingSeq++}.new`
}
