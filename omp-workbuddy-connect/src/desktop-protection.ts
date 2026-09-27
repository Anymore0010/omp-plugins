/**
 * WorkBuddy 5.6+ at-rest credential protection.
 *
 * Since WorkBuddy 5.6 the desktop app writes `auth.accessToken` and
 * `auth.refreshToken` as `{$wbEncrypted:1, envelope}` wrappers instead of plain
 * strings. Everything needed to open them lives on the same machine:
 *
 * 1. the sealed payload (`{version:1, atRestSecretKey}`) is exposed by the
 *    WorkBuddy-modified Electron's private `workbuddyStorage` binding — the
 *    binding only exists when *its own* binary runs, so it is spawned once
 *    with `ELECTRON_RUN_AS_NODE=1` (an extension host has no `_linkedBinding`);
 * 2. `protectorKey = sha256(atRestSecretKey, utf8)` (32 bytes) opens the
 *    envelopes with AES-256-GCM under the app's own AAD.
 *
 * Both the AAD layout and the payload schema are transcribed from the app
 * bundle and verified live against 5.6.2. Nothing here writes to the desktop
 * app, logs key material, or caches the key to disk: the protector key lives
 * in memory for the process lifetime and is re-resolved when an envelope names
 * a different key id.
 */

import { execFile } from "node:child_process"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { createDecipheriv, createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"

/** Overrides the WorkBuddy binary spawned as the key helper. */
export const WORKBUDDY_ELECTRON_BIN_ENV = "WORKBUDDY_ELECTRON_BIN"

/** The helper script: print the sealed payload and nothing else. */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

/** Registry roots carrying uninstall records with a `DisplayIcon` path. */
const WINDOWS_UNINSTALL_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const

/** The app registers this URL scheme, and the command names its own binary. */
const WINDOWS_PROTOCOL_COMMAND_KEY = "HKCU\\Software\\Classes\\workbuddy\\shell\\open\\command"

/** Absolute: `join` of a bare first segment would be a relative path. */
const MACOS_ELECTRON_PATH = "/Applications/WorkBuddy.app/Contents/MacOS/Electron"
const WINDOWS_DEFAULT_RELATIVE = ["Programs", "WorkBuddy", "WorkBuddy.exe"] as const

const WINDOWS_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const WINDOWS_WORKBUDDY_DISPLAY_NAME_PATTERN = /^WorkBuddy(?:\s+\d+(?:\.\d+)*)?/u

/** A key-helper spawn that yielded nothing usable, with the reason attached. */
export type HelperFailure = "no-binary" | "spawn-failed" | "empty-output" | "invalid-payload" | "key-mismatch"

export class WorkBuddyKeyUnavailableError extends Error {
  constructor(readonly failure: HelperFailure, message: string) {
    super(message)
    this.name = "WorkBuddyKeyUnavailableError"
  }
}

/** One envelope's decoded parts, as the app writes them. */
export interface WorkBuddyEnvelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** One at-rest encrypted text field, with its envelope decoded. */
export interface WrappedAuthField {
  field: string
  envelope: WorkBuddyEnvelope
}

/**
 * A desktop auth document, discriminated on `format`. `encrypted` carries the
 * whole parsed document plus the fields still in wrappers so the caller can
 * rebuild plaintext text and hand it to the ordinary parser — identity and
 * expiry fields keep working without a second code path.
 */
export type DesktopAuthClassification =
  | { format: "absent" }
  | { format: "plaintext" }
  | { format: "encrypted"; document: Record<string, unknown>; fields: readonly WrappedAuthField[] }
  | { format: "unrecognized" }

const AUTH_FIELDS = ["accessToken", "refreshToken"] as const

/** Decode canonical base64, enforcing an exact byte length when given. */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== "string" || value === "") return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, "base64")
  } catch {
    return undefined
  }
  // `Buffer.from` tolerates stray characters; require the round-trip so a
  // tampered envelope is rejected before any key material is involved.
  if (decoded.length === 0) return undefined
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

/**
 * Decode one `{$wbEncrypted:1, envelope}` wrapper. Anything claiming the flag
 * whose envelope cannot be decoded returns `undefined`, which makes the whole
 * document `unrecognized` rather than `encrypted` — no key could ever open it.
 */
