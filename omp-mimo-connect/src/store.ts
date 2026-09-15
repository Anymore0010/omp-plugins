/**
 * MiMo credential store: resolve the effective credential once per process
 * (desktop cookies preferred, owned auth file / env key as fallback).
 *
 * The resolution is memoized as a PROMISE, not a value: `listen()` kicks off a
 * background `current()` while omp's first `fetchDynamicModels`/chat call can
 * arrive before it settles — caching the value at call time latched
 * `undefined` for the whole process (observed as a hard 401 on every chat
 * with a valid `~/.omp/.mimo-auth.json` on disk).
 */

import { readDesktopSsoCredential, readOwnedCredential, writeOwnedSso, type MimoCredential } from "./auth"
import type { MimoUpstreamClient } from "./upstream"

export class MimoCredentialStore {
  private inflight: Promise<MimoCredential | undefined> | undefined

  constructor(private readonly client: MimoUpstreamClient) {}

  async current(): Promise<MimoCredential | undefined> {
    this.inflight ??= this.resolve()
    return this.inflight
  }

  private async resolve(): Promise<MimoCredential | undefined> {
    const desktop = readDesktopSsoCredential()
    if (desktop !== undefined && desktop.kind === "sso") {
      // Persist an owned copy so restarts survive MiMo running again (locked store).
      writeOwnedSso(desktop)
      return desktop
    }
    const owned = readOwnedCredential()
    if (owned === undefined || owned.kind !== "sso") {
      return owned
    }
    // Refresh passToken rotations: the next chat mints via passport anyway.
    try {
      await this.client.fetchModels(owned)
    } catch {
      // stale owned SSO is still worth one chat attempt; 401 surfaces there
    }
    return owned
  }

  invalidate(): void {
    this.inflight = undefined
  }
}
