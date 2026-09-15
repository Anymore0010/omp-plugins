/**
 * MiMo credential resolution for the omp-mimo-connect extension.
 *
 * Two credential paths:
 * - SSO (preferred, zero config): reuse the MiMo desktop app's Xiaomi account.
 *   The desktop keeps `passToken`/`userId` in its Chromium cookie store
 *   (`Partitions/xiaomi-account/Network/Cookies`), encrypted per-value
 *   (`v10`/`v11` = AES-256-GCM under a DPAPI-unwrapped key from `Local State`).
 *   The store is file-locked while MiMo runs, so a read requires the desktop
 *   to be closed (or a copy taken earlier). serviceToken is NOT persisted —
 *   it is minted on demand via the passport two-phase exchange (upstream.ts).
 * - API key (fallback): `XIAOMI_API_KEY`/`MIMO_API_KEY` env, or an owned
 *   `~/.omp/.mimo-auth.json` in the official `auth.json` shape.
 *
 * For personal research/learning only: drives your own MiMo account on this
 * machine. Not affiliated with Xiaomi.
 */

import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"

export const MIMO_AUTH_FILE_ENV = "MIMO_AUTH_FILE"
export const MIMO_AUTH_FILENAME = ".mimo-auth.json"

/** Life of the minted serviceToken we are willing to trust before re-minting. */
export const SERVICE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000

export type MimoCredential =
  | { kind: "sso"; passToken: string; userId: string; cUserId?: string; source: "cookies" | "owned" }
  | { kind: "apikey"; apiKey: string; baseUrl: string }

const DESKTOP_NAME = "Xiaomi MiMo"
const LOCAL_STATE = "Local State"
const COOKIES_RELATIVE = ["Partitions", "xiaomi-account", "Network", "Cookies"] as const

export function resolveOmpHome(): string {
  return process.env.OMP_HOME ?? join(homedir(), ".omp")
}

export function ownedAuthPath(): string {
  return join(resolveOmpHome(), MIMO_AUTH_FILENAME)
}

/** Platform-default userData dirs for the MiMo desktop, in probe order. */
export function desktopUserDataCandidates(): string[] {
  const home = homedir()
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", DESKTOP_NAME)]
  }
  if (process.platform === "win32") {
    return [join(home, "AppData", "Roaming", DESKTOP_NAME)]
  }
  return [join(home, ".config", DESKTOP_NAME)]
}

function cookiesPathOf(userData: string): string {
  return join(userData, ...COOKIES_RELATIVE)
}

// -- Chromium cookie decryption (Windows DPAPI + AES-256-GCM) ---------------

type Decryptor = (encrypted: Buffer) => string | undefined


let cachedDecryptor: Decryptor | undefined
function dpapiUnprotectBase64(base64: string): Buffer {
  const script =
    "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
    "Add-Type -AssemblyName System.Security;" +
    "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,'CurrentUser');" +
    "[Console]::Out.Write([Convert]::ToBase64String($out))"
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf-8", timeout: 30_000, windowsHide: true, input: base64 },
  )
  return Buffer.from(stdout.trim(), "base64")
}

function windowsDecryptor(): Decryptor {
  if (cachedDecryptor !== undefined) return cachedDecryptor
  const keyBlob = readLocalStateEncryptedKey()
  if (keyBlob === undefined) throw new Error("Local State has no os_crypt.encrypted_key")
  if (keyBlob.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error("os_crypt.encrypted_key lacks DPAPI prefix")
  }
  const aesKey = dpapiUnprotectBase64(keyBlob.subarray(5).toString("base64"))
  if (aesKey.length !== 32) throw new Error(`unexpected AES key length ${aesKey.length}`)
  cachedDecryptor = (encrypted: Buffer): string | undefined => {
    if (encrypted.length < 31) return undefined
    const prefix = encrypted.subarray(0, 3).toString("latin1")
    if (prefix !== "v10" && prefix !== "v11") return undefined
    const nonce = encrypted.subarray(3, 15)
    const tag = encrypted.subarray(encrypted.length - 16)
    const ciphertext = encrypted.subarray(15, encrypted.length - 16)
    try {
      const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const text = plain.toString("utf-8")
      return text === "" ? undefined : text
    } catch {
      return undefined
    }
  }
  return cachedDecryptor
}

function readLocalStateEncryptedKey(): Buffer | undefined {
  const candidates = desktopUserDataCandidates().map((dir) => join(dir, LOCAL_STATE))
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { os_crypt?: { encrypted_key?: string } }
      const b64 = parsed.os_crypt?.encrypted_key
      if (typeof b64 === "string" && b64 !== "") return Buffer.from(b64, "base64")
    } catch {
      // missing/unreadable — try next candidate
    }
  }
  return undefined
}

// -- owned auth file ---------------------------------------------------------

