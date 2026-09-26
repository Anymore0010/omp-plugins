/**
 * Argument parsing for `/omp-update`.
 *
 * Kept separate from the update flow so the flag surface can be unit-tested
 * and the usage text has a single home.
 */

/** Options accepted by `/omp-update`. */
export interface FastUpdateOptions {
	/** Resolve the release and compare versions, but install nothing. */
	check: boolean
	/** Reinstall even when the running version is already current. */
	force: boolean
	/** Distribution channel; undefined means "stable unless `--canary`/`--stable` says otherwise". */
	channel?: "stable" | "canary"
	/** Install this exact version instead of the channel's newest. */
	version?: string
	/** Ranged connections to run in parallel. */
	connections?: number
	/** Bytes per ranged request. */
	chunkBytes?: number
}

/** Outcome of parsing the raw command argument text. */
export type ParsedArgs =
	| { kind: "ok"; options: FastUpdateOptions }
	| { kind: "usage" }
	| { kind: "error"; message: string }

const MIN_CONNECTIONS = 1
const MAX_CONNECTIONS = 32
const MIN_CHUNK_MB = 1
const MAX_CHUNK_MB = 128

function parsePositiveInt(raw: string, flag: string, min: number, max: number): number | string {
	if (!/^\d+$/u.test(raw)) return `${flag} 需要一个正整数，收到 "${raw}"`
	const value = Number.parseInt(raw, 10)
	if (value < min || value > max) return `${flag} 必须在 ${min}–${max} 之间，收到 ${value}`
	return value
}

/**
 * Parse the argument string of a slash command.
 *
 * Unknown flags are rejected rather than ignored: silently dropping a typo
 * (`--canry`) would update the stable channel while the user believes
 * otherwise.
 */
export function parseArgs(raw: string): ParsedArgs {
	const options: FastUpdateOptions = { check: false, force: false }
	const tokens = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/u)

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as string
		const equals = token.indexOf("=")
		const name = equals === -1 ? token : token.slice(0, equals)
		const inline = equals === -1 ? undefined : token.slice(equals + 1)
		const takeValue = (): string | undefined => {
			if (inline !== undefined) return inline.length > 0 ? inline : undefined
			const next = tokens[index + 1]
			if (next === undefined || next.startsWith("-")) return undefined
			index++
			return next
		}

		switch (name) {
			case "-h":
			case "--help":
				return { kind: "usage" }
			case "-c":
			case "--check":
				options.check = true
				break
			case "-f":
			case "--force":
				options.force = true
				break
			case "--canary":
				if (options.channel === "stable") return { kind: "error", message: "--canary 与 --stable 互斥" }
				options.channel = "canary"
				break
			case "--stable":
				if (options.channel === "canary") return { kind: "error", message: "--canary 与 --stable 互斥" }
				options.channel = "stable"
				break
			case "-j":
			case "--connections": {
				const value = takeValue()
				if (value === undefined) return { kind: "error", message: `${name} 需要一个参数` }
				const parsed = parsePositiveInt(value, name, MIN_CONNECTIONS, MAX_CONNECTIONS)
				if (typeof parsed === "string") return { kind: "error", message: parsed }
				options.connections = parsed
				break
			}
			case "--chunk": {
				const value = takeValue()
				if (value === undefined) return { kind: "error", message: `${name} 需要一个参数（单位 MB）` }
				const parsed = parsePositiveInt(value, name, MIN_CHUNK_MB, MAX_CHUNK_MB)
				if (typeof parsed === "string") return { kind: "error", message: parsed }
				options.chunkBytes = parsed * 1024 * 1024
				break
			}
			case "-v":
			case "--version": {
				const value = takeValue()
				if (value === undefined) return { kind: "error", message: `${name} 需要一个版本号，如 18.3.2` }
				if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
					return { kind: "error", message: `版本号格式无效："${value}"` }
				}
				options.version = value
				break
			}
			default:
				return { kind: "error", message: `未知参数 "${token}"（/omp-update --help 查看用法）` }
		}
	}

	if (options.channel !== undefined && options.version !== undefined) {
		return { kind: "error", message: "--canary/--stable 与 --version 不能同时使用" }
	}
	return { kind: "ok", options }
}

/** Usage text shown for `--help`. */
export const USAGE = `omp-fast-update — 并发分片安装 omp 更新

用法：
  /omp-update [选项]

选项：
  -c, --check            只检查是否有新版本，不安装
  -f, --force            即使已是最新也强制重装
      --canary           使用 canary 渠道
      --stable           使用 stable 渠道
  -v, --version <X.Y.Z>  安装指定版本（等价于 --force）
  -j, --connections <N>  并发分片连接数（1-32，默认 8）
      --chunk <MB>       每个分片大小，单位 MB（1-128，默认 8）

仅适用于独立二进制安装（~/.local/bin 或 AppData 下的 omp 可执行文件）。
brew / mise / nix / npm / bun 管理的安装请继续用 \`omp update\`。`
