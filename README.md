# omp-plugins

我自用的 [omp](https://omp.sh/)（`@oh-my-pi`）扩展集合，以 **marketplace monorepo** 形式发布：仓库根放置 marketplace 目录（`.omp-plugin/marketplace.json`），每个插件是仓库根下的一个独立子目录（各自带 `package.json`、`omp.extensions` 入口、README）。

全部插件都是**零配置桥接**：复用本机桌面应用已有的登录态，把它的模型接进 omp 的 `/model` 选择器，不在 omp 侧再登录一次、也不需要 API Key。

## 安装

```bash
# 1. 订阅本仓库作为 marketplace
omp plugin marketplace add Anymore0010/omp-plugins

# 2. 按需安装（可分别安装 / 升级 / 卸载）
omp plugin install omp-workbuddy-connect@omp-plugins
omp plugin install omp-mimo-connect@omp-plugins
omp plugin install omp-fast-update@omp-plugins

# 查看与升级
omp plugin list
omp plugin upgrade
```

## 插件

| 插件 | 说明 | 前提 |
| --- | --- | --- |
| [`omp-workbuddy-connect`](./omp-workbuddy-connect) | 把 **WorkBuddy 桌面版**的模型接入 omp（`workbuddy/*`）。loopback shim + 复用桌面端鉴权文件。 | 已安装并登录 WorkBuddy 桌面版；omp ≥ 17.4.0 |
| [`omp-mimo-connect`](./omp-mimo-connect) | 把 **小米 MiMo 桌面版**的模型接入 omp（`mimo/*`）。Chromium Cookie 解密 + SSO 换 serviceToken。 | 已安装并登录 MiMo 桌面版；首次读取 Cookie 需关闭 MiMo |
| [`omp-fast-update`](./omp-fast-update) | **并发分片自更新**：`/omp-update` 多连接 Range 下载 GitHub release 二进制，绕过 `omp update` 的单连接限速（实测 0.3 → 3.6 MB/s）。 | 独立二进制安装（非 bun/npm/brew/mise 管理） |

各插件的原理、风险与限制见各自子目录的 `README.md`（MiMo 的上游协议细节见其 `RESEARCH.md`）。

## 仓库结构

```
.omp-plugin/marketplace.json   # marketplace 目录：插件清单（name / source / version）
AGENTS.md                      # 本仓库的开发与发布规范（提交身份、版本流程、tag 命名）
omp-workbuddy-connect/         # 插件 A（独立 npm 包，独立版本号）
omp-mimo-connect/              # 插件 B（独立 npm 包，独立版本号）
omp-fast-update/               # 插件 C（独立 npm 包，独立版本号）
```

约定：

- **一个插件 = 一个子目录 = 一个独立 npm 包**。根目录不放源码、依赖或构建产物。
- 每个插件的入口是它自己 `package.json` 的 `omp.extensions` 指向的 TS 文件。
- `marketplace.json` 里每个条目的 `version` **必须**与该子目录 `package.json` 的 `version` 保持一致——否则 `omp plugin upgrade` 与开机自动更新会静默跳过该插件（详见 `AGENTS.md`）。
- 插件可分别安装、升级、卸载；互不牵连。

## 本地开发（不经过 marketplace）

改源码时直接让 omp 加载工作副本，`omp` 重启即生效：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - D:/Projects/omp-plugins/omp-workbuddy-connect
  - D:/Projects/omp-plugins/omp-mimo-connect
  - D:/Projects/omp-plugins/omp-fast-update
```

类型检查（在每个插件子目录内）：

```bash
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

## 免责声明

- 本仓库插件**仅供个人学习与研究使用**，驱动的是**你自己**机器上**你自己**的账号，不得用于商业用途或超出个人合理使用范围的情形。
- 各插件依赖的是对应**客户端私有端点**（并非官方公开 API），上游随时可能变更协议，届时需跟进适配。使用第三方客户端访问你的账号须遵守相应服务条款，由此产生的后果由使用者自行承担。
- 与腾讯 / WorkBuddy / CodeBuddy / 小米 / MiMo **无关联、未经授权、亦未获其背书**；产品名称仅用于描述兼容性，商标归各自所有者。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
