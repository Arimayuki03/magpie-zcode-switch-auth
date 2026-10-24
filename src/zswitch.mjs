// zcode-switch's account library (Z·SWITCH), read for magpie.
//
// zcode-switch keeps every saved login under ~/.zcode-switch/accounts as an
// Account JSON:
//
//   {
//     "id": "<uuid>", "name": "…", "created_at": "…", "updated_at": "…",
//     "hash": "…",
//     "credentials": {
//       "zcodejwttoken": "…",                  // ZCode's session token (Start Plan)
//       "oauth:active_provider": "zai",        // or "bigmodel"
//       "oauth:zai:access_token": "…",         // the site's OAuth access token
//       "oauth:zai:user_info": "{…}"           // profile JSON, as a string
//     },
//     "config": { "provider": { … } },         // ZCode's config.json snapshot
//     "virtual_device_mid": "<uuid>",          // the account's own device id
//     "virtual_arms_uid": "…"
//   }
//
// A credential value is either plain or ZCode's encrypted form,
// "enc:v1:<nonce>.<tag>.<ciphertext>" (AES-256-GCM, base64url), whose key is
// SHA-256 of a secret made from the platform, the home folder and the user
// name — the same rule ZCode and zcode-switch use.
//
// zcode-switch also exports .zsb bundles: the JSON above sealed with
// PBKDF2-HMAC-SHA256 (100 000 rounds) + AES-256-GCM, as
//
//   { "format": "zsw-accounts-bundle", "version": 1,
//     "kdf": { "algo": "pbkdf2-hmac-sha256", "iters": 100000, "salt": "…" },
//     "cipher": { "algo": "aes-256-gcm", "nonce": "…", "tag": "…", "data": "…" } }
//
// and inside it the plaintext bundle:
//
//   { "format": "zcode-accounts-bundle", "version": 2, "exportedAt": "…",
//     "accounts": [ { "name": "…", "createdAt": "…", "credentials": {…}, "config": {…} } ] }

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join, resolve } from "node:path"

export const ZSW_FORMAT = "zsw-accounts-bundle"
export const ZSW_PAYLOAD_FORMAT = "zcode-accounts-bundle"
export const ENC_PREFIX = "enc:v1:"

const SITES = {
  zai: { name: "Z.ai", base: "https://api.z.ai/api/anthropic" },
  bigmodel: { name: "BigModel", base: "https://open.bigmodel.cn/api/anthropic" },
}

// the coding-plan entries zcode-switch writes into ZCode's config.json (and
// the newer account-shaped ids ZCode 3.15+ uses)
const CONFIG_KEYS = {
  zai: ["builtin:zai-coding-plan", "account:zai-individual-coding-plan"],
  bigmodel: ["builtin:bigmodel-coding-plan", "account:bigmodel-individual-coding-plan"],
}
const CONFIG_START = { zai: "builtin:zai-start-plan", bigmodel: "builtin:bigmodel-start-plan" }

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024

const first = (...ss) => ss.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? ""

// nameOf is a profile's name, ignoring the placeholders an empty profile
// comes with ("None", "null"...), so the email can name the account.
const nameOf = (v) => {
  const s = String(v ?? "").trim()
  return /^(none|null|undefined|n\/a|nil)$/i.test(s) ? "" : s
}

export function switchHome(env = process.env, home = homedir()) {
  const set = typeof env?.ZCODE_SWITCH_HOME === "string" ? env.ZCODE_SWITCH_HOME.trim() : ""
  return set ? resolve(set) : home
}

export function switchAccountsDir({ env = process.env, home = homedir() } = {}) {
  return join(switchHome(env, home), ".zcode-switch", "accounts")
}

