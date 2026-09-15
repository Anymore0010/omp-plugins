/**
 * MiMo credential store: resolve the effective credential once per process
 * (desktop cookies preferred, owned auth file / env key as fallback) and cache
 * the minted serviceToken lifetime inside the upstream client.
 */

import { readDesktopSsoCredential, readOwnedCredential, writeOwnedSso, type MimoCredential } from "./auth"
import type { MimoUpstreamClient } from "./upstream"

export class MimoCredentialStore {
  private cached: MimoCredential | undefined
  private resolved = false

  constructor(private readonly client: MimoUpstreamClient) {}

  async current(): Promise<MimoCredential | undefined> {
    if (this.resolved) return this.cached
    this.resolved = true
    const desktop = readDesktopSsoCredential()
    if (desktop !== undefined && desktop.kind === "sso") {
      // Persist an owned copy so restarts survive MiMo running again (locked store).
      writeOwnedSso(desktop)
      this.cached = desktop
      return this.cached
    }
    const owned = readOwnedCredential()
    if (owned === undefined || owned.kind !== "sso") {
      this.cached = owned
      return this.cached
    }
    // Refresh passToken rotations: the next chat mints via passport anyway.
    try {
      await this.client.fetchModels(owned)
    } catch {
      // stale owned SSO is still worth one chat attempt; 401 surfaces there
    }
    this.cached = owned
    return this.cached
  }

  invalidate(): void {
    this.resolved = false
    this.cached = undefined
  }
}
