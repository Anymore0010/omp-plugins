/**
 * MiMo upstream wire client.
 *
 * SSO path (free desktop tier, zero-config): a two-phase Xiaomi passport
 * exchange mints a `serviceToken` cookie, then chat goes through the desktop's
 * private route (`/api/route/chat/completions`) as standard OpenAI JSON.
 *
 *   Phase 1: GET account.xiaomi.com/pass/serviceLogin?sid=mimopc&_json=true
 *            Cookie: passToken + userId (+ cUserId)
 *            -> JSON after "&&&START&&&": { code:0, nonce, ssecurity, location }
 *   Phase 2: GET location + "&clientSign=<enc>" with NO Cookie (the desktop's
 *            SSO_curl.cpp clears cookies here), UA "MiClaw/1.0"
 *            clientSign = urlencode(base64(sha1("nonce=<nonce>&<ssecurity>")))
 *            -> Set-Cookie: serviceToken=...
 *
 * API-key path: standard Bearer auth against the official OpenAI-compatible
 * base (https://api.xiaomimimo.com/v1).
 */
import { createHash } from "node:crypto"
import { SERVICE_TOKEN_TTL_MS, type MimoCredential } from "./auth"

export const CN_API_BASE = "https://mimo-server-cn.xiaomimimo.com/api"
const PASSPORT_LOGIN = "https://account.xiaomi.com/pass/serviceLogin"
const SSO_SID = "mimopc"
const SSO_UA = "MiClaw/1.0"
const CHAT_UA = "MiMo/26.914.142245 Chrome/132.0.0.0 Electron/35"
const X_MIMO_SOURCE = "mimocode-cli-free"
const ERROR_BODY_LIMIT = 4096
/** Officially published default when no base_url accompanies an API key. */
const DEFAULT_KEY_BASE = "https://api.xiaomimimo.com/v1"

export interface MimoUpstreamModel {
  id: string
  name: string
  /** Relative rate multiplier (displayRatio); 0 = not billed / unknown. */
  rate: number
  contextWindow: number
  maxTokens: number
}

/**
 * CN route rejects `mimo-auto` outright (chat_model_not_public, biz_code
 * 41105) and the desktop resolves auto to pro — mirror that.
 */
export function normalizeModelName(model: string): string {
  return model === "mimo-auto" ? "mimo-pro" : model
}

function clientSignOf(nonce: string, ssecurity: string): string {
  const input = ssecurity.trim() === "" ? `nonce=${nonce}` : `nonce=${nonce}&${ssecurity}`
  return encodeURIComponent(createHash("sha1").update(input).digest("base64"))
}