// credSecret is ZCode's credential key seed, exactly as zcode-switch builds
// it (internal zcrypto::default_secret): ZCODE_CREDENTIAL_SECRET when set,
// else "zcode-credential-fallback:<platform>:<home>:<user>", SHA-256'd.
export function credSecret({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (typeof env?.ZCODE_CREDENTIAL_SECRET === "string" && env.ZCODE_CREDENTIAL_SECRET.length) {
    return createHash("sha256").update(env.ZCODE_CREDENTIAL_SECRET).digest()
  }
  let name = ""
  try {
    name = userInfo().username || ""
  } catch {}
  name = name.slice(name.lastIndexOf("\\") + 1) // DOMAIN\user
  if (platform === "win32") name = first(env?.USERNAME, env?.USER, env?.LOGNAME, name, "unknown")
  else name = first(name, env?.USER, env?.LOGNAME, "unknown")
  return createHash("sha256").update(`zcode-credential-fallback:${platform}:${home}:${name}`).digest()
}

// credKeys are the seeds to try for an account's enc:v1 values. ZCode
// encrypts its own credentials with the machine home; zcode-switch uses its
// own home, which ZCODE_SWITCH_HOME may move. Trying both means a moved
// library and a normal one both open; an explicit ZCODE_CREDENTIAL_SECRET
// is the only seed, as zcode-switch treats it.
export function credKeys({ env = process.env, platform = process.platform, home = homedir(), machineHome = homedir() } = {}) {
  if (typeof env?.ZCODE_CREDENTIAL_SECRET === "string" && env.ZCODE_CREDENTIAL_SECRET.length) {
    return [credSecret({ env, platform, home: machineHome })]
  }
  const keys = []
  const add = (h) => {
    const k = credSecret({ env, platform, home: h })
    if (!keys.some((x) => x.equals(k))) keys.push(k)
  }
  add(machineHome)
  add(switchHome(env, home))
  return keys
}

// decryptValue opens ZCode's "enc:v1:<nonce>.<tag>.<data>" with key (32
// bytes); null when it isn't that form or doesn't open.
export function decryptValue(value, key) {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return null
  const parts = value.slice(ENC_PREFIX.length).split(".")
  if (parts.length !== 3) return null
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p.replace(/=+$/, ""), "base64url"))
    if (iv.length !== 12) return null
    const d = createDecipheriv("aes-256-gcm", key, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString("utf8")
  } catch {
    return null
  }
}

// sealTestBundle is exported for tests only: it makes the envelope
// zcode-switch's cipher::seal makes, so a round trip can be checked without
// native code. It is never used by the plugin.
export function sealTestBundle(payload, password) {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256")
  const c = createCipheriv("aes-256-gcm", key, nonce)
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()])
  const tag = c.getAuthTag()
  return {
    format: ZSW_FORMAT,
    version: 1,
    kdf: { algo: "pbkdf2-hmac-sha256", iters: 100_000, salt: salt.toString("base64") },
    cipher: {
      algo: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      tag: tag.toString("base64"),
      data: ct.toString("base64"),
    },
  }
}

function b64(v) {
  return Buffer.from(String(v ?? ""), "base64")
}

function openSealed(envelope, password) {
  if (typeof password !== "string" || !password.length) {
    throw new Error("备份有口令，请填写 zcode-switch 的导出密码")
  }
  const kdf = envelope.kdf
  const c = envelope.cipher
  if (!kdf || !c) throw new Error("这不是 zcode-switch 的加密备份")
  const algo = String(kdf.algo ?? "pbkdf2-hmac-sha256").toLowerCase()
  if (algo !== "pbkdf2-hmac-sha256") throw new Error(`不支持的密钥派生算法：${algo}`)
  const iters = Number(kdf.iters) || 100_000
  if (!Number.isFinite(iters) || iters < 1_000 || iters > 10_000_000) throw new Error("备份的密钥派生参数异常")
  const salt = b64(kdf.salt)
  const nonce = b64(c.nonce)
  const tag = b64(c.tag)
  const data = b64(c.data)
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("备份的加密参数异常")
  const key = pbkdf2Sync(password, salt, iters, 32, "sha256")
  let plain
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce)
    d.setAuthTag(tag)
    plain = Buffer.concat([d.update(data), d.final()])
  } catch {
    throw new Error("口令错误，或备份文件已损坏")
  }
  try {
    return JSON.parse(plain.toString("utf8"))
  } catch {
    throw new Error("备份解开后不是 JSON")
  }
}

