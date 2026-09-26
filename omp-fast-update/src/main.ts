/**
 * `omp-fast-update` — standalone CLI entry for the parallel updater.
 *
 * `omp <subcommand>` cannot be extended by plugins (the CLI command table is
 * hardcoded in the host), so a terminal equivalent is provided as its own
 * executable: this file. Run it through Bun, or through the small launcher that
 * `installCliShim()` writes into the user's PATH so plain `omp-fast-update`
 * works the way `omp update` does.
 *
 * The flow, the verification, and the install/rollback logic are exactly the
 * extension's — this only supplies a terminal front end for `UpdateIo`.
 */

import { parseArgs, USAGE } from "./cli"
import { runFastUpdate } from "./update"
import { resolveLauncherPath, reportedVersionAt } from "./replace"
import { installCliShim, shimStatus, uninstallCliShim } from "./shim"

/** Version of the omp install being updated, read from the launcher itself. */
async function installedVersion(): Promise<string> {
	const launcher = resolveLauncherPath()
	const reported = launcher === undefined ? undefined : await reportedVersionAt(launcher)
	return reported ?? "0.0.0"
}

/** Print progress on one line, replacing the previous one on a TTY. */
function makeIo(): { io: Parameters<typeof runFastUpdate>[1]["io"]; done: () => void } {
	const tty = process.stdout.isTTY === true
	let lineOpen = false
	const write = (text: string, transient: boolean): void => {
		if (transient && tty) {
			process.stdout.write(`\r\x1b[2K${text}`)
			lineOpen = true
			return
		}
		if (lineOpen) {
			process.stdout.write("\n")
			lineOpen = false
		}
		process.stdout.write(`${text}\n`)
	}
	return {
		io: {
			progress: text => write(text, true),
			notify: (text, type) => write(type === "info" ? text : `[${type}] ${text}`, false),
			clearProgress: () => {
				if (lineOpen) {
					process.stdout.write("\r\x1b[2K")
					lineOpen = false
				}
			},
		},
		done: () => {
			if (lineOpen) process.stdout.write("\n")
		},
	}
}

/** Run the updater as a CLI. Exported so the shim and tests share one path. */
export async function main(argv: string[]): Promise<number> {
	// Shim management is separate from updating: it takes no updater options.
	if (argv.includes("--install-cli")) {
		const result = await installCliShim()
		console.log(`omp-fast-update: ${result.message}`)
		return result.ok ? 0 : 1
	}
	if (argv.includes("--status-cli")) {
		const result = await shimStatus()
		console.log(`omp-fast-update: ${result.message}`)
		return result.ok ? 0 : 1
	}
	if (argv.includes("--uninstall-cli")) {
		const result = await uninstallCliShim()
		console.log(`omp-fast-update: ${result.message}`)
		return result.ok ? 0 : 1
	}

	const parsed = parseArgs(argv.join(" "))
	if (parsed.kind === "usage") {
		console.log(USAGE)
		return 0
	}
	if (parsed.kind === "error") {
		console.error(`omp-fast-update: ${parsed.message}`)
		return 2
	}

	const { io, done } = makeIo()
	try {
		await runFastUpdate(parsed.options, { version: await installedVersion(), io })
		return 0
	} catch (error) {
		io.clearProgress()
		console.error(`omp-fast-update: 更新失败：${error instanceof Error ? error.message : String(error)}`)
		return 1
	} finally {
		done()
	}
}

// Only run when executed directly, not when imported by the extension or tests.
if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2))
}
