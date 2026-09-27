/**
 * Credential store with demand-driven refresh for the omp WorkBuddy connect
 * extension. Reuses the desktop app's sign-in; refreshes near expiry through
 * the upstream and persists an owned copy under the omp home.
 *
 * The desktop file has three possible states (usable, signed out, encrypted
 * but unopenable). They are kept distinct all the way to the shim's error
 * response, because "sign in to the desktop app" is the wrong instruction for
 * a file this plugin simply could not decrypt.
 */

import {
  readDesktopCredential,
  readOwnedCredential,
  writeOwnedCredential,
  preferCredential,
  expiresSoon,
  type WorkBuddyCredential,
} from "./auth"
import { WorkBuddyAtRestKeyProvider } from "./desktop-protection"
import type { WorkBuddyUpstreamClient } from "./upstream"

const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Why no credential is usable, when the reason is diagnosable. */
export interface WorkBuddyAuthStatus {
  state: "signed-in" | "signed-out" | "unreadable"
  credential?: WorkBuddyCredential
  /** Present only on `unreadable`; never carries key material. */
  detail?: string
}

export class WorkBuddyCredentialStore {
  private cached: WorkBuddyCredential | undefined
  private readonly keys = new WorkBuddyAtRestKeyProvider()
  private lastDetail: string | undefined

  constructor(private readonly client: WorkBuddyUpstreamClient) {}

  /** The effective credential, refreshing it near expiry if possible. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    return (await this.status()).credential
  }

  /** The credential plus, when there is none, the reason it is missing. */
  async status(): Promise<WorkBuddyAuthStatus> {
    if (this.cached !== undefined && !expiresSoon(this.cached, REFRESH_MARGIN_MS)) {
      return { state: "signed-in", credential: this.cached }
    }
    const owned = readOwnedCredential()
    const desktop = await readDesktopCredential(this.keys)
    this.lastDetail = desktop.state === "unreadable" ? desktop.detail : undefined
    const preferred = preferCredential(owned, desktop.state === "signed-in" ? desktop.credential : undefined)
    if (preferred === undefined) {
      this.cached = undefined
      return { state: desktop.state === "unreadable" ? "unreadable" : "signed-out", ...(this.lastDetail !== undefined ? { detail: this.lastDetail } : {}) }
    }
    if (expiresSoon(preferred, REFRESH_MARGIN_MS) && preferred.refreshToken !== "") {
      await this.refresh(preferred)
    }
    this.cached = preferred
    return { state: "signed-in", credential: preferred }
  }

  /** The last unreadable-file diagnosis, for the shim's signed-out message. */
  lastUnreadableDetail(): string | undefined {
    return this.lastDetail
  }

  private async refresh(credential: WorkBuddyCredential): Promise<void> {
    try {
      const outcome = await this.client.refreshToken(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken ?? credential.refreshToken,
        ...(outcome.expiresInSec !== undefined
          ? { expiresAtMs: Date.now() + outcome.expiresInSec * 1000 }
          : {}),
        ...(outcome.domain !== undefined ? { domain: outcome.domain } : {}),
        source: "owned",
      }
      writeOwnedCredential(refreshed)
      this.cached = refreshed
    } catch {
      // keep the stale credential; the upstream request will surface the error
    }
  }
}
