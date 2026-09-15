# Xiaomi MiMo 客户端模型 API 逆向笔记

> 用途：为 `omp-mimo-connect`（仿 `omp-workbuddy-connect`）提供上游协议事实。
> 采集环境：Windows 11，MiMo Desktop **26.914.142245**（domestic / CN），已登录小米账号（uid 已脱敏）。
> 采集方式：静态分析 `app.asar` 字符串 + 本机 AppData 配置/日志 + 本地端口探测。**未抓包、未改客户端。**

---

## 1. 安装与数据目录

| 项 | 路径 |
| --- | --- |
| 安装目录 | `D:\Program Files\Xiaomi MiMo\` |
| 主程序 | `D:\Program Files\Xiaomi MiMo\Xiaomi MiMo.exe` |
| asar | `D:\Program Files\Xiaomi MiMo\resources\app.asar`（约 100 MB） |
| userData | `%APPDATA%\Xiaomi MiMo\` |
| 账号 Cookie 分区 | `...\Xiaomi MiMo\Partitions\xiaomi-account\` |
| 引擎配置 | `...\Xiaomi MiMo\engine-config\` |
| mimocode 运行时数据 | `...\Xiaomi MiMo\mimocode\` |
| 全局 mimocode 配置 | `~/.config/mimocode/` |

运行中的相关端口（会随重启变化）：

- 桌面本地 API：`127.0.0.1:14471`（`desktop-api.json`）
- 内嵌 mimocode 引擎：`127.0.0.1:8269`（曾观察到 4096）
- presentation-host：Unix socket / named pipe

---

## 2. 上游域名与区域

### 2.1 桌面端「免费/SSO 路由」基址（最重要）

```text
const $7 = { CN: "mimo-server-cn.xiaomimimo.com" }
// x7(host) => `https://${host}/api`
// 因此 CN 基址 = https://mimo-server-cn.xiaomimimo.com/api
```

- 环境变量可覆盖：`MIMO_API_BASE_URL`
- 日志可观察到：`[api-base] region=CN source=edition base=https://mimo-server-cn.xiaomimimo.com/api`
- 路由前缀：`{base}/route`，chat 即：

```text
POST https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions
```

- 图片生成同理：`{base}/route/images/generations`
- 用户信息：`{base}/user/xiaomi/me`
- 登出：`{base}/user/xiaomi/logout`
- 可用模型：`{base}/user/available_models`（见 4.2）

### 2.2 官方 OpenAI 兼容 API（API Key / Token Plan）

| 用途 | Base URL |
| --- | --- |
| Billing（按量） | `https://api.xiaomimimo.com/v1` |
| Token Plan 中国 | `https://token-plan-cn.xiaomimimo.com/v1` |
| Token Plan 新加坡 | `https://token-plan-sgp.xiaomimimo.com/v1` |
| Token Plan 阿姆斯特丹 | `https://token-plan-ams.xiaomimimo.com/v1` |
| 内部 router（仅内网） | `http://mimorouter.llmcore.ai.srv/` |

文档入口：`https://platform.xiaomimimo.com/#/docs`
控制台：`https://platform.xiaomimimo.com/console/plugin`

### 2.3 账号 / 登录

- Passport：`https://account.xiaomi.com/pass/serviceLogin?sid=passport`
- 用户核心信息：`https://api.account.xiaomi.com/pass/v2/safe/user/coreInfo`
- 可信 Cookie 域后缀：`xiaomi.com` / `mi.com` / `miui.com`

---

## 3. 鉴权：两条路径

### 路径 A — 小米账号 SSO（桌面免费档，**插件应优先复用**）

桌面在 Electron session partition **`persist:xiaomi-account`** 里持有 Cookie，用 `sessionFetch`（等价 `net.fetch`，自动带 Cookie）打上游。

**关键 Cookie 名**（出现在多个函数里）：

- `passToken`
- `userId`
- `cUserId`（可选）
- `serviceToken`
- `{sid}_serviceToken`
- `{sid}_ph`

**Chat 请求头（SSO 免费路径）**：

```http
POST https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions
Content-Type: application/json
X-Mimo-Source: mimocode-cli-free
Cookie: passToken=...; userId=...; cUserId=...
```

要点：

1. **删除**客户端传入的 `Authorization`（免费路径不走 Bearer）。
2. 鉴权完全靠 **Cookie**，由 Electron session 自动附加。
3. `X-Mimo-Source`：
   - CLI 免费：`mimocode-cli-free`
   - Desktop：`mimocode-desktop`
   - 另见常量 `W7 = "mimocode-cli"`（用于改写判定）。