// openBundleText parses a .zsb (sealed) or a plain zcode-switch export and
// returns the payload inside. A single account file or a bare credentials
// object is accepted too, so an account copied out of the store imports the
// same way.
export function openBundleText(text, password = "") {
  let v
  try {
    v = JSON.parse(String(text ?? "").replace(/^\uFEFF/, ""))
  } catch {
    throw new Error("文件不是 JSON")
  }
  if (v && typeof v === "object" && v.kdf && v.cipher) {
    if (v.format && v.format !== ZSW_FORMAT) throw new Error(`不认识的备份格式：${v.format}`)
    return openSealed(v, password)
  }
  return v
}

export function readBundleFile(path, password = "") {
  let p = String(path ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
  if (!p) throw new Error("请填写备份文件路径")
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = join(homedir(), p.slice(1).replace(/^[\\/]+/, ""))
  }
  let st
  try {
    st = statSync(p)
  } catch {
    throw new Error(`找不到文件：${p}`)
  }
  if (!st.isFile()) throw new Error(`不是文件：${p}`)
  if (st.size > MAX_BUNDLE_BYTES) throw new Error("备份文件过大（上限 16 MiB）")
  let text
  try {
    text = readFileSync(p, "utf8")
  } catch (e) {
    throw new Error(`读不了文件：${e?.message ?? e}`)
  }
  return openBundleText(text, password)
}

// accountsFromPayload turns a payload into account objects: a
// zcode-accounts-bundle, an array of accounts, one account file, or a bare
// credentials object.
export function accountsFromPayload(payload) {
  const out = []
  const push = (item, fallbackName) => {
    if (!item || typeof item !== "object") return
    let itemCreds = item.credentials && typeof item.credentials === "object" ? item.credentials : null
    if (!itemCreds && (item.zcodejwttoken || Object.keys(item).some((k) => k.startsWith("oauth:")))) itemCreds = item
    if (!itemCreds) return
    const creds = Object.fromEntries(Object.entries(itemCreds).filter(([, v]) => typeof v === "string" && v.trim()))
    if (!Object.keys(creds).length) return
    out.push(
      normalizeAccount({
        id: first(item.id, item.accountId, item.uuid),
        name: first(item.name, fallbackName),
        createdAt: first(item.createdAt, item.created_at),
        credentials: creds,
        config: item.config && typeof item.config === "object" ? item.config : null,
        virtualDeviceMid: first(item.virtual_device_mid, item.virtualDeviceMid),
        virtualArmsUid: first(item.virtual_arms_uid, item.virtualArmsUid),
        source: "bundle",
      }),
    )
  }
  if (Array.isArray(payload)) {
    for (const item of payload) push(item)
  } else if (payload && typeof payload === "object") {
    if (Array.isArray(payload.accounts)) {
      for (const item of payload.accounts) push(item, first(payload.name))
    } else if (payload.credentials || payload.zcodejwttoken || Object.keys(payload).some((k) => k.startsWith("oauth:"))) {
      push(payload)
    }
  }
  return out
}