function passportCookieHeader(credential: Extract<MimoCredential, { kind: "sso" }>): string {
  const parts = [`passToken=${credential.passToken}`, `userId=${credential.userId}`]
  if (credential.cUserId !== undefined) parts.push(`cUserId=${credential.cUserId}`)
  return parts.join("; ")
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`mimo upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
}

export class MimoUpstreamClient {
  private serviceToken: string | undefined
  private serviceTokenExpiresAtMs = 0

  /** GET the model catalog; TEXT models become chat models. */
  async fetchModels(credential: MimoCredential): Promise<MimoUpstreamModel[]> {
    if (credential.kind === "apikey") {
      const response = await fetch(`${credential.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${credential.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      })
      const parsed = await readJson(response)
      if (!response.ok || parsed === null || typeof parsed !== "object") {
        throw new Error(`mimo models failed (http ${response.status})`)
      }
      const data = (parsed as Record<string, unknown>).data
      const list = Array.isArray(data) ? data : []
      const models: MimoUpstreamModel[] = []
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue
        const m = entry as Record<string, unknown>
        if (typeof m.id !== "string" || m.id === "") continue
        models.push({
          id: m.id,
          name: typeof m.id === "string" ? m.id : m.id,
          rate: 0,
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        })
      }
      return models
    }

    const token = await this.ensureServiceToken(credential)
    const response = await fetch(`${CN_API_BASE}/model/list`, {
      headers: { Cookie: `serviceToken=${token}; userId=${credential.userId}`, "User-Agent": CHAT_UA },
      signal: AbortSignal.timeout(30_000),
    })
    const parsed = await readJson(response)
    if (!response.ok || parsed === null || typeof parsed !== "object") {
      throw new Error(`mimo model list failed (http ${response.status})`)
    }
    const document = parsed as Record<string, unknown>
    if (document.code !== 0) {
      throw new Error(`mimo model list failed: code ${String(document.code)}`)
    }
    const data = document.data !== null && typeof document.data === "object" ? (document.data as Record<string, unknown>) : {}
    const raw = Array.isArray(data.models) ? data.models : []
    const models: MimoUpstreamModel[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue
      const m = entry as Record<string, unknown>
      if (m.modelType !== "TEXT") continue
      const id = m.modelName
      if (typeof id !== "string" || id === "") continue
      const name = typeof m.description === "string" && m.description !== "" ? m.description : id
      const ratio = m.ratio !== null && typeof m.ratio === "object" ? (m.ratio as Record<string, unknown>) : {}
      const rate = typeof m.displayRatio === "number" ? m.displayRatio : 0
      void ratio
      models.push({ id, name, rate, contextWindow: 1_000_000, maxTokens: 128_000 })
    }
    if (models.length === 0) throw new Error("mimo model list resolved to an empty chat roster")
    return models
  }

  /** POST the chat endpoint; returns the raw (SSE or JSON) Response. */
  async chatStream(credential: MimoCredential, bodyJson: string): Promise<Response> {
    if (credential.kind === "apikey") {
      return fetch(`${credential.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.apiKey}`,
          "X-Mimo-Source": X_MIMO_SOURCE,
        },
        body: bodyJson,
      })
    }
    const token = await this.ensureServiceToken(credential)
    const obj = JSON.parse(bodyJson) as Record<string, unknown>
    if (typeof obj.model === "string") obj.model = normalizeModelName(obj.model)
    return fetch(`${CN_API_BASE}/route/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `serviceToken=${token}; userId=${credential.userId}`,
        "User-Agent": CHAT_UA,
        "X-Mimo-Source": X_MIMO_SOURCE,
      },
      body: JSON.stringify(obj),
    })
  }

  /**
   * Mint (or reuse) a serviceToken. Phase 1 renews passToken alongside, so a
   * rotation observed here keeps the owned cache fresh.
   */
  private async ensureServiceToken(credential: Extract<MimoCredential, { kind: "sso" }>): Promise<string> {
    if (this.serviceToken !== undefined && Date.now() < this.serviceTokenExpiresAtMs) {
      return this.serviceToken
    }
    const loginResponse = await fetch(
      `${PASSPORT_LOGIN}?sid=${SSO_SID}&_json=true`,
      { headers: { Cookie: passportCookieHeader(credential), "User-Agent": SSO_UA }, signal: AbortSignal.timeout(30_000) },
    )
    const loginText = await loginResponse.text()
    const marker = "&&&START&&&"
    const start = loginText.indexOf(marker)
    if (!loginResponse.ok || start === -1) {
      throw new Error(`mimo passport login failed (http ${loginResponse.status}); is the MiMo desktop passToken still valid?`)
    }
    let phase1: Record<string, unknown>
    try {
      phase1 = JSON.parse(loginText.slice(start + marker.length)) as Record<string, unknown>
    } catch {
      throw new Error("mimo passport login returned malformed JSON")
    }
    if (phase1.code !== 0) {
      throw new Error(`mimo passport login rejected: code ${String(phase1.code)} ${String(phase1.description ?? "")}`.trim())
    }
    const ssecurity = phase1.ssecurity
    const location = phase1.location
    // The nonce is an 18-digit int64 that exceeds Number's 2^53 safe range:
    // JSON.parse silently rounds it (…270 -> …272) and the clientSign computed
    // over the wrong digits fails the STS check with 401. Extract the literal
    // digits from the raw JSON text instead.
    const nonceMatch = /"nonce"\s*:\s*(\d+)/u.exec(loginText)
    const nonceText = nonceMatch?.[1] ?? ""
    if (nonceText === "" || typeof location !== "string") {
      throw new Error("mimo passport login missing nonce/location")
    }
    const sign = clientSignOf(nonceText, typeof ssecurity === "string" ? ssecurity : "")
    // Phase 2 must NOT carry cookies — the STS endpoint rejects them (401).
    const stsResponse = await fetch(`${location}&clientSign=${sign}`, {
      headers: { "User-Agent": SSO_UA },
      signal: AbortSignal.timeout(30_000),
    })
    if (!stsResponse.ok) {
      throw new Error(`mimo STS exchange failed (http ${stsResponse.status})`)
    }
    // The serviceToken arrives as a Set-Cookie header; fetch exposes it (undici) via headers.getSetCookie.
    const cookies = stsResponse.headers.getSetCookie()
    let token: string | undefined
    for (const cookie of cookies) {
      const pair = cookie.split(";", 1)[0] ?? ""
      const [name, value] = pair.split("=", 2)
      if (name?.trim() === "serviceToken" && value !== undefined && value !== "") token = value.trim()
    }
    if (token === undefined) {
      throw new Error("mimo STS exchange returned no serviceToken cookie")
    }
    this.serviceToken = token
    this.serviceTokenExpiresAtMs = Date.now() + SERVICE_TOKEN_TTL_MS
    if (typeof phase1.passToken === "string" && phase1.passToken !== "") {
      credential.passToken = phase1.passToken
    }
    return token
  }
}

export { DEFAULT_KEY_BASE }
