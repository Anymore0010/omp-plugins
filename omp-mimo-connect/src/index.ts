/**
 * omp-mimo-connect — bring Xiaomi MiMo desktop models into omp with zero
 * configuration, reusing the MiMo desktop app's own Xiaomi-account sign-in.
 *
 * The extension starts a loopback OpenAI-compatible shim and registers it as
 * the `mimo` provider with no apiKey/oauth. An extension provider with only
 * baseUrl+api+models is treated as keyless, so it is selectable without any
 * omp-side login or key — the MiMo credential lives inside the shim (desktop
 * SSO cookies, or an API key via MIMO_API_KEY / ~/.omp/.mimo-auth.json).
 * Select models in /model as `mimo/<id>` (e.g. mimo/mimo-pro).
 *
 * The upstream wire is standard OpenAI chat-completions; the shim's job is
 * credential reuse (Xiaomi passport two-phase serviceToken exchange), the
 * `X-Mimo-Source` header, and `mimo-auto` -> `mimo-pro` normalization (the CN
 * route rejects mimo-auto outright; the desktop resolves it to pro).
 *
 * For personal research/learning only: drives your own MiMo account on this
 * machine. Not affiliated with Xiaomi.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent"
import { MimoUpstreamClient } from "./upstream"
import { MimoCredentialStore } from "./store"
import { MimoShim } from "./server"
import { FALLBACK_MIMO_MODELS } from "./catalog"
import type { MimoUpstreamModel } from "./upstream"

export const MIMO_PROVIDER = "mimo"

/**
 * Map a raw upstream model to the omp provider model config shape. The rate
 * multiplier rides `cost.input` so the picker shows a relative-rate indicator
 * (SSO free tier answers rate 0 and renders as `free`); MiMo bills in its own
 * currency, not dollars, so these are display indicators only.
 */
function toProviderModel(model: MimoUpstreamModel): ProviderModelConfig {
  return {
    id: model.id,
    name: model.rate > 0 && model.rate !== 1 ? `${model.name} · x${model.rate}` : model.name,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: model.rate, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }
}

export default async function mimoConnect(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("MiMo Connect")

  const client = new MimoUpstreamClient()
  const store = new MimoCredentialStore(client)
  const shim = new MimoShim({
    store,
    client,
    fallbackModels: FALLBACK_MIMO_MODELS,
  })

  try {
    const port = await shim.listen()
    const baseUrl = `http://127.0.0.1:${port}/v1`
    pi.registerProvider(MIMO_PROVIDER, {
      baseUrl,
      api: "openai-completions",
      // The loopback shim owns the MiMo credential and ignores any inbound
      // Authorization header, so this literal apiKey is never validated — it
      // only satisfies omp's runtime requirement that a provider defining
      // `models` carries apiKey or oauth (extension registration has no
      // `auth: none` escape hatch).
      apiKey: "mimo-desktop",
      models: FALLBACK_MIMO_MODELS.map(toProviderModel),
      // Runtime model discovery; omp bounds this to 15 s.
      fetchDynamicModels: async () => (await shim.dynamicModels()).map(toProviderModel),
    })
    pi.registerCommand("mimo-refresh", {
      description: "强制重新拉取 MiMo 上游最新模型列表（绕过 omp 24h 动态发现缓存）",
      handler: async (_args, ctx) => {
        store.invalidate()
        const credential = await store.current()
        if (credential === undefined) {
          ctx.ui.notify("MiMo 未登录：先登录 MiMo 桌面版（并保持关闭状态以解除 Cookies 文件锁），或设置 MIMO_API_KEY", "error")
          return
        }
        const beforeIds = new Set(shim.currentModels().map(model => model.id))
        // Probe upstream directly so an offline failure is distinguishable from
        // "no change" (refreshProvider's internal fetch swallows errors, and
        // omp gates non-authoritative retries behind a 5-minute backoff).
        let fresh: readonly MimoUpstreamModel[]
        try {
          fresh = await client.fetchModels(credential)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`MiMo 上游不可达：${message}（已保留现有 ${beforeIds.size} 个模型）`, "warning")
          return
        }
        if (fresh.length === 0) {
          ctx.ui.notify("MiMo 上游返回空列表，已保留现有模型", "warning")
          return
        }
        try {
          // Strategy defaults to "online": unconditionally forces a live fetch.
          await ctx.modelRegistry.refreshProvider(MIMO_PROVIDER)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`强刷失败：${message}（已保留现有模型）`, "error")
          return
        }
        const afterIds = new Set(shim.currentModels().map(model => model.id))
        const added = [...afterIds].filter(id => !beforeIds.has(id)).length
        ctx.ui.notify(
          added > 0
            ? `已强制刷新：共 ${afterIds.size} 个模型，本次新增 ${added} 个`
            : `已强制刷新：共 ${afterIds.size} 个模型，无新增`,
          "info",
        )
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    pi.logger.error("mimo-connect: shim failed to start", { error: message })
  }

  pi.on("session_shutdown", () => {
    shim.close()
  })
}