4. 401 时会尝试 `renewLogin()` 再重试一次，仍失败则 `onAuthLost`。

**账号对象形状**（`secureStorage` key = `xiaomi_account`，7 天过期）：

```ts
{
  passToken: string
  userId: string
  cUserId?: string
  serviceTokens: {
    [sid: string]: {
      token: string
      expiredAt?: number
      timestamp: number
      ssecurity?: string
      nonce?: string
      additionalCookies?: Record<string, string>
    }
  }
  nickName?: string
  icon?: string
  allInfo: Record<string, string>
  loginTime: number
  lastRefreshTime: number
}
```

`secureStorage` 用 Electron `safeStorage`（Windows 上 DPAPI）加密，落盘候选：

- `{userData}/profile-credentials.json`
- `{userData}/plugin-secrets.json`

**本机现状（2026-09-15 采集时）**：这两个文件在 userData 根目录**不存在**。账号态主要落在：

1. Chromium Cookie 库：`Partitions/xiaomi-account/Network/Cookies`
2. 明文摘要：`xiaomi-last-confirmed.json`（仅 userId/displayName/region）
3. 进程内存中的 `currentAccount`

**Cookie 库被 MiMo 进程锁死**：

- `CreateFile` / `FileStream` / `esentutl /y` 均报 `ERROR_SHARING_VIOLATION`（32）或 `JET_errFileAccessDenied`（-1032）
- 因此 **必须先退出 MiMo Desktop** 再拷贝 Cookies，或用 VSS 卷影复制
- Cookies 为 Chromium 加密值（`encrypted_value`），解密需 `Local State` 里的 `os_crypt.encrypted_key`（DPAPI 包一层 AES key，前缀 `DPAPI`）

**Windows 解密 Cookie 的标准步骤**（退出 MiMo 后）：

1. 读 `Local State` → `os_crypt.encrypted_key`（base64）
2. 去掉前缀 `DPAPI`（5 字节），对剩余字节做 DPAPI unprotect → AES-256 key
3. Cookie `encrypted_value`：
   - `v10` / `v11` 前缀
   - 其后 12 字节 nonce + ciphertext + 16 字节 GCM tag
   - AES-256-GCM 解密得到明文 Cookie 值
4. 关注 `host_key` 为 `xiaomimimo.com` / `.xiaomimimo.com` / `account.xiaomi.com` 的行

### 路径 B — API Key（Token Plan / Billing）

```http
POST {base_url}/chat/completions
Content-Type: application/json
Authorization: Bearer {key}
X-Mimo-Source: mimocode-desktop
```

- `base_url` 见 2.2
- 凭据文件（mimocode CLI/desktop 通用）：`auth.json`，形状：

```json
{
  "xiaomi": {
    "type": "api",
    "key": "sk-...",
    "metadata": {
      "base_url": "https://api.xiaomimimo.com/v1",
      "user_id": "...",
      "name": "...",
      "email": "..."
    }
  }
}
```

- 本机**未找到**现成 `auth.json`（`~/.local/share/mimocode`、`~/.config/mimocode`、userData 均无）
- 伪 key：SSO 登录时会写出哨兵值 `"xiaomi-sso-session"`，表示「用 SSO，不要用这把 key」

---

## 4. Chat / Models 协议细节

### 4.1 Chat

- **线协议即 OpenAI Chat Completions**，不是 WorkBuddy 那种私有 envelope。
- 请求体：标准 `model / messages / stream / tools / tool_choice / temperature / ...`
- 模型名改写（`mimo-auto` → 具体模型）：

```ts
const ac = "mimo-auto", Rc = "mimo-flash", so = "mimo-pro"
// mimo-auto 若最终解析结果仍是 auto，则默认落到 mimo-pro
// 形如 `provider/mimo-auto` 的后缀 `/mimo-auto` 会被替换成 `/mimo-pro`
```

- SSO 路径**强制把 body 里的 model 做上述归一化**（`bb` / `V7`）。
- 响应：SSE `text/event-stream`，OpenAI chunk 形状；thinking 字段为 **`reasoning_content`**（interleaved）。
- 错误分类与 workbuddy 类似：401 未登录 / 403 WAF / 额度不足等。

### 4.2 可用模型列表

```http
GET {base}/user/available_models
Authorization: Bearer {token}
```

