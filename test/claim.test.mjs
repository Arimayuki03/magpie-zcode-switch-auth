import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  billingHeaders,
  captchaConfig,
  claimFailureMessage,
  claimNextAt,
  claimPage,
  previewPlans,
  startClaimSession,
} from "../src/claim.mjs"

const META = { appVersion: "3.16.3", platform: "linux-x64", osCategory: "linux", osVersion: "6.1.0", language: "zh-CN", timezone: "Asia/Shanghai" }
const officialURL = (u) => new URL(String(u))
const JWT = `h.${Buffer.from(JSON.stringify({ sub: "claim-user" })).toString("base64url")}.sig`

const reply = (env, status = 200) => new Response(JSON.stringify(env), { status, headers: { "content-type": "application/json" } })

// a fetch stand-in that records the vendor calls and answers from routes
function vendorStub(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers, body: init.body })
    return reply(routes(String(url), init))
  }
  return { calls, fetchImpl }
}

const plan = (id, name, priority, units) => ({
  plan_id: id,
  name,
  description: "",
  priority,
  entitlements: [
    { meter: "model_usage", unit_type: "token", show_name: "GLM-5.3", grant_units: units, period: "daily" },
  ],
})

test("billing headers name the ZCode client and carry the account's JWT", () => {
  const h = billingHeaders({ jwt: JWT, meta: META })
  assert.equal(h["User-Agent"], "ZCode/3.16.3")
  assert.equal(h["X-Title"], "Z Code@electron")
  assert.equal(h["X-Release-Channel"], "stable")
  assert.equal(h.Authorization, "Bearer " + JWT)
  assert.equal(h["X-Client-Timezone"], "Asia/Shanghai")
})

test("preview plans parse both spellings, sort by priority and name their grants", async () => {
  const { fetchImpl } = vendorStub(() => ({
    code: 0,
    data: {
      plans: [
        plan("plan-b", "Low Priority", 1, 123456),
        { planId: "plan-a", name: "High Priority", priority: 9, entitlements: [{ meter: "other", unit_type: "token", show_name: "skip", grant_units: 1, period: "daily" }] },
        { plan_id: "plan-c", name: "No Grants", priority: 5 },
      ],
    },
  }))
  const plans = await previewPlans({ fetchImpl, officialURL, meta: META, jwt: JWT, device: "dev-1" })
  assert.deepEqual(plans.map((p) => p.planId), ["plan-a", "plan-c", "plan-b"])
  const b = plans.find((p) => p.planId === "plan-b")
  assert.equal(b.grants.length, 1)
  assert.equal(b.grants[0].name, "GLM-5.3")
  assert.match(b.display, /12\.3万 Token（每日）/)
  assert.equal(plans.find((p) => p.planId === "plan-c").grants.length, 0)
})

test("preview failures carry the vendor's words", async () => {
  const { fetchImpl } = vendorStub(() => ({ code: 401, msg: "token expired" }))
  await assert.rejects(() => previewPlans({ fetchImpl, officialURL, meta: META, jwt: JWT, device: "d" }), /token expired/)
})

test("claim failures map to zcode-switch's messages", () => {
  assert.equal(claimFailureMessage(1003, {}), "该套餐已经领取过")
  assert.equal(claimFailureMessage(3007, { msg: "captcha mismatch" }), "验证码校验失败，请重试（captcha mismatch）")
  assert.equal(claimFailureMessage(9999, {}), "领取失败")
  assert.equal(claimNextAt(1005, { data: { plan: { ends_at: 1700000000 } } }), 1700000000000)
  assert.equal(claimNextAt(1003, {}), 0)
})

test("the captcha scene comes from the client config, with zcode-switch's fallback", async () => {
  const ok = vendorStub(() => ({ code: 0, data: { configs: { captcha: { enabled: true, region: "sgp", prefix: "no8xfe", sceneId: "scene-1" } } } }))
  assert.deepEqual(await captchaConfig({ fetchImpl: ok.fetchImpl, officialURL, meta: META }), {
    enabled: true,
    region: "sgp",
    prefix: "no8xfe",
    sceneId: "scene-1",
  })
  const off = vendorStub(() => ({ code: 0, data: { configs: { captcha: { enabled: false } } } }))
  const cfg = await captchaConfig({ fetchImpl: off.fetchImpl, officialURL, meta: META })
  assert.equal(cfg.enabled, false)
  const dead = vendorStub(() => ({ code: -1 }))
  assert.equal((await captchaConfig({ fetchImpl: dead.fetchImpl, officialURL, meta: META })).sceneId, "11xygtvd")
})