function parseWrappedField(field: string, value: unknown): WrappedAuthField | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const wrapper = value as Record<string, unknown>
  if (wrapper.$wbEncrypted !== 1 || typeof wrapper.envelope !== "string") return undefined
  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(wrapper.envelope, "base64").toString("utf8"))
  } catch {
    return undefined
  }
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined
  const envelope = inner as Record<string, unknown>
  const nonce = parseBase64(envelope.nonce, 12)
  const authTag = parseBase64(envelope.authTag, 16)
  const ciphertext = parseBase64(envelope.ciphertext)
  const suite = envelope.suite
  const keyId = envelope.keyId
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof suite !== "number" || !Number.isInteger(suite) || suite !== 1) return undefined
  if (typeof keyId !== "string" || !/^[0-9a-f]{16}$/u.test(keyId)) return undefined
  return { field, envelope: { suite, keyId, nonce, authTag, ciphertext } }
}

/**
 * Decode a `{$wbEncrypted:1, envelope}` text field with an explicit key.
 * Exported so identity fields outside {@link AUTH_FIELDS} (nickname) can be
 * opened by the same code the classification path validated.
 */
export function openWrappedText(key: Buffer, value: unknown): string | undefined {
  const wrapped = parseWrappedField("", value)
  if (wrapped === undefined) return undefined
  return openAuthField(key, wrapped.envelope)
}

/** Read a desktop auth document's format without touching any key material. */
export function classifyDesktopAuthDocument(text: string): DesktopAuthClassification {
  if (text.trim() === "") return { format: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: "unrecognized" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { format: "unrecognized" }
  const document = parsed as Record<string, unknown>
  const auth = typeof document.auth === "object" && document.auth !== null && !Array.isArray(document.auth)
    ? (document.auth as Record<string, unknown>)
    : document
  const fields: WrappedAuthField[] = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === "string") continue
    const wrapped = parseWrappedField(field, value)
    // A field present in some other shape is neither plaintext nor openable.
    if (wrapped === undefined && value !== undefined) return { format: "unrecognized" }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: "plaintext" }
  return { format: "encrypted", document, fields }
}

/**
 * The authenticated-context AAD for one credential field envelope, as the app
 * builds it: domain prefix, framing id, scheme, suite, key id, then the
 * framing/sequence bytes credential fields always carry.
 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8")
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** Open one envelope; `undefined` when the key or format does not match. */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8")
  } catch {
    return undefined
  }
}

/** Validate the helper payload under the app's own rules. */
export function parseAtRestPayload(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  if (payload.version !== 1) return undefined
  const secret = payload.atRestSecretKey
  if (typeof secret !== "string" || secret === "") return undefined
  const decoded = parseBase64(secret, 32)
  if (decoded === undefined || decoded.toString("base64") !== secret) return undefined
  if (decoded.every((byte) => byte === 0)) return undefined
  return secret
}

/** `sha256(secret)` — the protector key; the key id is derived from it. */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest()
}

/** The 16-hex-character id envelopes name for a protector key. */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/** Whether a path exists and is executable; never throws. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The platform's default install location, or `undefined` where unverified. */
export function defaultElectronPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "darwin") return MACOS_ELECTRON_PATH
  if (platform !== "win32") return undefined
  const localAppData = process.env.LOCALAPPDATA?.trim()
  if (localAppData === undefined || localAppData === "") return undefined
  return join(localAppData, ...WINDOWS_DEFAULT_RELATIVE)
}

/**
 * Confirm the known Windows install layout before anything is executed: the
 * binary must be `WorkBuddy.exe` beside a `version` file and `resources/app.asar`.
 */
function isWorkBuddyWindowsInstall(path: string): boolean {
  if (basename(path).toLowerCase() !== "workbuddy.exe") return false
  const root = dirname(path)
  if (!isExecutable(path)) return false
  try {
    if (!statSync(path).isFile()) return false
    if (!statSync(join(root, "resources", "app.asar")).isFile()) return false
    const version = readFileSync(join(root, "version"), "utf8").trim()
    return WINDOWS_VERSION_PATTERN.test(version)
  } catch {
    return false
  }
}

/**
 * Query the registry, returning empty text for a missing key or a failure.
 * `recursive` is explicit: `/s` on the protocol-command key would walk the
 * whole scheme tree for one value.
 */
function queryRegistry(regPath: string, key: string, recursive: boolean): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const args = recursive ? ["query", key, "/s"] : ["query", key]
  execFile(regPath, args, { maxBuffer: 4 * 1024 * 1024, timeout: 5_000, windowsHide: true }, (error, stdout) => {
    resolve(error == null ? stdout : "")
  })
  return promise
}