响应信封：

```json
{ "code": 0, "data": { "groups": [ { "models": ["mimo-v2.5-pro", "..."] } ] } }
```

- `code !== 0` 视为失败
- 会过滤掉 embedding/tts/asr/whisper/rerank/ocr/audio/video/speech 等非 chat 模型
- 本机缓存：`userData/model-catalog.json`

当前本机 `model-catalog.json`（uid 已脱敏）：

| id | name | modelType |
| --- | --- | --- |
| Doubao-Seedream-5.0-pro | Seedream5.0 Pro | IMAGE_GENERATION |
| mimo-v2.5-asr | mimo V2.5 ASR | ASR |
| mimo-v2.5-tts | mimo V2.5 TTS | TTS |
| mimo-v2.5-tts-voiceclone | ... | TTS |
| mimo-v2.5-tts-voicedesign | ... | TTS |
| mimo-x-flash-preview | MiMo-X-Flash-Preview | TEXT |
| mimo-x-pro-preview | MiMo-X-Pro-Preview | TEXT |

### 4.3 内置默认模型表（asar 硬编码，兜底用）

```ts
const rh = "mimo-auto", Rc = "mimo-flash", so = "mimo-pro"

const Hv = {
  id: "mimo-auto",
  name: "MiMo Auto",
  family: "mimo",
  release_date: "2026-07-01",
  attachment: true,
  reasoning: true,
  tool_call: true,
  temperature: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_000_000, output: 128_000 },
  cost: { input: 0, output: 0 },
}

const kR = {
  "mimo-flash": { ...Hv, id: "mimo-flash", name: "MiMo Flash" },
  "mimo-pro":   { ...Hv, id: "mimo-pro",   name: "MiMo Pro" },
}

const kb = { "mimo-auto": Hv, ...kR }
const Z7 = "mimo-v2.5-pro"   // 默认偏好模型
```

`models-with-claude.json`（约 4.6 MB）里还有完整第三方目录，其中 `xiaomi` / `xiaomi-token-plan-cn` 段含：

- `mimo-v2.5-pro-ultraspeed`（context 128k, output 32k, cost input=2 output=8）
- 若干 v2.5 pro / TTS 变体

---

## 5. 本机桌面侧本地 API（**不是**模型 API）

`desktop-api.json`：

```json
{
  "api": 1,
  "port": 14471,
  "token": "<会话级 bearer token，已脱敏；每次重启都会变化>",
  "pid": 16396
}
```

- 仅绑 `127.0.0.1`，Host 白名单校验
- 鉴权：`Authorization: Bearer {token}`（timingSafeEqual）
- 路由只有会话控制类：`health` / `sessions` / `messages` / `events` / `turns` / `file`
- **没有** `/v1/chat/completions`、`/v1/models`（实测 404）
- 子进程注入：`MIMO_DESKTOP_PORT` / `MIMO_DESKTOP_TOKEN` / `MIMO_DESKTOP_PID`

内嵌引擎（opencode/mimocode）鉴权：

```text
Authorization: Basic base64("opencode:" + MIMOCODE_SERVER_PASSWORD)
```

引擎侧另有 `mimo llm-server` 能力 token（`llmk_...`，只存 SHA-256），与桌面账号 Cookie 无关。

---

## 6. 对 `omp-mimo-connect` 的设计结论

对齐 `omp-workbuddy-connect` 的五层结构，但上游换成 MiMo：

| 层 | WorkBuddy | MiMo |
| --- | --- | --- |
| 凭据 | 桌面明文 `workbuddy-desktop.info` | Chromium Cookie（需解密）或 API Key |
| 上游 chat | `copilot.tencent.com/v2/chat/completions` | SSO：`mimo-server-cn.xiaomimimo.com/api/route/chat/completions`；Key：`api.xiaomimimo.com/v1/chat/completions` |
| 协议 | 私有 + SSE 归一化 | **基本就是 OpenAI**，主要是换头 + 模型名归一化 |
| 模型目录 | `/console/enterprises/personal/models` | `/user/available_models` + 本地 `model-catalog.json` + 硬编码兜底 |
| Provider | `workbuddy` | `mimo` |

### 推荐实现策略

1. **优先 SSO Cookie 路径**（零配置，复用桌面登录）
   - 启动时尝试读 `Partitions/xiaomi-account/Network/Cookies`（只读拷贝；失败则等用户关掉 MiMo 再试，或提供 `/mimo-refresh`）
   - 用 `Local State` 的 `os_crypt.encrypted_key` + DPAPI + AES-GCM 解密
   - 组装 `Cookie: passToken=...; userId=...`，打 `/api/route/chat/completions`，头 `X-Mimo-Source: mimocode-cli-free`
