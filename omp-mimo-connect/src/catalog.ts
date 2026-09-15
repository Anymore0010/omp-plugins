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

/**
 * Merge the live TEXT roster with the wire-valid aliases. The upstream
 * `/model/list` answer omits `mimo-auto` (rejected by the CN route) and the
 * `mimo-pro`/`mimo-flash` aliases (which the server routes to the
 * `mimo-x-*-preview` ids), yet those aliases are exactly what works on the
 * wire — dropping them breaks omp sessions pinned to `mimo/mimo-pro`.
 * Dedupe by id; live metadata wins on conflict.
 */
export function mergeWithAliases(live: readonly MimoUpstreamModel[]): MimoUpstreamModel[] {
  const byId = new Map(live.map((m) => [m.id, m]))
  for (const alias of FALLBACK_MIMO_MODELS) {
    if (!byId.has(alias.id)) byId.set(alias.id, alias)
  }
  return [...byId.values()]
}
