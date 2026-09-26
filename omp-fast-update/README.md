# omp-fast-update

给 [omp](https://omp.sh/) 的**并发分片自更新**扩展：`/omp-update` 用多连接 Range 下载 GitHub release 二进制，绕过 `omp update` 单连接被限速的问题。

> 仅供个人研究/学习用途。与 omp 项目**无关联**。MIT。

## 为什么需要它

`omp update` 用**单条 HTTP 流**下载 release 资产（`cli/update-cli.ts` 的 `downloadVerifiedBinary`）。在跨境链路上单连接常被限速到几百 KB/s，而同一 asset 开多条连接几乎线性叠加。本机同一时刻实测（`omp-windows-x64.exe`，v18.3.2，235 MB）：

| 方式 | 吞吐 |
| --- | --- |
| 单连接（`omp update` 行为） | 0.21–0.66 MB/s |
| 8 连接分片 | 1.8–2.0 MB/s |
| 16 连接分片 | **3.6 MB/s**（235 MB / 63 s） |

即同一份字节，快约 14 倍。

## 安装

```bash
omp plugin marketplace add Anymore0010/omp-plugins
omp plugin install omp-fast-update@omp-plugins
```

或本地开发（`~/.omp/agent/config.yml`）：

```yaml
extensions:
  - D:/Projects/omp-plugins/omp-fast-update
```

## 用法

```
/omp-update                 检查并安装最新版（默认 64 并发）
/omp-update --check         只看是否有新版本
/omp-update --force         已是最新也重装
/omp-update --canary        走 canary 渠道
/omp-update -j 32           并发分片数（只有 2/4/8/16/32/64 这几档）
/omp-update --chunk 16      每片 16 MB
/omp-update --version 18.3.2  安装指定版本
```

别名 `/fast-update`。`--help` 打印完整用法。

### 终端直接运行（像 `omp update` 一样）

`omp <子命令>` 无法由插件扩展（主机 CLI 命令表是硬编码的），所以提供等价入口：把 `omp-fast-update` 装到 PATH，然后终端里直接敲：

```
omp-fast-update              # 等价 /omp-update
omp-fast-update --check
omp-fast-update -j 32
```

安装 shim（二选一）：

```
/omp-update-install-cli                     # omp 会话内
bun <插件目录>/src/main.ts --install-cli    # 或直接跑 CLI
```

shim 写在 `omp` 可执行文件所在目录（该目录已在 PATH 上、且用户可写），内容只是 `bun "<绝对路径>/src/main.ts" %*`。

| 命令 | 作用 |
| --- | --- |
| `--install-cli` | 生成 `omp-fast-update.cmd` / `.ps1`（Windows）或 `omp-fast-update`（POSIX） |
| `--status-cli` | 查看状态；**插件升级后路径会变，需重装** |
| `--uninstall-cli` | 删除 shim |

shim 只认自己写入的内容（带标记），不会覆盖你同名的既有文件。

并发数**不是任意值**：只接受 `2/4/8/16/32/64` 六档（默认 64），其它值直接报错——避免 `-j 1000` 这类把连接数打满的做法。实际并发受分片总数限制；分片会按并发数自动缩小（下限 1 MB），所以 64 档在 225 MB 的资产上能真正跑满 64 条连接，而不是被 8 MB 分片卡在 29 条。

## 它做了什么

1. **版本解析** —— 先查 npm registry 的 `latest` / `canary` dist-tag（无限流），再用 GitHub release `v<version>` 元数据取资产 URL、size 与 `sha256:` digest。注意：本插件**固定查 `registry.npmjs.org`**，而 `omp update` 会遵循 `~/.npmrc` 配置的 registry（源码 `loadNpmRegistryResolver`）。若你配了镜像（本机为 `registry.npmmirror.com`），两者对"最新"的判断可能短暂不一致；用 `--version X.Y.Z` 可指定版本。
2. **平台资产** —— `omp-windows-x64.exe` / `omp-darwin-arm64` / `omp-linux-musl-x64` 等，与 omp 自身的映射一致（含 musl 探测）。命令**不检查** `omp.dist`：只要能定位到独立二进制启动器就按二进制更新，无法定位则回退提示 `omp update`。
3. **并发分片下载** —— Range 探测确认支持 206 后，把资产切成固定大小分片，N 个 worker 各写自己那段偏移（文件预分配、`write(..., position)` 不共享写指针）。每片必须**字节数严格相等**；任何短读/断流都**整片重下**（绝不 `-C -` 式续传，避免重叠损坏），指数退避，默认 6 次。请求有 5 分钟单片超时、20 分钟整体超时。
4. **校验** —— 全部完成后统一校验 size 与 SHA-256（与 release 元数据比对）；任何不符都删掉暂存文件并报错，**不会**把半成品当成成功。
5. **安装与回滚** —— 暂存文件与目标同目录（保证 rename 同卷）：把现启动器改名为 `<target>.ompfastupdate.<时间戳>.<pid>.<序号>.bak`，把新文件 rename 就位，再执行 `<target> --version` 校验；不符则**回滚**回旧启动器。交换期间用 `<target>.fast-update.lock` 串行化，避免两个更新同时换。

   所有本插件产生的临时/备份文件都带 **`.ompfastupdate` 标记**，清理只认带标记的文件：`omp update` 自己的备份（`<binary>.<数字>.bak`）是用户的回退点，绝不被本插件删除（反之 omp 的正则也匹配不到本插件的名字）。带标记的 `.new` 超过 15 分钟回收，带标记的 `.bak` 保留 7 天后回收。

## 边界（重要）

- **只处理独立二进制安装**。启动器是符号链接、shell/`cmd`/`ps1` shim、或非 `.exe` 时会被识别为包管理器（bun/npm/brew/mise）安装，命令只报告并指向 `omp update`，不做任何替换。
- **不做 bun/npm 全局重装**（不解析 `omp.dist`；靠启动器形态判定）。
- **`--canary` 走 GitHub prerelease**：canary 版本是预发布，只有 `--canary` 渠道放行。
- **Windows 上旧备份可能删不掉**：正在运行的进程镜像无法 unlink，`<target>.<stamp>.bak` 会留给下次运行回收（与 `omp update` 行为一致）。
- **需要 Range 支持**：若服务器不返回 206，自动退回单连接下载（仍然做 size/digest 校验），此时不会有加速。
- **代理**：沿用进程环境（Bun `fetch` 遵循 `HTTPS_PROXY`）。
- **GitHub API 限流**：取 release 元数据用的是 GitHub API（未认证时可能 403）；设置 `GITHUB_TOKEN` 或 `GH_TOKEN` 即可。

## 原理速览

```
/omp-update
   ├─ npm registry        → 版本（latest / canary dist-tag）
   ├─ GitHub release API  → asset url + size + sha256
   ├─ N × Range 请求      → 分片写入预分配文件（各写各的偏移）
   ├─ size + sha256       → 与 release 元数据比对（不符即删）
   └─ rename 交换 + --version 校验 → 失败回滚
```

## 开发

```bash
cd omp-fast-update
npm install
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

源码：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 扩展入口：注册 `/omp-update`、`/fast-update`，桥接 `ctx.ui` |
| `src/cli.ts` | 参数解析与用法文本 |
| `src/release.ts` | 版本/渠道解析、平台资产名、GitHub release 元数据校验 |
| `src/download.ts` | 并发分片下载 + sha256/size 校验（含单连接回退） |
| `src/replace.ts` | 启动器归属判定、锁、暂存/交换/回滚、残留回收（只清理带 `.ompfastupdate` 标记的文件） |
| `src/update.ts` | 编排：解析 → 下载 → 校验 → 安装，UI 文案 |
| `src/main.ts` | 独立 CLI 入口（`omp-fast-update` 命令、`--install-cli` 等） |
| `src/shim.ts` | PATH shim 的安装/状态/卸载（带标记，不覆盖同名文件） |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
