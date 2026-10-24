<div align="center">

# magpie-zcode-switch-auth

**给 [magpie](https://github.com/yetone/magpie) / [OpenCode](https://opencode.ai) 用的 ZCode（GLM Coding Plan）登录与账号导入插件**

ZCode 原版浏览器登录（回调自动完成）· 导入 [Z·SWITCH / zcode-switch](https://github.com/Saktawdi/zcode-switch) 保存的账号 · 多账号并发 · 额度卡片

[![CI](https://github.com/Arimayuki03/magpie-zcode-switch-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/Arimayuki03/magpie-zcode-switch-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/magpie-zcode-switch-auth)](https://www.npmjs.com/package/magpie-zcode-switch-auth)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime](https://img.shields.io/badge/runtime-Bun%20%7C%20Node-f472b6)

**简体中文** · [English](README.en.md)

</div>

---

Provider id 是 `zcode`，与官方社区插件 [`@magpie-community/opencode-zcode-auth`](https://www.npmjs.com/package/@magpie-community/opencode-zcode-auth) 保持一致；本插件以它为底座（MIT），登录、模型、额度等行为不变，只增加了 zcode-switch 账号导入。

> [!WARNING]
> **不要与官方 `zcode` 插件同时安装**：两者声明同一个 provider，后加载的会覆盖先加载的。只想用纯 ZCode、不需要导入 zcode-switch 账号时，直接用官方插件即可。

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [登录与导入方式](#登录与导入方式)
- [部署环境](#部署环境)
- [环境变量](#环境变量)
- [导入细节](#导入细节)
- [工作原理](#工作原理)
- [安全](#安全)
- [常见问题](#常见问题)
- [开发](#开发)
- [致谢](#致谢)
- [License](#license)

## 功能特性

**ZCode 原版登录**

- Z.ai（`z.ai`）GLM Coding Plan
- BigModel（智谱，`bigmodel.cn`）GLM Coding Plan
- 团队席位（team plan），与个人套餐分开保存
- `ZCode app's sign-in`：直接跟随本机 ZCode 客户端的登录
- 粘贴 GLM Coding Plan API key
- 登录流程与官方插件一致：浏览器里完成授权后回调自动收尾，无需粘贴 code

**导入 zcode-switch 账号**

- 从 `~/.zcode-switch/accounts/*.json` 选择一个账号导入
- 一次导入全部已保存账号（magpie 下自动存成多个账号）
- 导入 `.zsb` 加密备份（PBKDF2-HMAC-SHA256 100k + AES-256-GCM）或普通 `zcode-accounts-bundle` JSON
- 支持 ZCode 的 `enc:v1:` 加密凭据（zcode-switch 从 ZCode 本地存储保全的账号）

**领取赠送套餐**（与 zcode-switch 同款流程）

- 自动识别：用量卡片上直接列出账号可领取的赠送套餐（名称与额度）
- 手动领取：登录菜单选「领取赠送套餐」，浏览器完成阿里云验证（无痕优先，失败转滑块）后即领
- 自动领取：`ZCODE_AUTO_CLAIM=1` 时页面打开后自动逐个领取（默认关）
- 刷新状态：领取成功后自动重新解析该账号并保存，额度缓存同步失效

**其余能力沿用官方插件**

- 按账号自动发现模型（含赠额计划的 `-Trial` 模型）
- Coding Plan 额度、Start Plan 余额、团队席位额度
- 多账号并发、用量卡片

## 安装

### 方式一：从 magpie 插件市场安装（已收录后）

在 magpie 里打开 **Plugins → Discover**，搜索 `zcode`，选择本插件安装。

### 方式二：按 npm 包名安装

```sh
magpie plugin add magpie-zcode-switch-auth
```

### 方式三：从 Git 仓库安装

```sh
magpie plugin add https://github.com/Arimayuki03/magpie-zcode-switch-auth
```

### 方式四：从本地文件夹安装（开发/试用）

```sh
magpie plugin add ./                      # 在本插件目录内
magpie plugin add /path/to/magpie-zcode-switch-auth   # 或指定路径
```

也可以在 magpie 应用里走 **Plugins → Add → 选择本文件夹**。

### OpenCode 中安装

在项目或全局的 `opencode.json` 里加入插件名或本地路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["magpie-zcode-switch-auth"]
}
```

本地开发时把包名换成相对路径（如 `"./magpie-zcode-switch-auth"`）。

### 验证安装

```sh
magpie plugin                 # 应显示 zcode (ZCode, 4 models)
magpie plugin --json          # 查看 9 种登录方式和模型
```

## 登录与导入方式

在 magpie 应用里打开 ZCode 插件的登录菜单，或用命令行：

```sh
magpie plugin login zcode            # 交互选择方式
magpie plugin login zcode 1          # 按编号选择
magpie plugin login zcode "zcode-switch: 导入全部已保存账号"
```

| # | 方式 | 说明 |
|---|---|---|
| 1 | `ZCode: Z.ai GLM Coding Plan` | 浏览器登录 Z.ai，回调自动完成 |
| 2 | `ZCode: BigModel (智谱) GLM Coding Plan` | 浏览器登录智谱，回调自动完成 |
| 3 | `ZCode: a team's GLM Coding Plan` | 登录团队席位（与个人套餐分开存） |
| 4 | `ZCode app's sign-in` | 跟随本机 ZCode 客户端当前的登录 |
| 5 | `GLM Coding Plan API key` | 粘贴 `<id>.<secret>` 并选择站点 |
| 6 | `zcode-switch: 导入一个已保存账号` | 从 `~/.zcode-switch/accounts` 选择 |
| 7 | `zcode-switch: 导入全部已保存账号` | 批量导入（magpie 多账号） |
| 8 | `zcode-switch: 导入 .zsb / JSON 备份` | 填文件路径或直接粘贴 JSON，再填口令 |
| 9 | `zcode: 领取赠送套餐` | 自动识别可领套餐，浏览器过验证码后领取并刷新账号 |

### 方式 1–3：浏览器登录

1. 插件向 `https://zcode.z.ai/api/v1/oauth/cli/init` 申请 `flow_id` 和授权页地址；
2. magpie 打开授权页，在浏览器里登录 Z.ai / 智谱；
3. 浏览器最终回到 `zcode://oauth/callback`（由 ZCode 页面转发）；
4. 插件的 `callback()` 轮询 `.../oauth/cli/poll/<flow_id>`，状态变为 `ready` 后拿到 ZCode JWT 和站点 access token；
5. 插件用 access token 换取/创建 `zcode-api-key`，或落到团队席位，或落到 Start Plan；
6. 保存为 magpie 的 `oauth` 登录项。

### 方式 4：跟随本机 ZCode

读取本机 ZCode 客户端的 `~/.zcode/v2/credentials.json`（含 `enc:v1:` 解密）和 `config.json`，之后持续跟随 ZCode 的登录状态、续期与套餐切换。适合不想再单独登录一次的场景。

### 方式 5：粘贴 API key

在 Z.ai / BigModel 控制台创建 key（形如 `<id>.<secret>`），选择站点后粘贴。key 只保存在本机 magpie 的凭据文件里。

### 方式 6–7：导入 zcode-switch 账号库

读取 `~/.zcode-switch/accounts/*.json`（设置过 `ZCODE_SWITCH_HOME` 时读取 `$ZCODE_SWITCH_HOME/.zcode-switch/accounts/*.json`）。方式 6 在下拉列表里选一个；方式 7 批量导入全部，magpie 下多余的账号自动存到独立槽位。

> 下拉选项在插件加载时生成。刚保存的账号没出现时，重启 magpie，或改用方式 7（每次都会重新扫描）。

### 方式 8：导入 `.zsb` / JSON 备份

支持 zcode-switch 的加密导出（外层 `zsw-accounts-bundle`），也接受未加密的 `zcode-accounts-bundle` JSON、单个 Account JSON、裸 credentials 对象。

在路径提示处填文件路径（支持 `~/`、带引号的 Windows 路径），或直接**粘贴 JSON 文本**（以 `{` 开头即可）：

```sh
magpie plugin login zcode 8
# 路径提示处填 /path/to/accounts.zsb；口令：.zsb 填导出时的口令，明文 JSON 留空
```

命令行下口令也可以放在环境变量里：

```sh
ZSW_PASSWORD='你的口令' magpie plugin login zcode 8
```

### 方式 9：领取赠送套餐

与 zcode-switch 的「活动领取」同款流程：识别 ZCode 挂在账号上、还没发到你名下的赠送套餐，过阿里云验证码后领取，并刷新账号状态。

1. 在登录菜单选「领取赠送套餐」，再选账号（本机 ZCode 当前的登录、magpie / OpenCode 里已登录的账号，或任一 zcode-switch 账号）；
2. 插件在 `127.0.0.1` 起一个临时页面并在浏览器打开：页面上列出实时扫描到的可领套餐（名称、额度、周期）；
3. 每个套餐单独「领取」或「全部领取」；验证码优先无痕通过，风控时才需要手动完成滑块；
4. 领取请求由插件携带该账号自己的 JWT 发出（验证码回执经 `X-Aliyun-Captcha-Verify-Param` 头传递，页面不接触任何令牌）；
5. 全部完成后插件自动重新解析该账号并保存——新套餐的额度和模型立即可用。

要点：

- **自动识别**：不需要进领取页，用量卡片上就会列出可领套餐（每行一个，标注额度）。
- **手动识别 / 刷新**：页面上随时「重新扫描」；领取成功会自动刷新，无需重导。
- **自动领取**：设置环境变量 `ZCODE_AUTO_CLAIM=1`（默认关，与 zcode-switch 一致）后，页面打开即自动逐个领取全部可领套餐。
- **领取失败的常见码**：`1002` 活动已结束、`1003` 已领取过、`1004` 不符合条件、`1005` 今日名额用完、`3007` 验证码校验失败（重试即可）。
- **限制**：验证码需要真实浏览器渲染，所以无法完全无人值守；页面只绑定 `127.0.0.1`，Docker 容器内发起的领取无法从宿主机打开——请在宿主机的 magpie / OpenCode 上执行领取。

## 部署环境

### Windows / macOS（magpie 桌面版）

按 [安装](#安装) 任一方式添加插件即可，无需其他依赖（magpie 首次需要时会自行下载 Bun 运行时）。

### Linux

magpie 桌面版或 magpie / OpenCode 的 CLI 都可以：

```sh
# OpenCode CLI（npm 全局安装）
npm i -g opencode-ai

# 项目里接入本插件
cd /path/to/your-project
cat > opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["magpie-zcode-switch-auth"]
}
EOF

opencode auth login    # 选择 ZCode，再选择登录/导入方式
```

无桌面环境时账号库与凭据的默认位置不变（`~/.zcode-switch/accounts`、宿主的 auth 存储文件），用 `ls` 确认路径存在即可。

### Docker

在容器里跑 OpenCode CLI、挂载持久化目录的例子：

```sh
docker run -it --rm \
  -v zcode-data:/root \
  -e ZSW_PASSWORD='你的口令' \
  node:22 bash
```

容器内：

```sh
npm i -g opencode-ai
mkdir -p /work && cd /work
cat > opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["magpie-zcode-switch-auth"]
}
EOF
opencode auth login    # 交互选择 ZCode 的登录/导入方式
```

要点：

- `-v zcode-data:/root` 把 `/root`（含 `~/.zcode-switch`、OpenCode 的 auth 存储）落在命名卷里，容器重建后账号仍在；也可以换成绑定挂载的宿主目录。
- `.zsb` 备份放进挂载目录后，方式 8 的路径填容器内路径（如 `/root/accounts.zsb`）；口令可用 `-e ZSW_PASSWORD=…` 传入，避免写进 shell 历史。
- 容器内没有本机 ZCode 客户端，方式 4（跟随 ZCode 登录）不可用；浏览器登录（方式 1–3）需要在能打开浏览器的宿主机上完成授权页，容器内交互导入请优先用方式 5–8。

## 环境变量

| 变量 | 作用 |
|---|---|
| `ZCODE_SWITCH_HOME` | zcode-switch 数据目录不在默认 home 时，指向其所在目录（插件读取 `$ZCODE_SWITCH_HOME/.zcode-switch/accounts`） |
| `ZCODE_CREDENTIAL_SECRET` | 覆盖 ZCode `enc:v1:` 凭据的解密种子；换过机器或用户名的账号用它指回原机器的种子 |
| `ZSW_PASSWORD` | 方式 8 的口令备用来源（命令行下口令提示留空时读取） |
| `ZCODE_AUTO_CLAIM` | 设为 `1` 时，领取页面打开后自动逐个领取全部可领套餐（默认关） |

## 导入细节

### 凭据优先级

导入时按以下顺序取可用的凭据：

1. **账号 `config` 里的 coding-plan key**
   （`builtin:zai-coding-plan` / `builtin:bigmodel-coding-plan`，以及 ZCode 3.15+ 的 `account:…-individual-coding-plan`）
2. **用账号的 OAuth access token 换取/创建 coding-plan key**
   与官方登录一样，走 `zcode-api-key`（默认项目里没有时会创建）；没有个人套餐时尝试团队席位
3. **Start Plan JWT**
   `zcodejwttoken`（或 `config` 里的 `builtin:*-start-plan`），使用该账号自己的 `virtual_device_mid` 作为设备号

如果 1、2 都拿不到，且 JWT 已过期，该账号会被跳过并给出原因，不会静默导入。

- **读取套餐超时会中止请求并跳过该账号**，提示检查网络后重试；不会悄悄降级成 Start Plan。
- 其他解析失败（例如账号确实没有个人套餐）仍会回退到可用的 JWT，并在日志/toast 中标注“暂用 Start Plan”。
- 同一用户的**个人套餐和团队席位会分开保存**：团队账号显示为 `<账号> (team)`，有独立 uid 和槽位，不会互相覆盖。

> 导入保存的是**当时的快照**：之后在 zcode-switch / ZCode 里换了账号或续期，需要重新导入。想一直跟随本机 ZCode 的当前登录，用方式 4（`ZCode app's sign-in`）。

### 多账号在 magpie 里怎么存

- 本次登录返回的账号由 magpie 自己保存（通常是 `zcode` 或一个 `zcode#…` 槽位）。
- 其余账号由插件调用 `client.auth.set` 存到 `zcode#<稳定槽位>`；槽位由账号 uid 的 SHA-256 前 8 位得到，**重复导入会覆盖同一槽位**，不会越导越多。
- 同一登录的多个文件只会导入一次；团队席位因为 uid 含 `org/project`，会作为独立账号保留。
- OpenCode 的 `auth.set` 没有多账号槽位概念，所以 OpenCode 下批量导入只会保存一个账号，其余会提示逐个导入。

### 设备号

- 账号有 `virtual_device_mid` 时原样使用（Start Plan 与 zcode-switch 看到的设备一致）。
- 没有时按账号 uid 生成稳定的 UUID（同一账号重复导入保持不变）。
- `.zsb` 导出不包含 `virtual_device_mid`，所以从 `.zsb` 导入会生成上述稳定设备号。

### 加密凭据（`enc:v1:`）

zcode-switch 从 ZCode 本地 `credentials.json` 保全的账号可能是 ZCode 的加密形式：

```text
enc:v1:<nonce>.<tag>.<ciphertext>
```

解密密钥规则与 ZCode / zcode-switch 一致：

```text
SHA-256("zcode-credential-fallback:<platform>:<home>:<username>")
```

可用环境变量 `ZCODE_CREDENTIAL_SECRET` 覆盖。未设置时会依次尝试**机器 home**（ZCode 实际加密用的）和 `ZCODE_SWITCH_HOME` 指向的 home，因此移动账号库后仍能解开；换过机器或用户名的账号会解不开，插件会提示在原机器导出 `.zsb` 再导入。

## 工作原理

- 插件作为 provider（id `zcode`）挂进 magpie / OpenCode：`config` 声明模型表，`auth.methods` 提供 9 种登录方式，`auth.loader` 接管模型请求的路由与鉴权。
- 每个出站请求都做主机白名单校验，只允许 `zcode.z.ai`、`api.z.ai`、`bigmodel.cn`、`open.bigmodel.cn`。
- Start Plan 请求按 ZCode 客户端的原样发送（头部与系统提示词保持一致），赠额模型以 `-Trial` 后缀暴露给选择器。

## 安全

- **只访问官方域名**：`zcode.z.ai`、`api.z.ai`、`bigmodel.cn`、`open.bigmodel.cn`。
  - 所有内部 JSON 请求经过主机白名单校验；
  - 保存的 `base` 也会被校正到官方域名，手工改 `plugin-auth.json` 不能把账号密钥指向别处。
- **凭据不落日志**：导入日志只记录账号显示名、数量和失败原因，不打印 token。
- **凭据只存 magpie 的 `plugin-auth.json`**（magpie 以 0600 写入），不写 ZCode 的凭据库，不改 zcode-switch 的账号文件。
- **导入是显式操作**：只有你选择“导入”时才读取 `~/.zcode-switch` 或指定文件；插件加载时只读取账号名/邮箱用于下拉列表，不联网。
- **不发送遥测**：无第三方统计、无远端存储。
- **凭据安全须知**：`~/.zcode-switch` 下的账号文件、`.zsb` 备份和任何 token 都等同于账号本身，只保存在本机、只填进本插件的登录提示框；不要把它们粘贴到任何公开场合（issue、聊天、截图、网盘）。

## 常见问题

**导入后走的是 Start Plan，不是 Coding Plan？**
账号 `config` 里没有 coding-plan key，且用 access token 换取 key 失败（通常是 access token 过期或网络问题）。如果是**读取套餐超时**，这次导入会跳过该账号并提示重试，不会静默降级；重新导入前请确认网络/代理可用。其他失败（账号确实没有个人套餐）会回退到 Start Plan 并在日志中标注；在 zcode-switch / ZCode 里重新登录该账号后再导入，或直接用官方登录方式重新登录一次。

**提示“凭据在这台机器上解不开”？**
账号是另一台机器保存的（ZCode `enc:v1:` 用本机用户信息派生密钥）。在原来的机器上导出 `.zsb`（带口令）再导入，或设置正确的 `ZCODE_CREDENTIAL_SECRET`。

**`.zsb` 提示“口令错误，或备份文件已损坏”？**
口令区分大小写；也确认文件没有被截断。明文 JSON 备份留空口令即可。

**账号下拉列表里没有刚保存的账号？**
下拉选项在插件加载时生成。重启 magpie，或使用“导入全部已保存账号”（每次都会重新扫描）。

**请求 401 / 403 / Start Plan 405？**
ZCode 登录失效或 Start Plan 已结束。重新走官方登录，或在 zcode-switch 里重新登录后再导入。

**Windows 上路径怎么写？**
`.zsb` 路径可以直接粘贴 `C:\Users\…\accounts.zsb`，支持带引号和 `~/`。

**领取赠送套餐失败 / 提示验证码校验失败？**
`3007` 是验证码回执过期或无效，重试一次即可；`1002/1005` 是活动结束或今日名额用完；`1003` 说明已经领过。领取页面打不开时确认 magpie 能访问 `127.0.0.1`（Docker 容器内发起的领取请在宿主机执行）。

**Docker / 容器里能导入吗？**
可以，用方式 5–8（API key 或备份导入）。方式 4 需要本机装有 ZCode 客户端，容器里不可用；浏览器登录（方式 1–3）的授权页要在宿主机浏览器里完成。

## 开发

```sh
npm test          # node:test 单元测试与登录回调测试
npm run check     # 按 magpie / OpenCode 的方式加载插件并检查 hook 形状
```

目录：

```text
src/index.mjs     # 插件入口（官方 zcode 插件 + zcode-switch 导入）
src/zswitch.mjs   # 账号库读取、enc:v1 解密、.zsb 解密、状态生成
src/claim.mjs     # 赠送套餐领取：preview/claim 接口、本地验证码页
src/prompt.mjs    # Start Plan 系统提示词（官方插件原样）
test/             # 单元测试与登录回调测试
scripts/check.mjs # 插件结构检查
```

沙盒验证（不碰真实账号）：

```sh
sb=$(mktemp -d)
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 magpie plugin add ./
# 下一行沿用同一组环境变量：
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 magpie plugin login zcode 6
```

## 致谢

- [magpie-community/plugins](https://github.com/magpie-community/plugins) — `@magpie-community/opencode-zcode-auth`，本插件的底座（MIT）
- [Saktawdi/zcode-switch](https://github.com/Saktawdi/zcode-switch) — 账号库、ZCode 凭据保全、`.zsb` 格式（MIT）
- [yetone/magpie](https://github.com/yetone/magpie) — 插件宿主

## License

[MIT](LICENSE)