2. **回退 API Key 路径**
   - 读 env `XIAOMI_API_KEY` / `MIMO_API_KEY` 或 `~/.omp/.mimo-auth.json`
   - `base_url` 默认 `https://api.xiaomimimo.com/v1`，可用 `token-plan-cn.xiaomimimo.com/v1`
3. **模型**
   - 兜底表：`mimo-auto` / `mimo-flash` / `mimo-pro`（+ 本机 catalog 的 `mimo-x-*`）
   - `fetchDynamicModels`：有 Cookie 时 GET `/user/available_models`；否则保持兜底
   - 把 `mimo-auto` 映射为 `mimo-pro`（与桌面默认一致）
4. **body 归一化**
   - 可直接透传 OpenAI JSON
   - 可选：改写 `mimo-auto` → `mimo-pro`
5. **安全**
   - shim 只听 `127.0.0.1`，校验 loopback Host（照抄 workbuddy）
   - 不回写桌面 Cookie 库；自有副本放 `~/.omp/.mimo-auth.json`

### 与 WorkBuddy 的关键差异

| | WorkBuddy | MiMo |
| --- | --- | --- |
| 上游是否 OpenAI 兼容 | 否，要重写帧 | **是**，shim 可薄很多 |
| 凭据文件 | 明文 JSON，好读 | Chromium 加密 Cookie，**运行中文件锁** |
| 计费展示 | credits 倍率 | 官方 API 有 cost；SSO 免费档 cost=0 |
| 流式 thinking | `reasoning_content` | 同样是 `reasoning_content` |

---

## 7. 下一步（退出 MiMo 后用 omp 继续）

1. **退出 MiMo Desktop**（必须，否则 Cookies 库锁着）
2. 拷贝并解密：
   - `%APPDATA%\Xiaomi MiMo\Partitions\xiaomi-account\Network\Cookies`
   - `%APPDATA%\Xiaomi MiMo\Local State`
   - 验证能解出 `passToken` / `userId`
3. 用 curl 冒烟（只读、极短 prompt）：

```bash
# 伪代码：Cookie 换成解密结果
curl -N https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Mimo-Source: mimocode-cli-free" \
  -H "Cookie: passToken=...; userId=..." \
  -d '{"model":"mimo-pro","messages":[{"role":"user","content":"只回答：OK"}],"stream":true}'
```

4. 确认 SSE 正常后，按 workbuddy 目录结构写插件：
   - `src/index.ts` — `registerProvider("mimo")` + `/mimo-refresh`
   - `src/auth.ts` — Cookie/Key 解析（Win/mac/Linux 路径）
   - `src/upstream.ts` — SSO / API-Key 双路径 + 模型归一化
   - `src/store.ts` — 凭据缓存（不写回桌面）
   - `src/server.ts` — loopback OpenAI shim（可比 workbuddy 薄）
   - `src/catalog.ts` — 兜底模型表
