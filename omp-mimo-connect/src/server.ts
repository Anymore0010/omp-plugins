/**
 * Loopback OpenAI-compatible shim for MiMo. The upstream wire is already
 * standard OpenAI chat-completions, so this shim is thin: loopback guard,
 * credential resolution, model-name normalization (mimo-auto -> mimo-pro) and
 * SSE passthrough with frame cleanup. omp's `openai-completions` transport
 * talks plain OpenAI JSON here; the MiMo credential lives inside the shim.
 *
 * The server binds only to 127.0.0.1 on an ephemeral port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { MimoCredentialStore } from "./store"
import type { MimoUpstreamClient, MimoUpstreamModel } from "./upstream"
import { mergeWithAliases } from "./catalog"
import { normalizeModelName } from "./upstream"

export interface MimoShimOptions {
  store: MimoCredentialStore
  client: MimoUpstreamClient
  fallbackModels: readonly MimoUpstreamModel[]
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const MAX_BODY = 8 * 1024 * 1024

export class MimoShim {
  private server: Server | undefined
  private port = 0
  private catalog: readonly MimoUpstreamModel[]

  constructor(private readonly options: MimoShimOptions) {
    this.catalog = options.fallbackModels
  }

  listen(): Promise<number> {
    if (this.server !== undefined) return Promise.resolve(this.port)
    const { promise, resolve } = Promise.withResolvers<number>()
    this.server = createServer((req, res) => {
      // A rejection escaping the listener is an unhandled rejection, which omp's
      // postmortem handler treats as fatal and tears down the whole session.
      // `res` itself can also emit 'error' (EPIPE / ERR_STREAM_DESTROYED) when
      // the client aborts mid-stream — that is an event, not a rejection, so it
      // needs its own guard.
      res.on("error", () => {})
      this.handle(req, res).catch((error: unknown) => {
        this.failRequest(res, error)
      })
    })
    this.server.on("clientError", (_error: Error, socket) => {
      socket.destroy()
    })
    this.server.listen(0, "127.0.0.1", () => {
      const address = this.server?.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      this.port = port
      resolve(port)
      void this.options.store.current()
        .then((credential) => {
          if (credential === undefined) return undefined
          return this.options.client.fetchModels(credential)
        })
        .then((models) => {
          if (models !== undefined && models.length > 0) this.catalog = mergeWithAliases(models)
        })
        .catch(() => {
          // keep fallback catalog; upstream is offline or not signed in
        })
    })
    return promise
  }

  // Called by the provider's fetchDynamicModels hook.
  async dynamicModels(): Promise<readonly MimoUpstreamModel[]> {
    const credential = await this.options.store.current()
    if (credential === undefined) return this.catalog
    try {
      const models = await this.options.client.fetchModels(credential)
      if (models.length > 0) {
        this.catalog = mergeWithAliases(models)
        return this.catalog
      }
    } catch {
      // keep current catalog
    }
    return this.catalog
  }

  currentModels(): readonly MimoUpstreamModel[] {
    return this.catalog
  }

  close(): void {
    this.server?.close()
  }

  // -- request handling -------------------------------------------------

  private isLoopback(host: string | undefined): boolean {
    if (host === undefined || host === "") return false
    const hostname = this.hostnameOf(host)
    return LOOPBACK_HOSTS.has(hostname)
  }

  private hostnameOf(host: string): string {
    const trimmed = host.trim().toLowerCase()
    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]")
      return end === -1 ? trimmed : trimmed.slice(0, end + 1)
    }
    const colon = trimmed.lastIndexOf(":")
    if (colon !== -1 && !trimmed.slice(0, colon).includes(":") && /^\d+$/.test(trimmed.slice(colon + 1))) {
      return trimmed.slice(0, colon)
    }
    return trimmed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isLoopback(req.headers.host)) {
      this.sendJson(res, 403, { error: { message: "loopback only", type: "forbidden" } })
      return
    }
    const raw = req.url ?? "/"
    const queryStart = raw.indexOf("?")
    const path = queryStart === -1 ? raw : raw.slice(0, queryStart)

    if (req.method === "GET" && path === "/v1/models") {
      this.sendJson(res, 200, {
        object: "list",
        data: this.catalog.map((m) => ({
          id: m.id,
          object: "model",
          created: 0,
          owned_by: "mimo",
          ...(m.name !== m.id ? { name: m.name } : {}),
        })),
      })
      return
    }
    if (req.method === "GET" && path === "/v1/status") {
      const credential = await this.options.store.current()
      this.sendJson(res, 200, {
        provider: "mimo",
        auth: credential === undefined
          ? { state: "signed-out" }
          : credential.kind === "sso"
            ? { state: "signed-in", kind: "sso", userId: credential.userId, source: credential.source }
            : { state: "signed-in", kind: "apikey", baseUrl: credential.baseUrl },
        models: this.catalog.map((m) => m.id),
        loopback: true,
        port: this.port,
      })
      return
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      await this.handleChat(req, res)
      return
    }
    this.sendJson(res, 404, { error: { message: "not found", type: "not_found" } })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return
    const payload = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
    res.end(payload)
  }

  /**
   * Translate a thrown error into an OpenAI-shaped error response. The upstream
   * can close the socket without a response (quota, network), so a
   * mid-request failure must surface as a 502 to omp — not as a rejection.
   */
  private failRequest(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("401") || message.includes("passToken") ? 401 : 502
    this.sendJson(res, status, {
      error: { message: `mimo upstream: ${message}`, type: "upstream_error" },
    })
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error("request body too large"))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString("utf-8")
      try {
        resolve(raw === "" ? {} : JSON.parse(raw))
      } catch {
        reject(new Error("invalid JSON body"))
      }
    }
    const onError = (error: Error): void => {
      reject(error)
    }
    req.on("data", onData)
    req.on("end", onEnd)
    req.on("error", onError)
    return promise
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credential = await this.options.store.current()
    if (credential === undefined) {
      this.sendJson(res, 401, {
        error: {
          message: "not signed in to MiMo desktop and no MIMO_API_KEY / ~/.omp/.mimo-auth.json found",
          type: "authentication_error",
        },
      })
      return
    }
    let body: unknown
    try {
      body = await this.readBody(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request"
      this.sendJson(res, 400, { error: { message, type: "invalid_request" } })
      return
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      this.sendJson(res, 400, { error: { message: "request body must be a JSON object", type: "invalid_request" } })
      return
    }
    const obj = body as Record<string, unknown>
    const stream = obj.stream === true
    if (typeof obj.model === "string") obj.model = normalizeModelName(obj.model)

    const upstream = await this.options.client.chatStream(credential, JSON.stringify(obj))
    if (!upstream.ok) {
      const text = await upstream.text()
      this.sendJson(res, upstream.status, {
        error: {
          message: `mimo upstream (http ${upstream.status}): ${text.slice(0, 200)}`,
          type: "upstream_error",
        },
      })
      return
    }
    if (stream) {
      await this.streamThrough(upstream, res)
    } else {
      await this.aggregate(upstream, res)
    }
  }

  private async streamThrough(response: Response, res: ServerResponse): Promise<void> {
    if (response.body === null) {
      this.sendJson(res, 502, { error: { message: "empty upstream response", type: "upstream_error" } })
      return
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const writeFrame = (payload: string): boolean => res.write(`data: ${payload}\n\n`)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const payload = trimmed.slice(5).trim()
          if (payload === "[DONE]") {
            writeFrame("[DONE]")
            if (!res.writableEnded) res.end()
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(payload)
          } catch {
            writeFrame(payload)
            continue
          }
          writeFrame(JSON.stringify(this.normalizeFrame(parsed)))
        }
      }
      if (buffer.includes("[DONE]")) {
        if (!res.writableEnded) res.end()
        return
      }
      writeFrame("[DONE]")
    } finally {
      if (!res.writableEnded) res.end()
    }
  }

  /** Rebuild a chunk against the OpenAI streaming whitelist (drops nulls). */
  private normalizeFrame(value: unknown): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
      const v = obj[key]
      if (v !== undefined && v !== null) out[key] = v
    }
    out.object = out.object ?? "chat.completion.chunk"
    out.id = out.id ?? "chatcmpl-omp-mimo"
    const choices = obj.choices
    if (Array.isArray(choices)) {
      out.choices = choices.flatMap((choice) => {
        if (choice === null || typeof choice !== "object") return []
        const c = choice as Record<string, unknown>
        const delta: Record<string, unknown> = {}
        const d = c.delta === null || typeof c.delta !== "object" ? {} : c.delta as Record<string, unknown>
        const role = d.role
        if (typeof role === "string" && role !== "") delta.role = role
        const content = d.content
        if (typeof content === "string" && content !== "") delta.content = content
        const reasoning = d.reasoning_content
        if (typeof reasoning === "string" && reasoning !== "") delta.reasoning_content = reasoning
        const refusal = d.refusal
        if (typeof refusal === "string" && refusal !== "") delta.refusal = refusal
        const toolCalls = d.tool_calls
        if (Array.isArray(toolCalls) && toolCalls.length > 0) delta.tool_calls = toolCalls
        return [{
          ...(c.index !== undefined ? { index: c.index } : {}),
          delta,
          finish_reason: typeof c.finish_reason === "string" && c.finish_reason !== "" ? c.finish_reason : null,
        }]
      })
    }
    const usage = obj.usage
    out.usage = usage !== null && typeof usage === "object" ? usage : null
    return out
  }

  private async aggregate(response: Response, res: ServerResponse): Promise<void> {
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      // API-key path / non-streaming upstream answers with plain OpenAI JSON.
      const text = await response.text()
      try {
        this.sendJson(res, 200, JSON.parse(text))
      } catch {
        this.sendJson(res, 502, { error: { message: `mimo upstream returned non-JSON: ${text.slice(0, 160)}`, type: "upstream_error" } })
      }
      return
    }
    const text = await response.text()
    let id = "chatcmpl-omp-mimo"
    let created = 0
    let model = "mimo"
    let content = ""
    let reasoning = ""
    let role = "assistant"
    let finishReason = "stop"
    let usage: Record<string, unknown> | undefined
    const toolCalls = new Map<number, Record<string, unknown>>()

    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]") break
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
      const chunk = parsed as Record<string, unknown>
      if (typeof chunk.id === "string" && chunk.id !== "") id = chunk.id
      if (typeof chunk.model === "string" && chunk.model !== "") model = chunk.model
      if (typeof chunk.created === "number") created = chunk.created
      const u = chunk.usage
      if (u !== null && typeof u === "object") usage = u as Record<string, unknown>
      const choices = chunk.choices
      if (!Array.isArray(choices)) continue
      for (const choice of choices) {
        if (choice === null || typeof choice !== "object") continue
        const c = choice as Record<string, unknown>
        const d = c.delta === null || typeof c.delta !== "object" ? {} : c.delta as Record<string, unknown>
        if (typeof d.role === "string" && d.role !== "") role = d.role
        if (typeof d.content === "string") content += d.content
        if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content
        if (typeof c.finish_reason === "string" && c.finish_reason !== "") finishReason = c.finish_reason
        const tcs = d.tool_calls
        if (!Array.isArray(tcs)) continue
        for (const tc of tcs) {
          if (tc === null || typeof tc !== "object") continue
          const call = tc as Record<string, unknown>
          const index = typeof call.index === "number" ? call.index : 0
          const merged = toolCalls.get(index) ?? {}
          if (typeof call.id === "string" && call.id !== "") merged.id = call.id
          if (typeof call.type === "string" && call.type !== "") merged.type = call.type
          const fn = call.function
          if (fn !== null && typeof fn === "object") {
            const f = fn as Record<string, unknown>
            const mf = (merged.function ?? {}) as Record<string, unknown>
            if (typeof f.name === "string" && f.name !== "") mf.name = f.name
            if (typeof f.arguments === "string" && f.arguments !== "") {
              mf.arguments = (typeof mf.arguments === "string" ? mf.arguments : "") + f.arguments
            }
            merged.function = mf
          }
          toolCalls.set(index, merged)
        }
      }
    }

    const message: Record<string, unknown> = { role, content: content === "" ? null : content }
    if (reasoning !== "") message.reasoning_content = reasoning
    const orderedToolCalls = [...toolCalls.keys()].sort((a, b) => a - b).map((k) => toolCalls.get(k))
    if (orderedToolCalls.length > 0) message.tool_calls = orderedToolCalls

    const result: Record<string, unknown> = {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
    }
    if (usage !== undefined) result.usage = usage
    this.sendJson(res, 200, result)
  }
}