/**
 * The install path the app records for itself in its own config dir. This is
 * free (one small file read) compared with a registry scan, and it survives
 * installs the uninstall records do not describe.
 */
function configuredInstallHints(): string[] {
  const override = process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim()
  const configDir = override !== undefined && override !== "" ? override : join(homedir(), ".workbuddy")
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []
    const marker = (parsed as Record<string, unknown>).officeFileAssociationsRepairMarker
    if (typeof marker !== "string") return []
    // `v3:win32:5.6.2:D:\Program Files\WorkBuddy\WorkBuddy.exe:WorkBuddy:...`
    const match = /[A-Za-z]:\\[^:]*?WorkBuddy\.exe/iu.exec(marker)
    return match === null ? [] : [match[0]]
  } catch {
    return []
  }
}

/**
 * Pull the values of each registry key out of `reg query /s` output.
 *
 * Values are buffered per key and judged only once the key's block ends:
 * `reg query` emits a key's values in an order this code must not assume, so
 * matching a `DisplayIcon` only after having seen the `DisplayName` beside it
 * would silently drop entries whenever the icon comes first.
 */
function registryEntries(output: string): Array<{ displayName?: string, displayIcon?: string }> {
  const entries: Array<{ displayName?: string, displayIcon?: string }> = []
  let current: { displayName?: string, displayIcon?: string } | undefined
  for (const line of output.split(/\r?\n/u)) {
    if (/^\s*HKEY_/iu.test(line)) {
      current = {}
      entries.push(current)
      continue
    }
    if (current === undefined) continue
    const value = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/iu.exec(line)
    if (value === null) continue
    const name = value[1]!.toLowerCase()
    const data = value[2] ?? ""
    if (name === "displayname") current.displayName = data
    else if (name === "displayicon") current.displayIcon = data
  }
  return entries
}

/** Read a Windows uninstall record's declared `WorkBuddy.exe`. */
function installPathFromUninstallEntry(entry: { displayName?: string, displayIcon?: string }): string | undefined {
  if (entry.displayName === undefined) return undefined
  if (!WINDOWS_WORKBUDDY_DISPLAY_NAME_PATTERN.test(entry.displayName.trim())) return undefined
  const icon = entry.displayIcon
  if (icon === undefined) return undefined
  const quoted = /^"([^"]+\.exe)"/iu.exec(icon.trim())
  const path = quoted !== null ? quoted[1]! : /^(.+?\.exe)(?:,\d+)?$/iu.exec(icon.trim())?.[1]
  return path !== undefined && path.toLowerCase().endsWith(".exe") ? path : undefined
}

/**
 * Find the installed Windows binary. Local hints come first because they are
 * effectively free; the registry is the fallback for installs that leave no
 * record in the app config. Registry queries run concurrently: on this host a
 * single `reg.exe` spawn costs seconds, so a sequential scan would outlast the
 * caller's budget.
 */
async function discoverWindowsElectronPath(): Promise<string | undefined> {
  // Cheap local hints are validated before the registry is touched at all: a
  // `reg.exe` spawn costs seconds on this host, and paying that while a usable
  // path is already recorded would delay every cold credential read.
  for (const hint of configuredInstallHints()) {
    if (isWorkBuddyWindowsInstall(hint)) return hint
  }
  const systemRoot = process.env.SystemRoot?.trim()
  if (systemRoot === undefined || systemRoot === "") return undefined
  const regPath = join(systemRoot, "System32", "reg.exe")
  const [hcUninstall, hkUninstall, hkWowUninstall, protocolKey] = await Promise.all([
    queryRegistry(regPath, WINDOWS_UNINSTALL_ROOTS[0], true),
    queryRegistry(regPath, WINDOWS_UNINSTALL_ROOTS[1], true),
    queryRegistry(regPath, WINDOWS_UNINSTALL_ROOTS[2], true),
    queryRegistry(regPath, WINDOWS_PROTOCOL_COMMAND_KEY, false),
  ])
  const candidates: string[] = []
  for (const output of [hcUninstall, hkUninstall, hkWowUninstall]) {
    if (output === "") continue
    for (const entry of registryEntries(output)) {
      const path = installPathFromUninstallEntry(entry)
      if (path !== undefined) candidates.push(path)
    }
  }
  // The `workbuddy://` handler names the binary in its default value; the
  // value's *name* is localized, so scan every value rather than one label.
  for (const line of protocolKey.split(/\r?\n/u)) {
    const value = /^\s+\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/iu.exec(line)
    if (value === null) continue
    const quoted = /^"([^"]+\.exe)"/iu.exec((value[1] ?? "").trim())
    if (quoted !== null) candidates.push(quoted[1]!)
  }
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    if (isWorkBuddyWindowsInstall(candidate)) return candidate
  }
  return undefined
}