const CLAIM_ROUTES = (claims) => (url, init) => {
  if (url.includes("/client/configs")) {
    return { code: 0, data: { configs: { captcha: { enabled: true, region: "sgp", prefix: "no8xfe", sceneId: "scene-1" } } } }
  }
  if (url.includes("/billing/preview")) {
    return { code: 0, data: { plans: [plan("plan-a", "1024 Dev Day", 9, 50000), plan("plan-b", "New User Plan", 5, 8000)] } }
  }
  if (url.includes("/billing/claim")) {
    const id = JSON.parse(init.body).plan_id
    return claims[id] ?? { code: 0, data: { plan: { name: "1024 Dev Day", starts_at: 1, ends_at: 2 } } }
  }
  throw new Error("unexpected " + url)
}

test("a claim session serves the page, takes tickets and reports outcomes", async () => {
  const { calls, fetchImpl } = vendorStub(CLAIM_ROUTES({ "plan-b": { code: 1003, msg: "" } }))
  const session = await startClaimSession({
    fetchImpl,
    officialURL,
    meta: META,
    jwt: JWT,
    device: "dev-1",
    label: "Ada · Z.ai",
    auto: false,
    log: () => {},
  })
  try {
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    const page = await fetch(session.url).then((r) => r.text())
    assert.match(page, /scene-1/)
    assert.match(page, /1024 Dev Day/)
    assert.match(page, /全部领取/)
    // the JWT stays on the server side; the page never sees it
    assert.ok(!page.includes(JWT), "the page must not carry the JWT")
    const secret = page.match(/"secret":"([0-9a-f]+)"/)[1]

    const claim = (body, extra = {}) =>
      fetch(session.url + "api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claim-Secret": extra.secret ?? secret },
        body: JSON.stringify(body),
      })

    assert.equal((await claim({ planId: "plan-a", param: "x" }, { secret: "wrong" })).status, 403)
    const short = await claim({ planId: "plan-a", param: "x".repeat(10) })
    assert.equal(short.status, 400)
    const good = await claim({ planId: "plan-a", param: "x".repeat(300), region: "sgp" })
    assert.deepEqual(await good.json(), { ok: true, message: "已领取" })
    const claimCall = calls.find((c) => c.url.includes("/billing/claim"))
    assert.equal(JSON.parse(claimCall.body).plan_id, "plan-a")
    assert.equal(claimCall.headers["X-Aliyun-Captcha-Verify-Param"], "x".repeat(300))
    assert.equal(claimCall.headers["X-Aliyun-Captcha-Verify-Region"], "sgp")
    const dup = await claim({ planId: "plan-b", param: "y".repeat(300) })
    assert.match((await dup.json()).message, /已经领取过/)
    const unknown = await claim({ planId: "plan-z", param: "z".repeat(300) })
    assert.equal(unknown.status, 400)

    // a rescan can add plans the first scan missed
    const rescanned = await fetch(session.url + "api/preview").then((r) => r.json())
    assert.equal(rescanned.plans.length, 2)

    const outcome = await session.wait(5000)
    assert.equal(outcome.claimed.length, 1)
    assert.equal(outcome.claimed[0].planId, "plan-a")
    assert.equal(outcome.failed.length, 1)
    assert.match(outcome.failed[0].message, /已经领取过/)
  } finally {
    session.close()
  }
})

test("the page starts claiming by itself when auto is on", async () => {
  const { fetchImpl } = vendorStub(CLAIM_ROUTES({}))
  const session = await startClaimSession({
    fetchImpl,
    officialURL,
    meta: META,
    jwt: JWT,
    device: "dev-1",
    label: "Ada",
    auto: true,
    log: () => {},
  })
  try {
    const page = await fetch(session.url).then((r) => r.text())
    assert.match(page, /"auto":true/)
    assert.match(page, /claimAll\(\);\n/)
  } finally {
    session.close()
  }
})

// ---- the plugin's claim method ------------------------------------------------------