export function parseOwnedAuth(text: string): MimoCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const xiaomi = document.xiaomi !== null && typeof document.xiaomi === "object" && !Array.isArray(document.xiaomi)
    ? (document.xiaomi as Record<string, unknown>)
    : document
  // Official mimocode auth.json shape: { xiaomi: { type: "api", key, metadata: { base_url } } }
  if (typeof xiaomi.key === "string" && xiaomi.key !== "" && xiaomi.type === "api") {
    const meta = xiaomi.metadata !== null && typeof xiaomi.metadata === "object"
      ? (xiaomi.metadata as Record<string, unknown>)
      : {}
    const baseUrl = typeof meta.base_url === "string" && meta.base_url !== ""
      ? meta.base_url
      : "https://api.xiaomimimo.com/v1"
    return { kind: "apikey", apiKey: xiaomi.key, baseUrl }
  }
  // Owned SSO cache shape: { kind: "sso", passToken, userId, cUserId?, savedAtMs }
  if (typeof xiaomi.passToken === "string" && xiaomi.passToken !== "" && typeof xiaomi.userId === "string") {
    return {
      kind: "sso",
      passToken: xiaomi.passToken,
      userId: xiaomi.userId,
      ...(typeof xiaomi.cUserId === "string" && xiaomi.cUserId !== "" ? { cUserId: xiaomi.cUserId } : {}),
      source: "owned",
    }
  }
  return undefined
}

export function readOwnedCredential(): MimoCredential | undefined {
  const override = process.env[MIMO_AUTH_FILE_ENV]
  if (override !== undefined && override !== "") {
    try {
      return parseOwnedAuth(readFileSync(override, "utf-8"))
    } catch {
      return undefined
    }
  }
  for (const env of ["XIAOMI_API_KEY", "MIMO_API_KEY"]) {
    const key = process.env[env]
    if (key !== undefined && key !== "") {
      return { kind: "apikey", apiKey: key, baseUrl: "https://api.xiaomimimo.com/v1" }
    }
  }
  try {
    return parseOwnedAuth(readFileSync(ownedAuthPath(), "utf-8"))
  } catch {
    return undefined
  }
}

/**
 * Read the Xiaomi SSO cookies out of the desktop's Chromium cookie store.
 * Returns undefined when MiMo is absent, the store is locked, or decryption
 * fails. The store is read through a temp-file copy so an in-flight Chromium
 * checkpoint cannot corrupt our snapshot.
 */
export function readDesktopSsoCredential(): MimoCredential | undefined {
  if (process.platform !== "win32") return undefined // darwin/linux decryption: Keychain/kwallet — not implemented
  let decryptor: Decryptor
  try {
    decryptor = windowsDecryptor()
  } catch (error) {
    console.error("[mimo-connect] decryptor init failed:", error instanceof Error ? error.message : error)
    return undefined
  }
  const localStateDir = desktopUserDataCandidates()[0]
  if (localStateDir === undefined) return undefined
  let db: Buffer
  try {
    db = readFileSync(cookiesPathOf(localStateDir))
  } catch (error) {
    console.error("[mimo-connect] cookies read failed:", error instanceof Error ? error.message : error)
    return undefined
  }
  const found = readCookiesFromSnapshot(db, decryptor)
  if (found === undefined) return undefined
  return { kind: "sso", ...found, source: "cookies" }
}

/**
 * Best-effort temp-dir removal. On Windows the sqlite handle can outlive
 * `conn.close()` (GC lag), making rmSync throw EBUSY — that must never
 * propagate: the credential is already in hand and a stale temp dir is
 * harmless (OS temp cleanup reaps it).
 */
function rmTempDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // stale temp dir is harmless; skip
  }
}

function readCookiesFromSnapshot(db: Buffer, decryptor: Decryptor): { passToken: string; userId: string; cUserId?: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "mimo-cookies-"))
  let rows: { name: string; value: string; encrypted_value: Buffer }[]
  try {
    const copy = join(dir, "Cookies")
    writeFileSync(copy, db)
    const conn = new DatabaseSync(copy, { readOnly: true })
    try {
      rows = conn
        .prepare("select name, value, encrypted_value from cookies where host_key like '%xiaomi.com'")
        .all() as unknown as { name: string; value: string; encrypted_value: Buffer }[]
    } finally {
      conn.close()
    }
  } catch {
    rmTempDirQuietly(dir)
    return undefined
  }
  rmTempDirQuietly(dir)
  const out: Record<string, string> = {}
  for (const row of rows) {
    if (out[row.name] !== undefined) continue
    // Prefer plaintext `value` (older Chromium), else decrypt `encrypted_value`.
    const text = row.value !== "" ? row.value : decryptor(row.encrypted_value)
    if (text !== undefined && text !== "") out[row.name] = text
  }
  const passToken = out.passToken
  const userId = out.userId
  if (passToken === undefined || userId === undefined) return undefined
  return {
    passToken,
    userId,
    ...(out.cUserId !== undefined ? { cUserId: out.cUserId } : {}),
  }
}

/** Owned SSO cache write (so restarts don't need the desktop cookie store again). */
export function writeOwnedSso(credential: Extract<MimoCredential, { kind: "sso" }>): void {
  try {
    mkdirSync(resolveOmpHome(), { recursive: true })
    writeFileSync(
      ownedAuthPath(),
      JSON.stringify({
        kind: "sso",
        passToken: credential.passToken,
        userId: credential.userId,
        ...(credential.cUserId !== undefined ? { cUserId: credential.cUserId } : {}),
        savedAtMs: Date.now(),
      }),
      "utf-8",
    )
  } catch {
    // non-fatal: cookie re-read still works while MiMo stays closed
  }
}
