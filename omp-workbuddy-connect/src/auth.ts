/**
 * WorkBuddy credential resolution for the omp connect extension.
 *
 * Reuses the WorkBuddy desktop app's own auth file (read-only) and keeps a
 * plugin-owned refreshed copy under the omp home so token refreshes survive
 * restarts without ever writing to the desktop app's file.
 *
 * Since WorkBuddy 5.6 the desktop file stores `auth.accessToken` /
 * `auth.refreshToken` (and `account.nickname`) as at-rest encrypted wrappers
 * rather than plain strings, so reading the file means classifying it and
 * opening the wrappers with the app's own protector key. A file the app has
 * encrypted but this plugin cannot open is reported as *unreadable*, never as
 * "not signed in" — the two need different fixes from the user.
 */

import { homedir, release } from "node:os"
import { join } from "node:path"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import {
  WorkBuddyAtRestKeyProvider,
  WorkBuddyKeyUnavailableError,
  classifyDesktopAuthDocument,
  openAuthField,
  openWrappedText,
  type WrappedAuthField,
} from "./desktop-protection"

export const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE"
export const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json"

const DESKTOP_RELATIVE = ["CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"] as const

export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  source: "desktop" | "owned"
}

const OWN_FORMAT_VERSION = 1

function isWsl(): boolean {
  if (process.platform !== "linux") return false
  if (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined) return true
  return release().toLowerCase().includes("microsoft")
}

function windowsPathForWsl(value?: string): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith("/")) return path
  const drive = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drive === null) return undefined
  return join("/mnt", drive[1]!.toLowerCase(), ...drive[2]!.split(/[\\/]+/u))
}

function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env.USERPROFILE) ?? join("/mnt/c/Users", home.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
  const local = windowsPathForWsl(process.env.LOCALAPPDATA) ?? join(profile, "AppData", "Local")
  const roaming = windowsPathForWsl(process.env.APPDATA) ?? join(profile, "AppData", "Roaming")
  return [
    join(local, ...DESKTOP_RELATIVE),
    join(roaming, ...DESKTOP_RELATIVE),
  ]
}

/** Platform-default candidates for the WorkBuddy desktop auth file, in probe order. */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", ...DESKTOP_RELATIVE)]
  }
  if (process.platform === "win32") {
    return [
      join(home, "AppData", "Local", ...DESKTOP_RELATIVE),
      join(home, "AppData", "Roaming", ...DESKTOP_RELATIVE),
    ]
  }
  if (process.platform === "linux") {
    const linux = join(home, ".config", ...DESKTOP_RELATIVE)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

/**
 * The result of reading the desktop file: a usable credential, an honestly
 * signed-out file, or a file whose credential exists but could not be opened.
 */
export type DesktopAuthRead =
  | { state: "signed-in"; credential: WorkBuddyCredential }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }

/** Desktop auth document paths, in probe order, ignoring the env override. */
export function resolveOmpHome(): string {
  return process.env.OMP_HOME ?? join(homedir(), ".omp")
}

export function ownedAuthPath(): string {
  return join(resolveOmpHome(), WORKBUDDY_AUTH_FILENAME)
}

function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Parse the desktop doc in either shape: nested `{auth,account}` or flat. */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const nested = typeof document.auth === "object" && document.auth !== null
  const auth = nested ? (document.auth as Record<string, unknown>) : document
  const identity = nested && typeof document.account === "object" && document.account !== null
    ? (document.account as Record<string, unknown>)
    : document

  const accessToken = auth.accessToken
  if (typeof accessToken !== "string" || accessToken === "") return undefined

  const expiresAt = auth.expiresAt
  const refreshExpiresAt = auth.refreshExpiresAt
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: typeof expiresAt === "number" ? expiryToMs(expiresAt) : 0,
    ...(typeof refreshExpiresAt === "number" && refreshExpiresAt > 0
      ? { refreshExpiresAtMs: expiryToMs(refreshExpiresAt) }
      : {}),
    domain: optionalString(auth.domain) ?? "",
    uid: optionalString(identity.uid) ?? "",
    enterpriseId: optionalString(identity.enterpriseId),
    nickname: optionalString(identity.nickname),
    source: "desktop",
  }
}

function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document.version !== OWN_FORMAT_VERSION) return undefined
  const stored = document.credential
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined
  const c = stored as Record<string, unknown>
  const accessToken = c.accessToken
  if (typeof accessToken !== "string" || accessToken === "") return undefined
  return {
    accessToken,
    refreshToken: typeof c.refreshToken === "string" ? c.refreshToken : "",
    expiresAtMs: typeof c.expiresAtMs === "number" ? c.expiresAtMs : 0,
    ...(typeof c.refreshExpiresAtMs === "number" && c.refreshExpiresAtMs > 0 ? { refreshExpiresAtMs: c.refreshExpiresAtMs } : {}),
    domain: optionalString(c.domain) ?? "",
    uid: optionalString(c.uid) ?? "",
    enterpriseId: optionalString(c.enterpriseId),
    nickname: optionalString(c.nickname),
    source: "owned",
  }
}

