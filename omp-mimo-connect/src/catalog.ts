/**
 * Static fallback catalog (CN SSO tier, observed 2026-09). Replaced by the
 * live `/model/list` answer once SSO credentials land. `mimo-auto` is kept as
 * a selectable alias even though the CN route rejects it — the shim rewrites
 * it to `mimo-pro` on the wire, matching the desktop client.
 */

import type { MimoUpstreamModel } from "./upstream"

function model(id: string, name: string, rate: number): MimoUpstreamModel {
  return { id, name, rate, contextWindow: 1_000_000, maxTokens: 128_000 }
}

export const FALLBACK_MIMO_MODELS: readonly MimoUpstreamModel[] = [
  model("mimo-auto", "MiMo Auto", 1.0),
  model("mimo-pro", "MiMo Pro", 1.0),
  model("mimo-flash", "MiMo Flash", 0.4),
  model("mimo-x-pro-preview", "MiMo-X-Pro-Preview", 1.0),
  model("mimo-x-flash-preview", "MiMo-X-Flash-Preview", 0.4),
]