5. `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
6. `omp plugin link .` → `omp --model mimo/mimo-pro -p "只回答：OK"`

---

## 8. 合规与风险

- 驱动的是**客户端私有路由**（`/api/route/*`）与 Cookie 会话，**不是** platform 公开 API 文档承诺的稳定契约；桌面升级可能改路径/头。
- 仅建议个人研究、本机自有账号；勿商用、勿转发凭据。
- 与 Xiaomi / MiMo 无关联。README 发布时需保留免责声明（对齐 workbuddy-connect）。

---

## 9. 采集时本机快照（便于对照）

```text
xiaomi-last-confirmed.json
  userId=<已脱敏> displayName=<已脱敏> region=CN

preferences.json
  model = "mimo-auto"

desktop-api.json
  port=14471 (token 见文件，会话级，重启会变)

日志关键行
  [user-auth] init ok requiresCnAccount=true cachedRegion=CN
  [xiaomi-auth] probeStatus done kind=authenticated userId=<已脱敏>
  [mimo][api] listening on 127.0.0.1:14471
  [model-catalog] xiaomi login not confirmed -> skip fetch, keep cache
  （注意：有一条 “login not confirmed” 与后面的 authenticated 并存，可能是启动时序问题；catalog 仍用缓存）
```

`model-catalog.json` 在 20:21 已有内容，说明登录确认后曾成功拉过一次。

---

## 10. 未决问题 —— 已全部验证（2026-09-15 插件实现时）

1. **SSO chat 需要 serviceToken，不只 passToken+userId。** 完整流程：
   - Phase 1：`GET account.xiaomi.com/pass/serviceLogin?sid=mimopc&_json=true`，
     Cookie `passToken+userId(+cUserId)`，UA `MiClaw/1.0` →
     `&&&START&&&{code:0, nonce, ssecurity, location, passToken(轮换)}`。
   - Phase 2：`GET location&clientSign=...` **不带 Cookie**（桌面版 SSO_curl.cpp
     `cookies.clear()` 对齐），UA `MiClaw/1.0` → `Set-Cookie: serviceToken=...`（364B）。
     `clientSign = urlencode(base64(sha1("nonce=<n>&<ssecurity>")))`。
   - ⚠️ nonce 是 18 位 int64，超出 JS Number 2^53 安全范围，`JSON.parse` 会静默
     舍入（…270→…272）导致签名错误、STS 401——必须从原始文本提取数字字面量。
2. **Cookie 库里只有 `.xiaomi.com` 域**：passToken(347B, V1:格式)/userId/cUserId/
   uLocale；`xiaomimimo.com` 域无任何 Cookie（serviceToken 是运行时换取的，只存内存）。
3. **模型目录不是 `/user/available_models`**（那是 mimorouter 内网路径用的，
   带 `Authorization: Bearer`；CN server 全部 404）。SSO 下用
   `GET /api/model/list`（Cookie serviceToken+userId）→
   `{code:0, data:{models:[{modelName, description, modelType, displayRatio, ...}]}}`，
   过滤 `modelType === "TEXT"` 即 chat 模型。CN SSO 档当前仅
   `mimo-x-flash-preview`(x0.4) 与 `mimo-x-pro-preview`(x1.0)。
4. **免费档限制**：`stream_options.include_usage` 未验证（shim 不发它）；
   usage 每流末尾一帧自带。`mimo-auto` 被 CN 路由直接拒绝
   （`chat_model_not_public`, biz_code 41105），须改写为 `mimo-pro`；
   `mimo-flash`→`mimo-x-flash-preview`、`mimo-pro`→`mimo-x-pro-preview`
   由上游服务端自行路由。tool_calls 字段存在但本轮未实测完整工具调用。
5. **macOS/Linux partition 路径**：与 §1.1 一致；解密未实现（Keychain/kwallet），
   这两个平台走 API Key 路径。
6. safeStorage 回退：与本插件无关（只读 Cookie 库，不复现 safeStorage）。
7. **运行时锁实测（Node/libuv）**：MiMo 运行中时 `readFileSync(Cookies)` 直接
   `EBUSY`（早前 PowerShell `FileStream`/`esentutl` 的"锁死"结论对 Node 同样成立；
   曾有一次"copy OK"实为 exe 未启动的假阳性）。因此零配置 SSO 的可用条件是：
   **首次读取需 MiMo 关闭**，之后凭据副本（`~/.omp/.mimo-auth.json`）覆盖重启场景
   （含 MiMo 运行中）。passToken 是小米账号级主令牌（可铸任意 sid 的
   serviceToken），比 workbuddy 的 accessToken 敏感得多——仅缓存于本机用户目录，
   不做其他落盘。
8. **401 自愈**：`SERVICE_TOKEN_TTL_MS`（6h）是猜测值（上游不公开真实寿命）。
   `chatStream` 遇 401 时丢弃缓存 token、重铸一次并重试一次；
   `onTokenMinted` 钩子把 Phase 1 返回的 passToken 轮换持久化到 owned 副本
   （否则轮换只改内存对象，重启即失）。

### 实现状态（omp-mimo-connect 0.1.0）

按 §7.4 落地：`src/{index,auth,upstream,store,server,catalog}.ts`，端到端冒烟通过
（真实 SSO 解密 → passport 两段式 → chat 200 非 stream/stream → 活模型目录替换兜底）。
与计划的差异：Windows DPAPI 解包用一次性 PowerShell `ProtectedData::Unprotect`
（结果缓存，无原生依赖）；nonce 从原始 JSON 文本提取（见上）。

---

*文档生成时间：采集会话内。若 MiMo 升级 major，先复查 asar 中 `$7`、`X-Mimo-Source`、`/route/chat/completions` 三处字符串。*