export interface WorkBuddyKeyProviderOptions {
  /** Explicit binary; overrides {@link WORKBUDDY_ELECTRON_BIN_ENV} and discovery. */
  electronPath?: string
  /** Spawn timeout; defaults to 30 s (Electron boot as Node is not instant). */
  timeoutMs?: number
  /** Platform override, for tests. */
  platform?: NodeJS.Platform
  /** Registry discovery override, for tests. */
  discover?: () => Promise<string | undefined>
  /** Spawn override, for tests: returns the helper's stdout. */
  spawn?: (electronPath: string) => Promise<string>
}

/**
 * Resolves and caches the at-rest protector key by spawning the WorkBuddy
 * binary as plain Node. The key is cached in memory keyed by the id envelopes
 * name, so a re-login under a new payload re-resolves instead of failing.
 */
export class WorkBuddyAtRestKeyProvider {
  private cached: { keyId: string; key: Buffer } | undefined
  private resolvedPath: string | undefined

  constructor(private readonly options: WorkBuddyKeyProviderOptions = {}) {}

  /** The key for the given envelope key id, or an error naming the failure. */
  async keyFor(keyId: string): Promise<Buffer> {
    if (this.cached !== undefined && this.cached.keyId === keyId) return this.cached.key
    this.cached = undefined
    const electronPath = await this.resolvePath()
    const payload = parseAtRestPayload(await this.spawn(electronPath))
    if (payload === undefined) {
      throw new WorkBuddyKeyUnavailableError("invalid-payload", "the WorkBuddy key helper returned an unusable payload")
    }
    const key = deriveProtectorKey(payload)
    const derived = keyIdOf(key)
    if (derived !== keyId) {
      throw new WorkBuddyKeyUnavailableError(
        "key-mismatch",
        `the WorkBuddy at-rest key (${derived}) does not open the stored credential (${keyId})`,
      )
    }
    this.cached = { keyId, key }
    return key
  }

  private async resolvePath(): Promise<string> {
    if (this.resolvedPath !== undefined) return this.resolvedPath
    const platform = this.options.platform ?? process.platform
    const explicit = this.options.electronPath ?? process.env[WORKBUDDY_ELECTRON_BIN_ENV]
    if (explicit !== undefined && explicit.trim() !== "") {
      const path = explicit.trim()
      if (!isExecutable(path)) {
        throw new WorkBuddyKeyUnavailableError("no-binary", `${WORKBUDDY_ELECTRON_BIN_ENV} does not point at an executable (${path})`)
      }
      this.resolvedPath = path
      return path
    }
    const fallback = defaultElectronPath(platform)
    if (fallback !== undefined && isExecutable(fallback)) {
      this.resolvedPath = fallback
      return fallback
    }
    if (platform === "win32") {
      const discovered = await (this.options.discover ?? discoverWindowsElectronPath)()
      if (discovered !== undefined) {
        this.resolvedPath = discovered
        return discovered
      }
    }
    throw new WorkBuddyKeyUnavailableError(
      "no-binary",
      `no WorkBuddy application was found to read the at-rest key; set ${WORKBUDDY_ELECTRON_BIN_ENV} to its executable`,
    )
  }

  private spawn(electronPath: string): Promise<string> {
    if (this.options.spawn !== undefined) return this.options.spawn(electronPath)
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    execFile(
      electronPath,
      ["-e", HELPER_SCRIPT],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error != null) {
          // Code and reason only: stdout/stderr can carry paths or crash dumps.
          const reason = error.killed === true ? `timed out after ${timeoutMs}ms` : "could not be started"
          reject(new WorkBuddyKeyUnavailableError("spawn-failed", `the WorkBuddy key helper (${electronPath}) ${reason}`))
          return
        }
        const output = stdout.trim()
        if (output === "") {
          reject(new WorkBuddyKeyUnavailableError("empty-output", `the WorkBuddy key helper (${electronPath}) produced no payload`))
          return
        }
        resolve(output)
      },
    )
    return promise
  }
}