// readSwitchAccounts reads ~/.zcode-switch/accounts. A file that can't be
// read is reported, not fatal: one bad account doesn't hide the others.
export function readSwitchAccounts(opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const dir = switchAccountsDir({ env, home })
  const errors = []
  const accounts = []
  if (!existsSync(dir)) return { dir, accounts, errors }
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".json")).sort()
  } catch (e) {
    errors.push(`${dir}: ${e?.message ?? e}`)
    return { dir, accounts, errors }
  }
  for (const name of names) {
    const file = join(dir, name)
    let raw
    try {
      raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
    } catch (e) {
      errors.push(`${name}: ${e?.message ?? e}`)
      continue
    }
    if (!raw || typeof raw !== "object" || !raw.credentials || typeof raw.credentials !== "object") {
      errors.push(`${name}: 没有 credentials`)
      continue
    }
    try {
      accounts.push(
        normalizeAccount({
          id: first(raw.id, name.replace(/\.json$/i, "")),
          name: first(raw.name),
          createdAt: first(raw.created_at),
          credentials: Object.fromEntries(
            Object.entries(raw.credentials).filter(([, v]) => typeof v === "string" && v.trim()),
          ),
          config: raw.config && typeof raw.config === "object" ? raw.config : null,
          virtualDeviceMid: first(raw.virtual_device_mid),
          virtualArmsUid: first(raw.virtual_arms_uid),
          file,
          source: "store",
        }),
      )
    } catch (e) {
      errors.push(`${name}: ${e?.message ?? e}`)
    }
  }
  accounts.sort(
    (a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || (a.name || "").localeCompare(b.name || ""),
  )
  return { dir, accounts, errors }
}

function normalizeAccount(a) {
  return {
    switchId: first(a.id),
    name: first(a.name),
    createdAt: first(a.createdAt),
    credentials: a.credentials ?? {},
    config: a.config ?? null,
    virtualDeviceMid: first(a.virtualDeviceMid),
    virtualArmsUid: first(a.virtualArmsUid),
    file: first(a.file),
    source: a.source ?? "store",
  }
}

// plain reads one credential value, opening ZCode's encrypted form with any
// of the candidate keys.
function plain(value, keyOrKeys) {
  if (typeof value !== "string") return ""
  const v = value.trim()
  if (!v) return ""
  if (v.startsWith(ENC_PREFIX)) {
    for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
      const out = decryptValue(v, key)
      if (out !== null) return out
    }
    return ""
  }
  return v
}

function siteOf(creds, key) {
  const active = plain(creds["oauth:active_provider"], key).toLowerCase()
  if (active === "zai" || active === "bigmodel") return active
  for (const site of ["zai", "bigmodel"]) {
    if (plain(creds[`oauth:${site}:access_token`], key)) return site
  }
  return "zai"
}