const HOME = mkdtempSync(join(tmpdir(), "zsw-claim-test-"))
mkdirSync(join(HOME, ".zcode-switch", "accounts"), { recursive: true })
process.env.ZCODE_SWITCH_HOME = HOME
process.env.ZCODE_CREDENTIAL_SECRET = "test-secret"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const accountJWT = (sub = "claim-user") => `${b64({ alg: "HS256" })}.${b64({ sub })}.sig`
writeFileSync(
  join(HOME, ".zcode-switch", "accounts", "ada.json"),
  JSON.stringify({
    id: "ada",
    name: "Ada",
    created_at: "2026-09-30 05:00",
    credentials: {
      zcodejwttoken: accountJWT("ada"),
      "oauth:active_provider": "zai",
      "oauth:zai:user_info": JSON.stringify({ id: "ada", displayName: "Ada", email: "ada@example.test" }),
    },
    config: null,
    virtual_device_mid: "11111111-2222-4333-8444-555555555555",
  }),
  "utf8",
)

const { ZCodeAuthPlugin, _internal } = await import("../src/index.mjs")

test.after(() => {
  rmSync(HOME, { recursive: true, force: true })
  delete process.env.ZCODE_SWITCH_HOME
  delete process.env.ZCODE_CREDENTIAL_SECRET
})

test("the plugin offers claiming as a ninth sign-in method", async () => {
  const client = { app: { log: async () => {} }, auth: { set: async () => {} }, tui: { showToast: async () => {} } }
  const hooks = await ZCodeAuthPlugin({ client, project: { id: "magpie" } })
  const m = hooks.auth.methods.find((x) => x.label.includes("领取赠送套餐"))
  assert.ok(m, "claim method missing")
  const options = m.prompts[0].options
  assert.ok(options.some((o) => o.value === "__app__"))
  assert.ok(options.some((o) => o.value === "sw:ada"), "accounts with a JWT are claimable")
  assert.ok(!options.some((o) => o.value === "sw:bob"), "accounts without a JWT are not listed")
  await assert.rejects(() => m.authorize({ account: "sw:missing" }), /找不到账号/)
  await assert.rejects(() => m.authorize({ account: "auth:magpie:missing" }), /找不到这个登录/)
  await assert.rejects(() => m.authorize({ account: "nonsense" }), /请选择/)
})

test("claim options include accounts already signed in to the host", () => {
  const home = mkdtempSync(join(tmpdir(), "zsw-auth-store-"))
  try {
    const dir = join(home, ".config", "magpie")
    mkdirSync(dir, { recursive: true })
    const state = { source: "zcode-switch", site: "zai", device: "11111111-2222-4333-8444-555555555555", jwt: accountJWT("store-user") }
    writeFileSync(
      join(dir, "plugin-auth.json"),
      JSON.stringify({
        zcode: { type: "oauth", refresh: JSON.stringify(state), access: "", expires: 0, accountId: "Store User" },
        "zcode#abcdef12": { type: "oauth", refresh: JSON.stringify({ ...state, jwt: "" }), access: "k.secret", expires: 0, accountId: "Key Only" },
        other: { type: "oauth", refresh: "{}", accountId: "Not ZCode" },
      }),
    )
    const opts = _internal.claimOptions(() => {}, { home })
    const auth = opts.filter((o) => o.value.startsWith("auth:"))
    assert.equal(auth.length, 1)
    assert.equal(auth[0].value, "auth:magpie:zcode")
    assert.match(auth[0].label, /Store User/)
    assert.ok(!opts.some((o) => o.value.includes("abcdef12")), "entries without a JWT are not claimable")
    assert.ok(!opts.some((o) => o.label.includes("Not ZCode")), "other providers are ignored")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("ZCODE_AUTO_CLAIM parses like a switch", () => {
  const old = process.env.ZCODE_AUTO_CLAIM
  for (const [v, want] of [["1", true], ["true", true], ["on", true], ["0", false], ["", false], [undefined, false]]) {
    if (v === undefined) delete process.env.ZCODE_AUTO_CLAIM
    else process.env.ZCODE_AUTO_CLAIM = v
    assert.equal(_internal.autoClaim(), want, `ZCODE_AUTO_CLAIM=${v}`)
  }
  if (old === undefined) delete process.env.ZCODE_AUTO_CLAIM
  else process.env.ZCODE_AUTO_CLAIM = old
})
