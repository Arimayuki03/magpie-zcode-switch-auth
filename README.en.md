<div align="center">

# magpie-zcode-switch-auth

**ZCode (GLM Coding Plan) sign-in and account-import plugin for [magpie](https://github.com/yetone/magpie) / [OpenCode](https://opencode.ai)**

ZCode's own browser sign-in with an automatic callback · imports accounts saved by [Z·SWITCH / zcode-switch](https://github.com/Saktawdi/zcode-switch) · multi-account concurrency · usage cards

[![CI](https://github.com/Arimayuki03/magpie-zcode-switch-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/Arimayuki03/magpie-zcode-switch-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/magpie-zcode-switch-auth)](https://www.npmjs.com/package/magpie-zcode-switch-auth)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime](https://img.shields.io/badge/runtime-Bun%20%7C%20Node-f472b6)

[简体中文](README.md) · **English**

</div>

---

The provider id is `zcode`, matching the official community plugin
[`@magpie-community/opencode-zcode-auth`](https://www.npmjs.com/package/@magpie-community/opencode-zcode-auth).
This plugin is a superset of it (MIT): sign-in, models and usage behave the
same, and what is added is importing zcode-switch accounts.

> [!WARNING]
> **Do not install it beside the official `zcode` plugin**: both declare the
> same provider, and whichever loads last replaces the other. If you only want
> plain ZCode without zcode-switch imports, the official plugin is enough.

## Contents

- [Features](#features)
- [Install](#install)
- [Sign-in and import methods](#sign-in-and-import-methods)
- [Environments](#environments)
- [Environment variables](#environment-variables)
- [Import details](#import-details)
- [How it works](#how-it-works)
- [Security](#security)
- [FAQ](#faq)
- [Development](#development)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Features

**ZCode's own sign-in**

- Z.ai (`z.ai`) GLM Coding Plan
- BigModel (`bigmodel.cn`) GLM Coding Plan
- A team's plan (team seat), kept apart from the personal one
- `ZCode app's sign-in`: follows the ZCode client signed in on this machine
- Pasting a GLM Coding Plan API key
- The flow matches the official plugin: once the browser finishes, the
  callback completes on its own — no code to paste

**Importing zcode-switch accounts**

- Pick one account from `~/.zcode-switch/accounts/*.json`
- Import every saved account at once (stored as multiple accounts under
  magpie)
- Import `.zsb` sealed bundles (PBKDF2-HMAC-SHA256 100k + AES-256-GCM) or
  plain `zcode-accounts-bundle` JSON
- Understands ZCode's `enc:v1:` encrypted credentials (accounts preserved
  by zcode-switch from ZCode's local storage)

**Claiming gift plans** (the same flow zcode-switch uses)

- Auto-detection: the usage card lists every gift plan the account can
  claim, with its grants
- Manual claim: pick "领取赠送套餐" (claim gift plans) in the sign-in menu,
  pass the Aliyun captcha in the browser (traceless first, slider as the
  fallback), and it is claimed
- Auto-claim: with `ZCODE_AUTO_CLAIM=1` the page claims every detected plan
  as soon as it opens (off by default)
- Refresh: after a successful claim the account's sign-in is re-resolved
  and saved, and the usage caches are invalidated

**Carried over from the official plugin**

- Models discovered per account (including the gift plans' `-Trial` models)
- Coding Plan usage, Start Plan balance, team-seat usage
- Multi-account concurrency and usage cards

## Install

### Option 1: from magpie's plugin marketplace (once listed)

In magpie, open **Plugins → Discover**, search for `zcode`, and install this
plugin.

### Option 2: by npm package name

```sh
magpie plugin add magpie-zcode-switch-auth
```

### Option 3: from a Git repository

```sh
magpie plugin add https://github.com/Arimayuki03/magpie-zcode-switch-auth
```

### Option 4: from a local folder (development / trying it out)

```sh
magpie plugin add ./                                   # inside this folder
magpie plugin add /path/to/magpie-zcode-switch-auth    # or a given path
```

The magpie app can also do it through **Plugins → Add → pick this folder**.

### In OpenCode

Add the package name or a local path to the `plugin` key of your project or
global `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["magpie-zcode-switch-auth"]
}
```

For local development, replace the package name with a relative path such as
`"./magpie-zcode-switch-auth"`.

### Verify

```sh
magpie plugin                 # should print zcode (ZCode, 4 models)
magpie plugin --json          # the 9 sign-in methods and the models
```

## Sign-in and import methods

Open the ZCode plugin's sign-in menu in the magpie app, or use the CLI:

```sh
magpie plugin login zcode            # pick a method interactively
magpie plugin login zcode 1          # or by number
magpie plugin login zcode "zcode-switch: 导入全部已保存账号"
```

| # | Method | What it does |
|---|---|---|
| 1 | `ZCode: Z.ai GLM Coding Plan` | Sign in to Z.ai in the browser; the callback finishes on its own |
| 2 | `ZCode: BigModel (智谱) GLM Coding Plan` | Sign in to BigModel in the browser |
| 3 | `ZCode: a team's GLM Coding Plan` | Sign in to a team seat (kept apart from the personal plan) |
| 4 | `ZCode app's sign-in` | Follow the ZCode client's current sign-in on this machine |
| 5 | `GLM Coding Plan API key` | Paste `<id>.<secret>` and pick a site |
| 6 | `zcode-switch: 导入一个已保存账号` (import one saved account) | Choose from `~/.zcode-switch/accounts` |
| 7 | `zcode-switch: 导入全部已保存账号` (import all saved accounts) | Bulk import (multiple accounts under magpie) |
| 8 | `zcode-switch: 导入 .zsb / JSON 备份` (import a .zsb / JSON backup) | Give a file path or paste JSON, then the password |
| 9 | `zcode: 领取赠送套餐` (claim gift plans) | Detects claimable plans, passes the captcha in the browser, claims and refreshes the account |

> The method labels come from the plugin itself and are partly Chinese; the
> numbered selection works the same in English.

### Methods 1–3: browser sign-in

1. The plugin asks `https://zcode.z.ai/api/v1/oauth/cli/init` for a `flow_id`
   and the authorize-page address;
2. magpie opens the authorize page; sign in to Z.ai / BigModel in the browser;
3. the browser ends up back at `zcode://oauth/callback` (forwarded by the
   ZCode page);
4. the plugin's `callback()` polls `.../oauth/cli/poll/<flow_id>`; once the
   status is `ready` it takes the ZCode JWT and the site's access token;
5. the plugin mints or finds the `zcode-api-key` with the access token, or
   lands on a team seat, or on the Start Plan;
6. the sign-in is saved as a magpie `oauth` entry.

### Method 4: follow the local ZCode

Reads the local ZCode client's `~/.zcode/v2/credentials.json` (including
`enc:v1:` decryption) and `config.json`, then keeps following ZCode's
sign-in, its renewed sessions and its plan switches. For when you would
rather not sign in a second time.

### Method 5: paste an API key

Create a key (shaped `<id>.<secret>`) in the Z.ai / BigModel console, pick
the site, and paste it. The key is only written to magpie's local
credentials file.

### Methods 6–7: import the zcode-switch library

Reads `~/.zcode-switch/accounts/*.json` (or
`$ZCODE_SWITCH_HOME/.zcode-switch/accounts/*.json` when `ZCODE_SWITCH_HOME`
is set). Method 6 picks one from a dropdown; method 7 imports them all, and
under magpie the extra accounts go to their own slots.

> The dropdown is built when the plugin loads. If a just-saved account is
> missing, restart magpie, or use method 7, which rescans every time.

### Method 8: import a `.zsb` / JSON backup

Accepts zcode-switch's sealed export (the `zsw-accounts-bundle` envelope)
and also a plain `zcode-accounts-bundle` JSON, a single Account JSON file,
or a bare credentials object.

At the path prompt, give a file path (`~/` and quoted Windows paths are
fine), or **paste the JSON text** directly (anything starting with `{`):

```sh
magpie plugin login zcode 8
# at the path prompt give /path/to/accounts.zsb; a .zsb takes its export password, plain JSON an empty one
```

On the CLI the password can come from the environment instead:

```sh
ZSW_PASSWORD='your password' magpie plugin login zcode 8
```

### Method 9: claim gift plans

The same flow as zcode-switch's claiming: detect the gift plans ZCode is
holding for the account but has not granted yet, pass the Aliyun captcha,
claim them, and refresh the account's state.

1. In the sign-in menu pick "领取赠送套餐" (claim gift plans), then an
   account (the local ZCode app's sign-in, or any zcode-switch account);
2. the plugin serves a temporary page on `127.0.0.1` and opens it in the
   browser: it lists the claimable plans found by a live scan (name,
   grants, period);
3. claim each plan, or all of them at once; the captcha passes tracelessly
   when it can, and only asks for the slider under risk control;
4. the claim request itself goes out from the plugin with the account's own
   JWT (the captcha ticket travels in the `X-Aliyun-Captcha-Verify-Param`
   header; the page never touches any token);
5. when the page is done, the plugin re-resolves the account and saves it —
   the new plan's allowance and models are usable at once.

Notes:

- **Auto-detection**: no need to open the claim page — the usage card lists
  the claimable plans, one line each, with their grants.
- **Manual detection / refresh**: the page rescans on demand; a successful
  claim refreshes the account by itself, no re-import needed.
- **Auto-claim**: set `ZCODE_AUTO_CLAIM=1` (off by default, like
  zcode-switch's toggle) and the page claims every detected plan as soon as
  it opens.
- **Common failure codes**: `1002` the event has ended, `1003` already
  claimed, `1004` not eligible, `1005` today's quota is used up, `3007`
  captcha check failed (just retry).
- **Limits**: the captcha needs a real browser, so fully unattended
  claiming is not possible; the page binds `127.0.0.1` only, so a claim
  started inside a Docker container cannot be opened from the host — run
  claims from the magpie / OpenCode on the host machine.

## Environments

### Windows / macOS (magpie desktop)

Add the plugin through any [install](#install) option; nothing else is
needed (magpie downloads the Bun runtime when it is first required).

### Linux

The magpie desktop app, or the magpie / OpenCode CLIs:

```sh
# OpenCode CLI (global npm install)
npm i -g opencode-ai

# wire the plugin into a project
cd /path/to/your-project
cat > opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["magpie-zcode-switch-auth"]
}
EOF

opencode auth login    # pick ZCode, then a sign-in / import method
```

Headless machines keep the same default locations (`~/.zcode-switch/accounts`
and the host's auth store); confirm they exist with `ls`.

### Docker

Running the OpenCode CLI in a container with a persistent volume:

```sh
docker run -it --rm \
  -v zcode-data:/root \
  -e ZSW_PASSWORD='your password' \
  node:22 bash
```

Inside the container:

```sh
npm i -g opencode-ai
mkdir -p /work && cd /work
cat > opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["magpie-zcode-switch-auth"]
}
EOF
opencode auth login    # pick a ZCode sign-in / import method
```

Notes:

- `-v zcode-data:/root` keeps `/root` (including `~/.zcode-switch` and
  OpenCode's auth store) in a named volume, so accounts survive rebuilding
  the container; a bind-mounted host directory works too.
- Put a `.zsb` backup inside the mounted directory and give its in-container
  path at method 8 (e.g. `/root/accounts.zsb`); pass the password with
  `-e ZSW_PASSWORD=…` to keep it out of shell history.
- A container has no local ZCode client, so method 4 (follow ZCode) is not
  available; methods 1–3 need a browser for the authorize page, so for
  fully headless imports prefer methods 5–8.

## Environment variables

| Variable | Purpose |
|---|---|
| `ZCODE_SWITCH_HOME` | Points at the directory holding zcode-switch's data when it is not in the default home (the plugin reads `$ZCODE_SWITCH_HOME/.zcode-switch/accounts`) |
| `ZCODE_CREDENTIAL_SECRET` | Overrides the seed ZCode's `enc:v1:` credentials are opened with; points back at the original machine's seed for accounts saved under another machine or username |
| `ZSW_PASSWORD` | A fallback source for method 8's password (read when the password prompt is left empty on the CLI) |
| `ZCODE_AUTO_CLAIM` | When set to `1`, the claim page claims every detected plan by itself as soon as it opens (off by default) |

## Import details

### Credential priority

Credentials are resolved in this order:

1. **The account's coding-plan key from its `config`**
   (`builtin:zai-coding-plan` / `builtin:bigmodel-coding-plan`, and ZCode
   3.15+'s `account:…-individual-coding-plan`)
2. **A coding-plan key minted from the account's OAuth access token** —
   like the official sign-in, through `zcode-api-key` (created when the
   default project has none); with no personal plan, a team seat is tried
3. **The Start Plan JWT** — `zcodejwttoken` (or the `config`'s
   `builtin:*-start-plan`), sent with the account's own `virtual_device_mid`

If neither 1 nor 2 works and the JWT has expired, the account is skipped
with a reason; it is never imported silently.

- **A timeout reading the plan aborts the request and skips the account**,
  asking you to check the network and retry; it never quietly falls back to
  the Start Plan.
- Other failures (an account that genuinely has no personal plan) still
  fall back to a usable JWT, marked "temporarily on the Start Plan" in the
  log/toast.
- A user's **personal plan and team seat are saved apart**: the team account
  shows as `<account> (team)` with its own uid and slot, and neither
  overwrites the other.

> An import saves a **snapshot**: after switching accounts or renewing in
> zcode-switch / ZCode, import again. To always follow the local ZCode's
> current sign-in, use method 4 (`ZCode app's sign-in`).

### How multiple accounts are kept in magpie

- The account this sign-in returns is kept by magpie itself (usually `zcode`
  or one `zcode#…` slot).
- The rest are saved through `client.auth.set` under `zcode#<stable slot>`;
  the slot is the first 8 hex digits of the account uid's SHA-256, so
  **importing again overwrites its own slot** instead of piling up entries.
- Several files of one login import once; team seats survive as separate
  accounts because their uid carries `org/project`.
- OpenCode's `auth.set` has no multi-account slot notion, so a bulk import
  under OpenCode saves one account and asks you to import the rest one by
  one.

### Device id

- An account with `virtual_device_mid` uses it as is (the Start Plan sees
  the same device zcode-switch does).
- Without one, a stable UUID is derived from the account's uid (the same
  account keeps the same id across imports).
- A `.zsb` export carries no `virtual_device_mid`, so imports from a `.zsb`
  get the stable derived id.

### Encrypted credentials (`enc:v1:`)

Accounts zcode-switch preserved from ZCode's local `credentials.json` may
hold ZCode's encrypted form:

```text
enc:v1:<nonce>.<tag>.<ciphertext>
```

The key is derived exactly as ZCode / zcode-switch derive it:

```text
SHA-256("zcode-credential-fallback:<platform>:<home>:<username>")
```

The environment variable `ZCODE_CREDENTIAL_SECRET` overrides it. Unset, the
plugin tries the **machine home** (what ZCode actually encrypts with) and
then the home `ZCODE_SWITCH_HOME` points at, so a moved library still opens;
an account saved under another machine's or user's name will not open, and
the plugin says to export a `.zsb` (with a password) on the original machine
and import that.

## How it works

- The plugin is a provider (id `zcode`) in magpie / OpenCode: `config`
  declares the model table, `auth.methods` offers the 9 sign-in methods, and
  `auth.loader` takes over routing and authentication for model requests.
- Every outbound request goes through a host whitelist: only `zcode.z.ai`,
  `api.z.ai`, `bigmodel.cn` and `open.bigmodel.cn` are allowed.
- Start Plan requests go out shaped exactly like the ZCode client's (headers
  and system prompt unchanged); the gift models are exposed to the picker
  with a `-Trial` suffix.

## Security

- **Official hosts only**: `zcode.z.ai`, `api.z.ai`, `bigmodel.cn`,
  `open.bigmodel.cn`.
  - Every internal JSON request is checked against the host whitelist;
  - a saved `base` is corrected back to an official host, so a hand-edited
    `plugin-auth.json` cannot point an account's key elsewhere.
- **No credentials in logs**: import logs carry account display names,
  counts and failure reasons, never tokens.
- **Credentials are only written to magpie's `plugin-auth.json`** (magpie
  writes it 0600) — never to ZCode's credential store, and zcode-switch's
  account files are never modified.
- **Importing is explicit**: `~/.zcode-switch` or a given file is read only
  when you choose an import; while loading, the plugin reads only account
  names/emails for the dropdown, and touches the network for nothing.
- **No telemetry**: no third-party analytics, no remote storage.
- **Handling credentials**: the account files under `~/.zcode-switch`,
  `.zsb` bundles and every token are as good as the accounts themselves.
  Keep them on your machine and enter them only into this plugin's own
  sign-in prompts; never paste them into any public place (issues, chats,
  screenshots, file sharing).

## FAQ

**After importing, requests go to the Start Plan instead of the Coding Plan?**
The account's `config` carried no coding-plan key and minting one from its
access token failed (usually an expired access token or a network problem).
If it was a **timeout reading the plan**, the import skipped the account and
asked you to retry — it never silently degrades; check the network/proxy
before importing again. Other failures (an account with no personal plan at
all) fall back to the Start Plan and say so in the log; sign the account in
again in zcode-switch / ZCode and import again, or simply sign in through
one of the official methods.

**"The credentials won't open on this machine"?**
The account was saved on another machine (ZCode's `enc:v1:` derives its key
from the local user's details). Export a `.zsb` (with a password) on the
original machine and import that, or set the right
`ZCODE_CREDENTIAL_SECRET`.

**`.zsb` says "wrong password, or the bundle is damaged"?**
Passwords are case-sensitive; also check the file was not truncated. A
plain JSON backup takes an empty password.

**The account dropdown doesn't show a just-saved account?**
The dropdown is built when the plugin loads. Restart magpie, or use "import
all saved accounts", which rescans every time.

**401 / 403 / Start Plan 405?**
The ZCode sign-in has lapsed or the Start Plan has ended. Sign in again the
official way, or sign the account in again in zcode-switch and import.

**How do I write paths on Windows?**
A `.zsb` path can be pasted as `C:\Users\…\accounts.zsb`; quotes and `~/`
are both fine.

**Claiming fails / the captcha check fails?**
`3007` means the captcha ticket expired or was rejected — retry once;
`1002`/`1005` mean the event ended or today's quota is used up; `1003`
means the plan was already claimed. If the claim page does not open, check
that magpie can reach `127.0.0.1` (claims started inside a Docker container
must be run on the host instead).

**Can I import inside Docker / a container?**
Yes, with methods 5–8 (API key or a backup import). Method 4 needs a local
ZCode client and is not available in a container; methods 1–3 need a browser
for the authorize page, so prefer 5–8 for headless imports.

## Development

```sh
npm test          # node:test unit tests and sign-in callback tests
npm run check     # loads the plugin the way magpie / OpenCode do and checks hook shapes
```

Layout:

```text
src/index.mjs     # plugin entry (the official zcode plugin + zcode-switch imports)
src/zswitch.mjs   # account library, enc:v1 and .zsb decryption, state
src/claim.mjs     # gift-plan claiming: preview/claim endpoints, local captcha page
src/prompt.mjs    # the Start Plan system prompt (as the official plugin has it)
test/             # unit tests and sign-in callback tests
scripts/check.mjs # plugin shape check
```

Sandbox check (no real account involved):

```sh
sb=$(mktemp -d)
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 magpie plugin add ./
# the next line reuses the same environment:
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 magpie plugin login zcode 6
```

## Acknowledgments

- [magpie-community/plugins](https://github.com/magpie-community/plugins) —
  `@magpie-community/opencode-zcode-auth`, the base of this plugin (MIT)
- [Saktawdi/zcode-switch](https://github.com/Saktawdi/zcode-switch) — the
  account library, ZCode credential preservation and the `.zsb` format (MIT)
- [yetone/magpie](https://github.com/yetone/magpie) — the plugin host

## License

[MIT](LICENSE)