function parseUserInfo(raw) {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

function configKeyFor(config, site, key) {
  const providers = config?.provider
  if (!providers || typeof providers !== "object") return ""
  for (const id of CONFIG_KEYS[site] ?? []) {
    let v = providers[id]?.options?.apiKey
    if (typeof v !== "string") continue
    v = v.trim()
    if (v.startsWith(ENC_PREFIX)) v = plain(v, key)
    // a coding-plan key is "<id>.<secret>"; a JWT has two dots and is not one
    if (v.split(".").length === 2 && !/[\s{$]/.test(v) && v.length < 512) return v
  }
  return ""
}

function configJwtFor(config, site, key) {
  const id = CONFIG_START[site]
  if (!id) return ""
  let v = config?.provider?.[id]?.options?.apiKey
  if (typeof v !== "string") return ""
  v = v.trim()
  if (v.startsWith(ENC_PREFIX)) v = plain(v, key)
  return v && !/\s/.test(v) ? v : ""
}

function jwtPayload(jwt) {
  const p = String(jwt ?? "").replace(/^Bearer\s+/i, "").split(".")
  if (p.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(p[1], "base64url").toString("utf8"))
  } catch {
    return null
  }
}

export function jwtExpiry(jwt) {
  const claims = jwtPayload(jwt)
  const exp = Number(claims?.exp)
  return exp > 0 ? exp * 1000 : 0
}

// jwtSubject is ZCode's user id in the session token, for an account with no
// user_info to name it.
const jwtSubject = (jwt) => {
  const claims = jwtPayload(jwt)
  return first(String(claims?.user_id ?? ""), String(claims?.sub ?? ""))
}

export const jwtExpired = (jwt) => {
  const t = jwtExpiry(jwt)
  return t > 0 && Date.now() > t
}

// stableDevice is a UUID-shaped device id for an account that has none: the
// same account keeps the same id across imports, so ZCode's Start Plan sees
// one device rather than a new one every time.
export function stableDevice(seed) {
  const h = createHash("sha256").update(`zcode-switch-device:${seed}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const usableDevice = (v) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : "")

// accountUid is what tells two accounts apart in magpie's store. A user id
// is the same in the store and in a .zsb export; failing that, the
// credentials themselves are, so the same login from either source keeps one
// uid. Team seats are told apart later, in switchStateFor, by their plan.
function accountUid(a, info, site) {
  const own = first(String(info?.id ?? ""), String(info?.user_id ?? ""))
  if (own) return `${site}:${own}`
  const creds = a.credentials ?? {}
  const canonical = Object.keys(creds)
    .sort()
    .map((k) => `${k}\0${creds[k]}`)
    .join("\n")
  if (canonical) {
    const fp = createHash("sha256").update(canonical).digest("hex").slice(0, 16)
    return `${site}:cred:${fp}`
  }
  const fallback = first(a.switchId, a.name, a.virtualDeviceMid, a.virtualArmsUid)
  return `${site}:switch:${createHash("sha256").update(fallback).digest("hex").slice(0, 16)}`
}

// describeAccount decrypts what an import needs and names it. It never
// throws for a bad account; `error` says why it can't be used.
export function describeAccount(account, opts = {}) {
  const env = opts.env ?? process.env
  const machineHome = opts.machineHome ?? homedir()
  const keys =
    opts.keys ??
    (opts.key ? [opts.key] : credKeys({ env, platform: opts.platform, home: opts.home ?? machineHome, machineHome }))
  const creds = account.credentials ?? {}
  const site = siteOf(creds, keys)
  const jwt = first(plain(creds.zcodejwttoken, keys), configJwtFor(account.config, site, keys)).replace(/^Bearer\s+/i, "")
  const access = plain(creds[`oauth:${site}:access_token`], keys)
  const refresh = plain(creds[`oauth:${site}:refresh_token`], keys)
  const info =
    parseUserInfo(plain(creds[`oauth:${site}:user_info`], keys)) ??
    parseUserInfo(plain(creds["oauth:zai:user_info"], keys)) ??
    parseUserInfo(plain(creds["oauth:bigmodel:user_info"], keys))
  const subject = jwtSubject(jwt)
  const uidInfo =
    subject && !first(String(info?.id ?? ""), String(info?.user_id ?? ""))
      ? { ...(info ?? {}), id: subject }
      : info
  const email = first(String(info?.email ?? ""), String(info?.rawProfile?.email ?? ""))
  const displayName = first(
    nameOf(info?.displayName),
    nameOf(info?.username),
    nameOf(info?.name),
    email,
    nameOf(account.name),
    String(account.switchId ?? "").slice(0, 8),
  )
  const uid = accountUid(account, uidInfo, site)
  const configKey = configKeyFor(account.config, site, keys)
  const device = usableDevice(account.virtualDeviceMid) || stableDevice(uid)
  const label = [displayName, email && email !== displayName ? email : "", SITES[site].name]
    .filter(Boolean)
    .join(" · ")
  // some credential is ZCode's encrypted form and none of the candidate
  // seeds opened anything: this account was saved under another machine's
  // user key
  const anyEncrypted = Object.values(creds).some((v) => typeof v === "string" && v.startsWith(ENC_PREFIX))
  const locked = anyEncrypted && !jwt && !access && !configKey
  return {
    raw: account,
    switchId: account.switchId,
    name: account.name,
    site,
    siteName: SITES[site].name,
    base: SITES[site].base,
    email,
    displayName,
    label,
    uid,
    device,
    jwt,
    access,
    refresh,
    key: configKey,
    file: account.file,
    source: account.source,
    error: locked ? "凭据在这台机器上解不开（由另一台机器的用户密钥加密），可在原机器导出 .zsb 再导入" : "",
  }
}

// switchStateFor turns a described account into the state the rest of this
// plugin takes: the coding-plan key, the Start Plan's JWT, the account's
// device id, and where the plan lives. `resolve` (signedIn in index.mjs)
// mints the coding-plan key from the account's OAuth access token when the
// account's own config doesn't carry one; without it, or when it fails, a
// JWT still gives the Start Plan.
export async function switchStateFor(desc, { resolve, timeout = 20_000 } = {}) {
  if (desc.error) return { error: desc.error, label: desc.label }
  const warnings = []
  let key = desc.key
  let base = desc.base
  let plan = ""
  let team = {}
  let timedOut = false
  if (!key && desc.access && typeof resolve === "function") {
    let timer
    const ac = new AbortController()
    try {
      const r = await Promise.race([
        Promise.resolve().then(() =>
          resolve({ site: desc.site, token: desc.access, jwt: desc.jwt, device: desc.device, signal: ac.signal }),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            ac.abort()
            reject(new Error(`读取套餐超时（${Math.round(timeout / 1000)} 秒）`))
          }, timeout)
        }),
      ])
      if (r && typeof r === "object") {
        key = first(String(r.key ?? ""))
        base = first(String(r.base ?? ""), base)
        plan = first(String(r.plan ?? ""))
        if (r.org && r.project) team = { org: r.org, project: r.project, token: first(String(r.token ?? "")) }
      }
    } catch (e) {
      if (timedOut) {
        return {
          error: `读取套餐超时（${Math.round(timeout / 1000)} 秒），账号未导入；请检查网络后重试`,
          label: desc.label,
          warnings,
        }
      }
      warnings.push(e?.message ?? String(e))
    } finally {
      clearTimeout(timer)
    }
  }
  let jwt = desc.jwt
  if (!key && !jwt) {
    const why = warnings.length ? `（${warnings.join("；")}）` : ""
    return { error: `账号没有 coding-plan API Key，也没有可用的 ZCode JWT${why}`, label: desc.label, warnings }
  }
  if (!key && jwtExpired(jwt)) {
    return {
      error: "ZCode 登录（Start Plan JWT）已过期；请在 zcode-switch 或 ZCode 里重新登录并保存账号",
      label: desc.label,
      warnings,
    }
  }
  if (!base) base = desc.base
  const state = {
    source: "zcode-switch",
    switchId: desc.switchId,
    switchName: desc.name,
    site: desc.site,
    device: desc.device,
    base,
    key,
    jwt,
    ...team,
  }
  if (plan) state.plan = plan
  let uid = desc.uid
  let accountId = desc.displayName || desc.email || "ZCode"
  if (team.org && team.project) {
    // a team seat is an account of its own beside the account's own plan,
    // as the official plugin keeps it; keep both magpie entries
    uid = `${uid}:team:${team.org}:${team.project}`
    if (!/\(team\)$/i.test(accountId)) accountId = `${accountId} (team)`
  }
  return {
    state,
    label: desc.label,
    accountId,
    uid,
    expires: key ? 0 : jwtExpiry(jwt),
    warnings,
  }
}

// slotFor is the zcode#<slot> an extra imported account is kept under in
// magpie's plugin-auth.json. It is stable, so importing the same account
// again writes over its own entry rather than piling up entries.
export function slotFor(uid) {
  return `zcode#${createHash("sha256").update(`zcode-switch:${uid}`).digest("hex").slice(0, 8)}`
}

export const _internal = {
  SITES,
  CONFIG_KEYS,
  CONFIG_START,
  b64,
  openSealed,
  parseUserInfo,
  configKeyFor,
  configJwtFor,
  accountUid,
}
