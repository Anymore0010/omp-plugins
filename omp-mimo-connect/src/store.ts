/**
 * MiMo credential store: resolve the effective credential for the process.
 *
 * Ordering: owned auth file FIRST (single file read), desktop cookie store
 * only when it is missing/unparseable/stale (>7d). Inverting this matters:
 * the desktop path costs a PowerShell DPAPI spawn + a ~20 MB cookie-store
 * copy and fails as a whole under Bun (the sqlite temp-file handle outlives
 * `conn.close()`, so `rmSync` throws EBUSY) — paying that on every omp start
 * for a cache that already exists was the source of 401/502 turns.
 *
 * Memoization: `current()` caches the in-flight PROMISE, and a failed or
 * empty resolution clears it so the next turn retries cleanly — a rejected
 * memoized promise would otherwise pin the process to that error forever.
 */


import { readFileSync } from "node:fs"
import { ownedAuthPath, readDesktopSsoCredential, readOwnedCredential, writeOwnedSso, type MimoCredential } from "./auth"
import type { MimoUpstreamClient } from "./upstream"

/** Age after which the owned cache is considered stale and the cookie store is re-consulted. */
const OWNED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export class MimoCredentialStore {
  private inflight: Promise<MimoCredential | undefined> | undefined

  constructor(private readonly client: MimoUpstreamClient) {}

  async current(): Promise<MimoCredential | undefined> {
    this.inflight ??= this.resolve()
    const credential = await this.inflight
    if (credential === undefined) this.inflight = undefined // allow a later retry
    return credential
  }

  private async resolve(): Promise<MimoCredential | undefined> {
    const owned = readOwnedCredential()
    if (owned !== undefined && owned.kind === "sso") {
      const age = Date.now() - readOwnedSavedAtMs()
      if (age < OWNED_MAX_AGE_MS) {
        // Refresh passToken rotations: the next chat mints via passport anyway.
        try {
          await this.client.fetchModels(owned)
        } catch {
          // stale owned SSO is still worth one chat attempt; 401 surfaces there
        }
        return owned
      }
    }
    const desktop = readDesktopSsoCredential()
    if (desktop !== undefined && desktop.kind === "sso") {
      // Persist an owned copy so restarts survive MiMo running again (locked store).
      writeOwnedSso(desktop)
      return desktop
    }
    return owned
  }

  invalidate(): void {
    this.inflight = undefined
  }
}

function readOwnedSavedAtMs(): number {
  try {
    const parsed = JSON.parse(readFileSync(ownedAuthPath(), "utf-8")) as { savedAtMs?: unknown }
    return typeof parsed.savedAtMs === "number" ? parsed.savedAtMs : 0
  } catch {
    return 0
  }
}

