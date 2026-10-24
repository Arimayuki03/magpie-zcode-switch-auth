import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describeAccount, readSwitchAccounts, sealTestBundle, switchStateFor } from "../src/zswitch.mjs"

const HOME = mkdtempSync(join(tmpdir(), "zsw-plugin-test-"))
const ACCOUNTS = join(HOME, ".zcode-switch", "accounts")
mkdirSync(ACCOUNTS, { recursive: true })
process.env.ZCODE_SWITCH_HOME = HOME
process.env.ZCODE_CREDENTIAL_SECRET = "test-secret"

const { ZCodeAuthPlugin, _internal } = await import("../src/index.mjs")

test.after(() => {
  rmSync(HOME, { recursive: true, force: true })
  delete process.env.ZCODE_SWITCH_HOME
  delete process.env.ZCODE_CREDENTIAL_SECRET
})

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (claims = { sub: "user" }) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`

function writeAccount(file, value) {
  writeFileSync(join(ACCOUNTS, file), JSON.stringify(value, null, 2))
}

function account({ id, name, jwtToken = jwt(), access = "access", user = {}, configKey = "", device = "" }) {
  const creds = {
    zcodejwttoken: jwtToken,
    "oauth:active_provider": "zai",
    "oauth:zai:user_info": JSON.stringify({ id, displayName: name, email: `${id}@example.test`, ...user }),
  }
  if (access) creds["oauth:zai:access_token"] = access
  return {
    id,
    name,
    created_at: "2026-09-30 05:00",
    updated_at: "2026-09-30 05:00",
    hash: "x",
    credentials: creds,
    config: configKey
      ? { provider: { "builtin:zai-coding-plan": { options: { apiKey: configKey } } } }
      : null,
    virtual_device_mid: device,
    virtual_arms_uid: null,
  }
}

writeAccount(
  "ada.json",
  account({ id: "ada", name: "Ada", configKey: "keya.secret", device: "11111111-2222-4333-8444-555555555555" }),
)
// a coding-plan key and no JWT: it exercises the coding-plan route without
// asking any vendor
writeAccount("bob.json", account({ id: "bob", name: "Bob", jwtToken: "", access: "", configKey: "keyb.secret" }))
const past = jwt({ sub: "old", exp: Math.floor(Date.now() / 1000) - 60 })
writeAccount("old.json", account({ id: "old", name: "Old", jwtToken: past, access: "", user: {} }))
writeFileSync(join(ACCOUNTS, "broken.json"), "{not json")

function makeClient() {
  const calls = { set: [], log: [], toast: [] }
  return {
    calls,
    client: {
      app: { log: async ({ body }) => calls.log.push(body) },
      auth: { set: async (args) => (calls.set.push(args), { data: true }) },
      tui: { showToast: async (o) => calls.toast.push(o.body) },
    },
  }
}

const method = (hooks, part) => hooks.auth.methods.find((m) => m.label.includes(part))

// an import is an oauth method like any other: authorize gives a session,
// and its callback does the reading and saving
async function runImport(m, inputs) {
  const a = await m.authorize(inputs)
  assert.equal(a.url, "")
  assert.equal(a.method, "auto")
  assert.equal(typeof a.callback, "function")
  return a.callback()
}

test("the plugin declares the ZCode provider and every sign-in method", async () => {
  const { client } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  assert.equal(hooks.auth.provider, "zcode")
  assert.equal(typeof hooks.auth.loader, "function")
  const labels = hooks.auth.methods.map((m) => m.label)
  for (const part of [
    "ZCode: Z.ai GLM Coding Plan",
    "ZCode: BigModel (智谱) GLM Coding Plan",
    "ZCode app's sign-in",
    "GLM Coding Plan API key",
    "zcode-switch: 导入一个已保存账号",
    "zcode-switch: 导入全部已保存账号",
    "zcode-switch: 导入 .zsb / JSON 备份",
  ]) {
    assert.ok(labels.some((l) => l.includes(part)), `missing ${part}`)
  }
  const one = method(hooks, "导入一个")
  const values = one.prompts[0].options.map((o) => o.value)
  assert.ok(values.includes("ada"))
  assert.ok(values.includes("bob"))
  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider.zcode.npm, "@ai-sdk/anthropic")
  assert.ok(cfg.provider.zcode.models["GLM-5.3"])
})

test("one saved account imports as a coding-plan sign-in", async () => {
  const { client, calls } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const res = await runImport(method(hooks, "导入一个"), { account: "ada" })
  assert.equal(res.type, "success")
  assert.equal(res.access, "keya.secret")
  assert.equal(res.expires, 0)
  assert.equal(res.accountId, "Ada")
  const state = JSON.parse(res.refresh)
  assert.equal(state.source, "zcode-switch")
  assert.equal(state.site, "zai")
  assert.equal(state.key, "keya.secret")
  assert.equal(state.device, "11111111-2222-4333-8444-555555555555")
  assert.equal(state.jwt, jwt())
  assert.ok(calls.log.some((l) => l.level === "info" && /已导入 1 个/.test(l.message)))
})

test("importing all saves the first for the flow and the rest under zcode#slot", async () => {
  const { client, calls } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const res = await runImport(method(hooks, "导入全部"))
  assert.equal(res.type, "success")
  assert.equal(res.access, "keya.secret") // the one with a key is preferred
  assert.equal(calls.set.length, 1)
  const [saved] = calls.set
  assert.match(saved.path.id, /^zcode#[0-9a-f]{8}$/)
  assert.equal(saved.body.type, "oauth")
  assert.equal(saved.body.access, "keyb.secret")
  assert.equal(JSON.parse(saved.body.refresh).source, "zcode-switch")
  assert.ok(calls.toast.length >= 1)
  assert.match(calls.toast[0].message, /已导入 2 个/)
  // skipped accounts are named, not silently filtered
  assert.ok(calls.log.some((l) => /broken\.json/.test(l.message)))
  assert.ok(calls.log.some((l) => /跳过/.test(l.message) && /过期/.test(l.message)))
  // no token or key reaches the log
  for (const m of calls.log.map((l) => l.message).concat(calls.toast.map((t) => t.message))) {
    assert.ok(!/keya\.secret|keyb\.secret/.test(m), "secrets must not be logged")
  }
  // a second import rewrites the same slot instead of piling up accounts
  await runImport(method(hooks, "导入全部"))
  assert.equal(calls.set.length, 2)
  assert.equal(calls.set[1].path.id, saved.path.id)
})

test("OpenCode gets one account, and is told the rest were not saved", async () => {
  const { client, calls } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "opencode" } })
  const res = await runImport(method(hooks, "导入全部"))
  assert.equal(res.type, "success")
  assert.equal(calls.set.length, 0)
  assert.ok(calls.log.some((l) => /OpenCode/.test(l.message)))
})

test("a .zsb bundle imports with its password, and refuses a wrong one", async () => {
  const payload = {
    format: "zcode-accounts-bundle",
    version: 2,
    accounts: [
      {
        name: "Bun",
        credentials: {
          zcodejwttoken: "",
          "oauth:active_provider": "zai",
          "oauth:zai:user_info": JSON.stringify({ id: "bun", displayName: "Bun" }),
        },
        config: { provider: { "builtin:zai-coding-plan": { options: { apiKey: "bun.secret" } } } },
      },
    ],
  }
  const file = join(HOME, "accounts.zsb")
  writeFileSync(file, JSON.stringify(sealTestBundle(payload, "hunter2")))
  const { client, calls } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const res = await runImport(method(hooks, ".zsb"), { path: `  "${file}"  `, password: "hunter2" })
  assert.equal(res.type, "success")
  assert.equal(res.access, "bun.secret")
  assert.equal(res.accountId, "Bun")
  for (const m of calls.log.map((l) => l.message).concat(calls.toast.map((t) => t.message))) {
    assert.ok(!m.includes("bun.secret") && !m.includes("hunter2"), "secrets must not be logged")
  }
  await assert.rejects(() => runImport(method(hooks, ".zsb"), { path: file, password: "nope" }), /口令错误/)
})

test("ZSW_PASSWORD is used when the password prompt is empty", async () => {
  const payload = {
    format: "zcode-accounts-bundle",
    accounts: [
      {
        name: "EnvPassword",
        credentials: { "oauth:active_provider": "zai", "oauth:zai:user_info": JSON.stringify({ id: "env-pw", displayName: "EnvPassword" }) },
        config: { provider: { "builtin:zai-coding-plan": { options: { apiKey: "envpw.secret" } } } },
      },
    ],
  }
  const home = mkdtempSync(join(tmpdir(), "zsw-env-pw-"))
  try {
    const file = join(home, "env.zsb")
    writeFileSync(file, JSON.stringify(sealTestBundle(payload, "from-env")))
    const { client } = makeClient()
    const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
    process.env.ZSW_PASSWORD = "from-env"
    const res = await runImport(method(hooks, ".zsb"), { path: file, password: "" })
    assert.equal(res.type, "success")
    assert.equal(res.access, "envpw.secret")
  } finally {
    delete process.env.ZSW_PASSWORD
    rmSync(home, { recursive: true, force: true })
  }
})

test("a pasted credentials JSON imports through the bundle method", async () => {
  const pasted = JSON.stringify({
    credentials: {
      "oauth:active_provider": "zai",
      "oauth:zai:user_info": JSON.stringify({ id: "pasted", displayName: "Pasted" }),
    },
    config: { provider: { "builtin:zai-coding-plan": { options: { apiKey: "pasted.secret" } } } },
  })
  const { client } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const res = await runImport(method(hooks, ".zsb"), { path: pasted, password: "" })
  assert.equal(res.type, "success")
  assert.equal(res.access, "pasted.secret")
  assert.equal(res.accountId, "Pasted")
})

test("a key-only import loads as a coding-plan provider and lists models without the vendor", async () => {
  const d = describeAccount(
    readSwitchAccounts({ env: process.env, home: HOME }).accounts.find((a) => a.switchId === "bob"),
    { env: process.env, home: HOME },
  )
  const r = await switchStateFor(d, {})
  const auth = { type: "oauth", refresh: JSON.stringify(r.state), access: r.state.key, expires: 0 }
  const { client } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  assert.equal(opts.baseURL, "https://api.z.ai/api/anthropic/v1")
  assert.equal(opts.apiKey, "keyb.secret")
  const models = await hooks.provider.models({ models: {} }, { auth })
  assert.ok(Object.keys(models).length > 0, "a model catalog is offered")
})

test("a hand-edited base is put back on the vendors' own host", async () => {
  const auth = {
    type: "oauth",
    access: "k.secret",
    refresh: JSON.stringify({ site: "zai", base: "https://evil.example/api", key: "k.secret", jwt: "" }),
    expires: 0,
  }
  const { client } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  assert.equal(opts.baseURL, "https://api.z.ai/api/anthropic/v1")
})

test("a bigmodel base is mapped to bigmodel's own host", async () => {
  const auth = {
    type: "oauth",
    access: "k.secret",
    refresh: JSON.stringify({ site: "bigmodel", base: "https://evil.example/api", key: "k.secret", jwt: "" }),
    expires: 0,
  }
  const { client } = makeClient()
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  assert.equal(opts.baseURL, "https://open.bigmodel.cn/api/anthropic/v1")
})

test("two saved files of one login are imported once", async () => {
  const home = mkdtempSync(join(tmpdir(), "zsw-dup-"))
  const dir = join(home, ".zcode-switch", "accounts")
  mkdirSync(dir, { recursive: true })
  const write = (file, id) => {
    const a = account({ id, name: id, configKey: `${id}.secret`, user: { id: "same-user", displayName: "Same" } })
    writeFileSync(join(dir, file), JSON.stringify(a, null, 2))
  }
  write("dup1.json", "dup1")
  write("dup2.json", "dup2")
  const old = process.env.ZCODE_SWITCH_HOME
  process.env.ZCODE_SWITCH_HOME = home
  try {
    const { client, calls } = makeClient()
    const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
    const res = await runImport(method(hooks, "导入全部"))
    assert.equal(res.type, "success")
    assert.equal(calls.set.length, 0) // no extra account: the second is a duplicate
    assert.ok(calls.log.some((l) => /重复/.test(l.message)))
    assert.match(calls.toast[0].message, /已导入 1 个/)
  } finally {
    if (old === undefined) delete process.env.ZCODE_SWITCH_HOME
    else process.env.ZCODE_SWITCH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test("ZCode's browser sign-in still runs its callback and returns the coding-plan key", async () => {
  const real = globalThis.fetch
  const seen = []
  const reply = (obj) =>
    new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })
  const flow = {
    flow_id: "flow-1",
    authorize_url: "https://zcode.z.ai/console/signin?state=state-1&x=1",
    expires_at: Math.floor(Date.now() / 1000) + 300,
    poll_interval_sec: 1,
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url
    seen.push({ url, method: init.method ?? "GET" })
    if (url.endsWith("/api/v1/oauth/cli/init")) return reply({ code: 0, data: flow })
    if (url.includes("/api/v1/oauth/cli/poll/")) {
      return reply({
        code: 0,
        data: {
          status: "ready",
          token: "jwt-start",
          zai: { access_token: "zai-access" },
          user: { email: "login@example.test", name: "Login" },
        },
      })
    }
    if (url.endsWith("/api/auth/z/login")) return reply({ code: 0, data: { access_token: "biz-token" } })
    if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
      return reply({
        code: 0,
        data: {
          organizations: [
            {
              organizationId: "org-1",
              organizationName: "默认机构",
              projects: [{ projectId: "proj-1", projectName: "默认项目", projectType: 1 }],
            },
          ],
        },
      })
    }
    if (url.endsWith("/projects/proj-1/api_keys")) {
      return reply({ code: 0, data: [{ name: "zcode-api-key", apiKey: "KEYID" }] })
    }
    if (url.includes("/api_keys/copy/KEYID")) return reply({ code: 0, data: { secretKey: "SECRET" } })
    if (url.endsWith("/api/biz/subscription/list")) {
      return reply({ code: 0, data: [{ status: "VALID", productName: "GLM Coding Pro" }] })
    }
    throw new Error(`unexpected request ${url}`)
  }
  try {
    const { client } = makeClient()
    const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
    const auth = await method(hooks, "Z.ai GLM Coding Plan").authorize()
    assert.equal(auth.method, "auto")
    const url = new URL(auth.url)
    assert.match(url.searchParams.get("redirect_uri"), /redirect=zcode%3A%2F%2Foauth%2Fcallback/)
    assert.equal(url.searchParams.get("state"), "state-1")
    const res = await auth.callback()
    assert.equal(res.type, "success")
    assert.equal(res.access, "KEYID.SECRET")
    assert.equal(res.accountId, "login@example.test")
    const state = JSON.parse(res.refresh)
    assert.equal(state.site, "zai")
    assert.equal(state.key, "KEYID.SECRET")
    assert.equal(state.jwt, "jwt-start")
    assert.equal(state.plan, "GLM Coding Pro")
    assert.ok(seen.some((s) => s.url.includes("/oauth/cli/poll/flow-1")))
  } finally {
    globalThis.fetch = real
  }
})

test("the internal switch helpers are exposed for tests, not as plugins", async () => {
  assert.equal(typeof _internal.switchImport, "function")
  assert.equal(typeof ZCodeAuthPlugin, "function")
})
