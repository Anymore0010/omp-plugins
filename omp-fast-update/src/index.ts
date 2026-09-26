/**
 * omp-fast-update — a parallel (multi-connection) self-updater for omp.
 *
 * `omp update` downloads the release binary with a single HTTP stream. On
 * networks that throttle a single connection (common on cross-border links),
 * that download runs at a fraction of the available bandwidth while several
 * concurrent connections to the same asset scale nearly linearly. This
 * extension registers `/omp-update` (alias `/fast-update`), which:
 *
 * 1. asks the npm registry for the channel's newest version and resolves the
 *    platform asset (URL, size, `sha256:` digest) from GitHub release metadata;
 * 2. downloads it with N ranged connections writing into a preallocated file,
 *    then verifies size and digest against that metadata;
 * 3. replaces the launcher the way omp does — unique temp + backup beside the
 *    target, swap, `--version` verification, rollback on any mismatch.
 *
 * Only standalone-binary installs are handled. A symlink or script shim means
 * bun/npm/brew/mise owns the launcher, and the command reports that instead of
 * replacing it.
 *
 * Not affiliated with the omp project; MIT.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent"
import { runFastUpdate, type UpdateIo } from "./update"
import { parseArgs, USAGE } from "./cli"

/** omp version the extension is running inside. Read from `pi.pi`, not the CLI. */
function runningVersion(pi: ExtensionAPI): string {
  const version = (pi.pi as { VERSION?: unknown } | undefined)?.VERSION
  return typeof version === "string" ? version : "0.0.0"
}

/**
 * Presentation for one invocation.
 *
 * Print/RPC hosts have no status line, so progress falls back to stdout — that
 * is what makes `/omp-update` observable from `omp -p`.
 */
function ioFor(ctx: ExtensionCommandContext): UpdateIo {
  if (ctx.hasUI) {
    return {
      notify: (message, type) => ctx.ui.notify(message, type),
      progress: line => ctx.ui.setStatus("omp-fast-update", line),
      clearProgress: () => ctx.ui.setStatus("omp-fast-update", undefined),
    }
  }
  return {
    notify: (message, type) => console.log(`[omp-fast-update] ${type === "info" ? "" : `[${type}] `}${message}`),
    progress: line => console.log(`[omp-fast-update] ${line}`),
    clearProgress: () => {},
  }
}

export default async function fastUpdate(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Fast Update")

  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const io = ioFor(ctx)
    try {
      const parsed = parseArgs(args)
      if (parsed.kind === "error") {
        io.notify(parsed.message, "error")
        return
      }
      if (parsed.kind === "usage") {
        io.notify(USAGE, "info")
        return
      }
      await runFastUpdate(parsed.options, { version: runningVersion(pi), io })
    } catch (error) {
      io.notify(`更新失败：${error instanceof Error ? error.message : String(error)}`, "error")
    } finally {
      io.clearProgress()
    }
  }

  pi.registerCommand("omp-update", {
    description: "并发分片下载安装 omp 更新（绕过单连接限速）",
    handler,
  })
  pi.registerCommand("fast-update", {
    description: "并发分片下载安装 omp 更新（/omp-update 的别名）",
    handler,
  })
}
