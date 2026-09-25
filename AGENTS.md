# AGENTS.md — omp-plugins

把**桌面应用的模型**接入 [omp](https://omp.sh/) 的扩展集合。本仓库是 **marketplace monorepo**：根目录放 marketplace 目录与仓库规范，每个插件是根下一个独立子目录（独立 npm 包、独立版本号、独立发布）。

本文件是**本仓库的开发与发布规范**，在任何一台电脑上操作都必须遵循同一流程，保证各机器产出的版本一致。

- **远程仓库**：`https://github.com/Anymore0010/omp-plugins.git`
- **默认分支**：`main`
- **marketplace 名称**：`omp-plugins`（用户侧：`omp plugin marketplace add Anymore0010/omp-plugins`）

## 仓库结构与约定

```
.omp-plugin/marketplace.json   # marketplace 目录（omp 只认 .omp-plugin/ 或 .claude-plugin/ 下的 marketplace.json）
AGENTS.md                      # 本文件：仓库规范
README.md  LICENSE  .gitignore # 仓库级文件
omp-workbuddy-connect/         # 插件 A
omp-mimo-connect/              # 插件 B
```

- **一个插件 = 一个子目录 = 一个独立 npm 包**，自带 `package.json` / `tsconfig.json` / `src/` / `README.md`。
- **根目录不放源码、依赖或构建产物**（`package.json` 只存在于子目录）。
- 插件入口 = 该子目录 `package.json` 的 `omp.extensions` 指向的 TS 文件（如 `./src/index.ts`）。
- 新增插件：建子目录 → 写好 `package.json#omp.extensions` → 在 `.omp-plugin/marketplace.json` 的 `plugins[]` 追加条目（`name` / `source: "./<子目录>"` / `version` / `description`）。
- **`marketplace.json` 的 `version` 必须与该子目录 `package.json#version` 一致**：omp 的 `checkForUpdates()` 会**跳过没有 `version` 字段的 catalog 条目**（源码注释即 "Catalog entries without a version field are skipped."），缺失会导致 `omp plugin upgrade` 与开机自动更新**永久静默跳过**该插件。版本解析优先级为 catalog `version` > 子目录清单 > git sha。
- 子目录内**不得**放另一个仓库的 `.git`；仓库根只有一份 git 历史。
- 每个插件的运行时依赖必须为零（只用 Node 内置模块）；`@oh-my-pi/pi-coding-agent` 仅作 dev 类型依赖。

## 提交身份（强制，首次 clone 后必须先做）

本仓库是**公开仓库**，提交身份必须脱敏，不得写入公司名 / 公司邮箱。

| 项 | 值 |
| --- | --- |
| `user.name` | `YuCN` |
| `user.email` | `yuchen0010@qq.com` |

**在任何新机器上 clone 本仓库后，第一条命令就是设置仓库级身份**（不要依赖 global 配置——若该机器的 global 是公司身份，提交会直接把公司邮箱写进公开历史）：

```bash
git config --local user.name  "YuCN"
git config --local user.email "yuchen0010@qq.com"

git config --local user.name                 # 核对
git config --local user.email                # 核对
git var GIT_AUTHOR_IDENT                     # 必须是 YuCN <yuchen0010@qq.com>
git log --format='author=%an <%ae> | committer=%cn <%ce>' -1
```

> 背景：本仓库的前身仓库曾因某台机器的全局 git 身份配置不当，把非预期邮箱写入公开历史，后经历史改写 + force-push 修复。**设置仓库级身份是防止复发的唯一手段**——不要依赖机器的全局配置。

## 版本更新流程（子目录内操作）

> ⚠️ 核心原则：**版本号、tag、Release、附件四者必须对应同一个 commit**。tag 一旦推送不要移动；出错就发新补丁版本。
> ⚠️ **tag 必须带插件名前缀**：`omp-workbuddy-connect-v0.1.4` / `omp-mimo-connect-v0.1.1`。裸 `vX.Y.Z` 会让两个插件在同一个仓库里撞名。

下面以 `omp-workbuddy-connect` 为例，把 `$P` 换成 `omp-workbuddy-connect` / `omp-mimo-connect`。

### 1. 同步与改代码

```bash
git pull --ff-only origin main
# …只修改 $P/src/ 或 $P/README.md；改根文件（marketplace.json / README.md / AGENTS.md）时同样在根提交…
```

### 2. 本地验证（必须通过才继续）

```bash
cd $P
npm install                                                        # 首次或依赖变更后
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json  # 必须 exit 0
```

在 omp 里实测加载（本机开发用 `config.yml`，见 README）：

```bash
omp models | grep workbuddy        # workbuddy (N)
omp models | grep mimo             # mimo (N)
omp --model workbuddy/glm-5.3 -p "只回答：OK"      # 端到端（需桌面版已登录）
```

### 3. 升版本号（两处必须同步）

```bash
cd $P
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='0.1.4';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
cd ..
# 同步 .omp-plugin/marketplace.json 里该插件条目的 version，保持与上面一致
```

### 4. 提交并推送

```bash
git add -A
git commit -m "feat($P): <一句话说明>（v0.1.4）"
git push origin main
```

提交信息约定：`feat:` / `fix:` / `docs:` / `chore:` 前缀 + 范围（插件名）+ 一句话说明。

### 5. 打 tag 并推送

```bash
git tag -a $P-v0.1.4 -m "$P v0.1.4"
git push origin $P-v0.1.4
```

### 6. 生成 portable zip（只用 git，跨平台一致）

**不要手工挑选文件**——用 `git archive` 从当前 commit 导出，保证与 tag 内容完全一致，并自动排除 `node_modules`、`*.mts` 等未跟踪/已忽略文件：

```bash
git archive --format=zip -o ../$P-portable.zip --prefix=$P/ HEAD:$P
```

产物：`../$P-portable.zip`，解压后顶层目录为 `$P/`。

### 7. 创建 Release 并上传附件

```bash
gh release create $P-v0.1.4 ../$P-portable.zip \
  --title "$P v0.1.4 — <标题>" \
  --notes "<变更说明>"
```

**方式 B（无 `gh`，用 `GH_TOKEN` + curl）**：把 `repos/Anymore0010/omp-plugins/releases` 作为端点，`tag_name` 用 `$P-v0.1.4`，附件名用 `$P-portable.zip`。

**方式 C（无凭据）**：在 GitHub 网页 Releases 页手动发布并拖入 zip。

### 8. 核验（发布后必做）

```bash
git status -sb                                  # 应为 ## main...origin/main（无 ahead/behind）
gh release view $P-v0.1.4 -R Anymore0010/omp-plugins
gh api repos/Anymore0010/omp-plugins/releases/tags/$P-v0.1.4 --jq '.assets[].name'
```

**验收标准**：tag 存在、Release 存在、附件 1 个且约 50 KB、`git status -sb` 无 ahead/behind。

### 9. 用户侧升级路径

```bash
omp plugin marketplace update omp-plugins   # 刷新 catalog（否则用的是 24h 缓存副本）
omp plugin upgrade                          # 或 upgrade <name>@omp-plugins
```

## 常见坑

- **改了版本号但没同步 `marketplace.json`**：`omp plugin upgrade` 会认为"已是最新"，静默不升级。
- **catalog 条目缺 `version`**：同上，且开机自动更新永久失效。
- **tag 不带插件名前缀**：同名 tag 会与另一个插件冲突。
- **忘记重新打包就上传**：上传前务必先跑第 6 步，且**先 `git push` 再打包**（`git archive HEAD:$P` 取的是本地 commit）。
- **`git archive` 的 `-o` 用相对路径**：Windows 上 git 不认 MSYS 风格 `/d/Projects/...` 绝对路径，用 `../name.zip` 这类相对路径。
- **CRLF 警告**：Windows 下 `git add` 会提示 `LF will be replaced by CRLF`，属正常，不要提交 `.gitattributes` 强制改行尾。
- **`node_modules` 绝不入库**：子目录 `.gitignore` 已排除；若 `git status` 出现 `node_modules/`，说明 `.gitignore` 被改坏。
- **不要提交凭证**：`~/.omp/.workbuddy-auth.json`、`~/.omp/.mimo-auth.json` 与桌面应用的 auth/Cookie 文件含真实 token，均不在仓库目录内；切勿复制进仓库。上传前扫一遍：
  ```bash
  grep -rniE "eyJ[A-Za-z0-9_-]{10,}|accessToken.*\"[A-Za-z0-9]{20}" . --include='*.ts' --include='*.md' --include='*.json' | grep -v node_modules
  ```
- **不要移动已推送的 tag**：`git push --force` tag 会导致别人下载到不一致内容；要改就发新版本。
- **`.mts` / `_diag.mjs` 冒烟脚本**：属本地调试文件，已被 `.gitignore` 排除，不要提交。
- **marketplace 是 24h 缓存**：`omp plugin add/install` 读的是缓存副本，改完 catalog 要 `omp plugin marketplace update omp-plugins`（或删除后重加）才生效。

## 合规声明（发布物必须保留）

本仓库插件**非官方**，仅供个人学习研究；驱动的是各**桌面客户端接口**（非公开 API），协议可能随时变化；与腾讯 / WorkBuddy / CodeBuddy / 小米 / MiMo **无关联**。各插件 README 的免责声明、参考项目与 `LICENSE` 发布时不得删除。