/** Open every encrypted auth field in place, returning plaintext document text. */
async function unwrapDesktopDocument(
  document: Record<string, unknown>,
  fields: readonly WrappedAuthField[],
  provider: WorkBuddyAtRestKeyProvider,
): Promise<string> {
  const rebuilt = structuredClone(document)
  const auth = typeof rebuilt.auth === "object" && rebuilt.auth !== null && !Array.isArray(rebuilt.auth)
    ? (rebuilt.auth as Record<string, unknown>)
    : rebuilt
  for (const field of fields) {
    const key = await provider.keyFor(field.envelope.keyId)
    const plaintext = openAuthField(key, field.envelope)
    if (plaintext === undefined) {
      throw new WorkBuddyKeyUnavailableError(
        "key-mismatch",
        `the WorkBuddy at-rest key does not open auth.${field.field} (${field.envelope.keyId})`,
      )
    }
    auth[field.field] = plaintext
  }
  // Identity fields ride the same protector key; a failure here only costs the
  // display name, so it must not sink an otherwise readable credential.
  const account = typeof rebuilt.account === "object" && rebuilt.account !== null && !Array.isArray(rebuilt.account)
    ? (rebuilt.account as Record<string, unknown>)
    : undefined
  const encryptedNickname = account?.nickname
  if (account !== undefined && encryptedNickname !== undefined && typeof encryptedNickname !== "string" && fields.length > 0) {
    try {
      const key = await provider.keyFor(fields[0]!.envelope.keyId)
      const nickname = openWrappedText(key, encryptedNickname)
      if (nickname !== undefined) account.nickname = nickname
    } catch {
      // display-only
    }
  }
  return JSON.stringify(rebuilt)
}

/**
 * Read the desktop app's credential. Distinguishes "nobody is signed in" from
 * "signed in, but the file is encrypted in a way this plugin cannot open", so
 * the caller can say which fix is needed.
 */
export async function readDesktopCredential(provider: WorkBuddyAtRestKeyProvider): Promise<DesktopAuthRead> {
  const override = process.env[WORKBUDDY_AUTH_FILE_ENV]
  const candidates = override ? [override] : defaultDesktopAuthCandidates()
  let unreadable: string | undefined
  for (const path of candidates) {
    let text: string
    try {
      text = readFileSync(path, "utf-8")
    } catch {
      continue
    }
    const classification = classifyDesktopAuthDocument(text)
    try {
      switch (classification.format) {
        case "plaintext": {
          const credential = parseWorkBuddyAuth(text)
          if (credential !== undefined) return { state: "signed-in", credential }
          continue
        }
        case "encrypted": {
          const credential = parseWorkBuddyAuth(await unwrapDesktopDocument(classification.document, classification.fields, provider))
          if (credential !== undefined) return { state: "signed-in", credential }
          continue
        }
        case "unrecognized":
          unreadable = `${path} is not a readable WorkBuddy credential file`
          continue
        case "absent":
          continue
      }
    } catch (error: unknown) {
      unreadable = error instanceof Error ? error.message : String(error)
    }
  }
  if (unreadable !== undefined) return { state: "unreadable", detail: unreadable }
  return { state: "signed-out" }
}

export function readOwnedCredential(): WorkBuddyCredential | undefined {
  try {
    return parseOwnDocument(readFileSync(ownedAuthPath(), "utf-8"))
  } catch {
    return undefined
  }
}

export function writeOwnedCredential(credential: WorkBuddyCredential): void {
  const document = {
    version: OWN_FORMAT_VERSION,
    credential: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs,
      refreshExpiresAtMs: credential.refreshExpiresAtMs,
      domain: credential.domain,
      uid: credential.uid,
      enterpriseId: credential.enterpriseId,
      nickname: credential.nickname,
    },
  }
  try {
    mkdirSync(resolveOmpHome(), { recursive: true })
    writeFileSync(ownedAuthPath(), JSON.stringify(document), "utf-8")
  } catch {
    // non-fatal: refresh still applies for this process lifetime
  }
}

/** Prefer whichever credential expires later; a refresh by either side wins. */
export function preferCredential(owned?: WorkBuddyCredential, desktop?: WorkBuddyCredential): WorkBuddyCredential | undefined {
  if (owned === undefined) return desktop
  if (desktop === undefined) return owned
  return (owned.expiresAtMs ?? 0) >= (desktop.expiresAtMs ?? 0) ? owned : desktop
}

export function expiresSoon(credential: WorkBuddyCredential, marginMs: number): boolean {
  if (credential.expiresAtMs <= 0) return false
  return credential.expiresAtMs <= Date.now() + marginMs
}