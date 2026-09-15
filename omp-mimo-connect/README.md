# omp-mimo-connect

把 Xiaomi MiMo 桌面版的模型接入 omp（`@oh-my-pi`），零配置复用桌面版的小米账号登录态。

仅限个人研究/学习用途：驱动你本机自有账号，与小米无关联，禁止商用或转发凭据。

## 工作原理

扩展启动一个只绑定 `127.0.0.1`（随机端口）的 OpenAI 兼容 loopback shim，并注册为
`mimo` provider（keyless）。上游线协议本身就是标准 OpenAI Chat Completions，
shim 的工作只有三件：

1. **凭据复用**（零配置 SSO 路径）：
   - 读取 MiMo 桌面版的 Chromium Cookie 库
     （`%APPDATA%\Xiaomi MiMo\Partitions\xiaomi-account\Network\Cookies`），
     用 `Local State` 里的 `os_crypt.encrypted_key`（DPAPI，经一次性 PowerShell
     解包）+ AES-256-GCM 解出 `passToken` / `userId`（/ `cUserId`）。
   - **Cookie 库被 MiMo 进程锁死**：读取时要求 MiMo 桌面版处于关闭状态
     （或曾成功读过一次，副本已落到 `~/.omp/.mimo-auth.json`）。
   - `serviceToken` 不落盘：每次需要时走小米 passport 两段式换取——
     Phase 1 `GET account.xiaomi.com/pass/serviceLogin?sid=mimopc&_json=true`
     （Cookie: passToken+userId）拿到 `nonce`+`ssecurity`+`location`；
     Phase 2 `GET location&clientSign=...`（**不带 Cookie**，UA `MiClaw/1.0`），
     其中 `clientSign = urlencode(base64(sha1("nonce=<n>&<ssecurity>")))`，
     响应 `Set-Cookie: serviceToken=...`。nonce 是 18 位 int64，超出 JS
     `Number` 安全范围，插件从原始文本提取数字字面量避免精度丢失。
2. **模型名归一化**：CN 路由直接拒绝 `mimo-auto`
   （`chat_model_not_public`, biz_code 41105），shim 按桌面版行为改写为
   `mimo-pro`。
3. **SSE 帧清洗**：剥离 `null` 字段、补默认 `object`/`id`、透传
   `reasoning_content`（MiMo 的思考字段）与 `usage`。

另有 API Key 回退路径：`MIMO_API_KEY` / `XIAOMI_API_KEY` 环境变量，或
`~/.omp/.mimo-auth.json`（官方 `auth.json` 形状：`{"xiaomi":{"type":"api","key":"sk-...","metadata":{"base_url":"..."}}}`）。

## 使用

1. 安装（二选一）：
   - `omp plugin link <本目录绝对路径>`（需 Windows 开发者模式或管理员）
   - 在 `~/.omp/agent/config.yml` 顶层加：
     ```yaml
     extensions:
       - D:/Projects/omp-plugins/omp-mimo-connect
     ```
2. 关闭 MiMo 桌面版（首次读取 Cookie 时必须），启动 omp。
3. `/model` 里选 `mimo/mimo-pro` 或 `mimo/mimo-x-flash-preview`。
4. 模型列表强刷：`/mimo-refresh`（绕过 omp 对扩展动态模型发现的 24h 缓存）。

## 状态检查

shim 暴露两个只读端点（仅 loopback）：

- `GET /v1/status` — 登录态（kind/userId/source）+ 当前模型目录
- `GET /v1/models` — OpenAI 形状的模型列表

## 模型

兜底目录（上游离线时可见）：`mimo-auto`（别名）、`mimo-pro`、`mimo-flash`、
`mimo-x-pro-preview`、`mimo-x-flash-preview`。登录成功后由上游
`/api/model/list`（仅 `TEXT` 类型）替换——CN SSO 档当前实为两个
`mimo-x-*-preview`。cost 列显示的是 `displayRatio` 相对比率（SSO 档 0 = free），
非美元计价。

## 风险与限制

- 驱动的是**客户端私有路由**（`/api/route/*`）+ Cookie 会话，不是
  platform 公开 API 承诺的稳定契约；桌面版升级可能改路径/头。
- macOS / Linux 的 Cookie 解密（Keychain / kwallet）未实现——这两个平台请用
  API Key 路径。
- 本插件只写一个文件：`~/.omp/.mimo-auth.json`（凭据副本，便于 MiMo 运行时
  重启 omp）。聊天内容不落盘；上游服务端按账号归档记录，属账号侧行为。
- 上游账号到限额时上游可能直接断开 socket：shim 已把监听器内的 rejection
  全部捕获并映射为 OpenAI 形状错误（401/502），不会炸掉 omp 会话。

## 开发

```bash
npm install
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

上游协议事实与逆向细节见 `RESEARCH.md`。
