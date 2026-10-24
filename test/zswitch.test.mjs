import test from "node:test"
import assert from "node:assert/strict"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  accountsFromPayload,
  credSecret,
  decryptValue,
  describeAccount,
  jwtExpiry,
  jwtExpired,
  openBundleText,
  readBundleFile,
  readSwitchAccounts,
  sealTestBundle,
  slotFor,
  stableDevice,
  switchStateFor,
} from "../src/zswitch.mjs"

const homes = []
function mkHome() {
  const h = mkdtempSync(join(tmpdir(), "zsw-test-"))
  homes.push(h)
  mkdirSync(join(h, ".zcode-switch", "accounts"), { recursive: true })
  return h
}
function writeAccount(home, file, value) {
  writeFileSync(join(home, ".zcode-switch", "accounts", file), JSON.stringify(value, null, 2))
}
test.after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

const ENV = { USERNAME: "tester", ZCODE_CREDENTIAL_SECRET: "test-secret" }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (claims = { sub: "user-1" }) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`

function encKey(value, key) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(String(value), "utf8"), c.final()])
  return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`
}
const enc = (value, seed = "test-secret") => encKey(value, createHash("sha256").update(seed).digest())

function creds(over = {}) {
  return {
    zcodejwttoken: jwt(),
    "oauth:active_provider": "zai",
    "oauth:zai:access_token": "access-1",
    "oauth:zai:user_info": JSON.stringify({ id: "user-1", email: "ada@example.test", displayName: "Ada" }),
    ...over,
  }
}

function rawAccount(over = {}) {
  return {
    switchId: over.switchId ?? "acct-1",
    name: over.name ?? "Ada",
    credentials: over.credentials ?? creds(),
    config: over.config ?? null,
    virtualDeviceMid: over.virtualDeviceMid ?? "11111111-2222-4333-8444-555555555555",
    virtualArmsUid: over.virtualArmsUid ?? "",
    source: "store",
  }
}

function fileAccount(over = {}) {
  return {
    id: over.id ?? "acct-1",
    name: over.name ?? "Ada",
    created_at: over.created_at ?? "2026-09-30 05:00",
    updated_at: "2026-09-30 05:00",
    hash: "x",
    credentials: over.credentials ?? creds(),
    config: over.config ?? null,
    virtual_device_mid: over.virtual_device_mid ?? "11111111-2222-4333-8444-555555555555",
    virtual_arms_uid: null,
  }
}

const readOne = (home, id, env = ENV) => {
  const a = readSwitchAccounts({ env, home }).accounts.find((x) => x.switchId === id)
  assert.ok(a, `account ${id} not found`)
  return a
}

test("a plain zcode-switch account is read and described", () => {
  const home = mkHome()
  writeAccount(home, "a.json", fileAccount())
  const { dir, accounts, errors } = readSwitchAccounts({ env: ENV, home })
  assert.equal(dir, join(home, ".zcode-switch", "accounts"))
  assert.deepEqual(errors, [])
  const d = describeAccount(accounts.find((x) => x.switchId === "acct-1"), { env: ENV, home, platform: "win32" })
  assert.equal(d.displayName, "Ada")
  assert.equal(d.email, "ada@example.test")
  assert.equal(d.site, "zai")
  assert.equal(d.jwt, jwt())
  assert.equal(d.access, "access-1")
  assert.equal(d.key, "")
  assert.equal(d.device, "11111111-2222-4333-8444-555555555555")
  assert.equal(d.uid, "zai:user-1")
  assert.equal(d.error, "")
})

test("a placeholder profile name falls back to the email", () => {
  const home = mkHome()
  const values = {
    zcodejwttoken: jwt(),
    "oauth:active_provider": "zai",
    "oauth:zai:user_info": JSON.stringify({ id: "u-none", displayName: "None", username: "None", email: "none@example.test" }),
  }
  writeAccount(home, "none.json", fileAccount({ id: "acct-none", name: "None", credentials: values, virtual_device_mid: "" }))
  const d = describeAccount(readOne(home, "acct-none"), { env: ENV, home, platform: "win32" })
  assert.equal(d.displayName, "none@example.test")
  assert.match(d.label, /none@example\.test/)
  assert.doesNotMatch(d.label, /None/)
})

test("a JWT-only account gives the Start Plan state", async () => {
  const home = mkHome()
  writeAccount(home, "a.json", fileAccount())
  const d = describeAccount(readOne(home, "acct-1"), { env: ENV, home, platform: "win32" })
  const r = await switchStateFor(d, {})
  assert.equal(r.error, undefined)
  assert.equal(r.state.source, "zcode-switch")
  assert.equal(r.state.site, "zai")
  assert.equal(r.state.key, "")
  assert.equal(r.state.jwt, jwt())
  assert.equal(r.state.device, d.device)
  assert.equal(r.expires, jwtExpiry(jwt()))
  assert.equal(r.uid, "zai:user-1")
})

test("the coding-plan key in the account's config wins", async () => {
  const home = mkHome()
  const config = { provider: { "builtin:zai-coding-plan": { options: { apiKey: "keyid.secret" } } } }
  writeAccount(home, "a.json", fileAccount({ config }))
  const d = describeAccount(readOne(home, "acct-1"), { env: ENV, home, platform: "win32" })
  assert.equal(d.key, "keyid.secret")
  const r = await switchStateFor(d, {})
  assert.equal(r.state.key, "keyid.secret")
  assert.equal(r.expires, 0)
})

test("ZCode's encrypted credential values are opened", () => {
  const home = mkHome()
  const values = {
    zcodejwttoken: enc(jwt()),
    "oauth:active_provider": enc("zai"),
    "oauth:zai:access_token": enc("access-enc"),
    "oauth:zai:user_info": enc(JSON.stringify({ id: "u-enc", email: "enc@example.test", displayName: "Enc" })),
  }
  writeAccount(home, "enc.json", fileAccount({ id: "acct-enc", name: "Enc", credentials: values }))
  const d = describeAccount(readOne(home, "acct-enc"), { env: ENV, home, platform: "win32" })
  assert.equal(d.jwt, jwt())
  assert.equal(d.access, "access-enc")
  assert.equal(d.displayName, "Enc")
  assert.equal(d.error, "")
})

test("an account saved under another machine's key is reported, not guessed", () => {
  const home = mkHome()
  const values = {
    zcodejwttoken: enc(jwt(), "another-secret"),
    "oauth:active_provider": enc("zai", "another-secret"),
    "oauth:zai:access_token": enc("access-other", "another-secret"),
  }
  writeAccount(home, "locked.json", fileAccount({ id: "acct-locked", name: "Locked", credentials: values, virtual_device_mid: "" }))
  const d = describeAccount(readOne(home, "acct-locked"), { env: ENV, home, platform: "win32" })
  assert.match(d.error, /解不开/)
  assert.equal(d.jwt, "")
  assert.equal(d.access, "")
})

test("a credential encrypted under the machine home or a moved library home opens", () => {
  const machine = mkHome()
  const lib = mkHome()
  const env = { USERNAME: "tester" } // no ZCODE_CREDENTIAL_SECRET: try both homes
  const machineKey = credSecret({ env, platform: "win32", home: machine })
  const libKey = credSecret({ env, platform: "win32", home: lib })
  const values = {
    zcodejwttoken: encKey(jwt(), machineKey),
    "oauth:active_provider": "zai",
    "oauth:zai:access_token": encKey("access-switch", libKey),
    "oauth:zai:user_info": encKey(JSON.stringify({ id: "u-mixed", displayName: "Mixed" }), machineKey),
  }
  writeAccount(lib, "mixed.json", fileAccount({ id: "acct-mixed", name: "Mixed", credentials: values, virtual_device_mid: "" }))
  const envMoved = { ...env, ZCODE_SWITCH_HOME: lib }
  const a = readSwitchAccounts({ env: envMoved, home: machine }).accounts.find((x) => x.switchId === "acct-mixed")
  const d = describeAccount(a, { env: envMoved, home: machine, machineHome: machine, platform: "win32" })
  assert.equal(d.jwt, jwt())
  assert.equal(d.access, "access-switch")
  assert.equal(d.displayName, "Mixed")
  assert.equal(d.error, "")
})

test("the same login from the store and a bundle gets one uid", () => {
  const values = {
    zcodejwttoken: jwt(),
    "oauth:active_provider": "zai",
    "oauth:zai:access_token": "same-access",
  }
  const a = describeAccount(rawAccount({ switchId: "store-1", name: "", credentials: values }), { env: ENV })
  const b = describeAccount(rawAccount({ switchId: "", name: "", credentials: values }), { env: ENV })
  assert.equal(a.uid, b.uid)
  assert.equal(a.uid, "zai:user-1")
  const c = describeAccount(
    rawAccount({
      switchId: "store-2",
      name: "",
      credentials: { ...values, zcodejwttoken: jwt({ sub: "user-2" }), "oauth:zai:access_token": "other" },
    }),
    { env: ENV },
  )
  assert.notEqual(a.uid, c.uid)
  // no user_info and no JWT: the credentials themselves identify the login
  const bare = { "oauth:active_provider": "zai", "oauth:zai:access_token": "bare-access" }
  const d = describeAccount(rawAccount({ switchId: "store-3", name: "", credentials: bare }), { env: ENV })
  const e = describeAccount(rawAccount({ switchId: "", name: "", credentials: bare }), { env: ENV })
  assert.equal(d.uid, e.uid)
})

test("a team seat gets its own uid and account name", async () => {
  const home = mkHome()
  writeAccount(home, "a.json", fileAccount())
  const d = describeAccount(readOne(home, "acct-1"), { env: ENV, home, platform: "win32" })
  const r = await switchStateFor(d, {
    resolve: async () => ({
      key: "team.secret",
      base: "https://api.z.ai/api/anthropic",
      plan: "GLM Coding Team",
      org: "org-1",
      project: "proj-1",
      token: "team-token",
    }),
  })
  assert.equal(r.uid, "zai:user-1:team:org-1:proj-1")
  assert.equal(r.accountId, "Ada (team)")
  assert.equal(r.state.key, "team.secret")
  assert.equal(r.state.org, "org-1")
  assert.equal(r.state.project, "proj-1")
})

test("an expired Start Plan JWT is refused with a re-login hint", async () => {
  const home = mkHome()
  const past = jwt({ sub: "old", exp: Math.floor(Date.now() / 1000) - 60 })
  writeAccount(
    home,
    "old.json",
    fileAccount({
      id: "acct-old",
      name: "Old",
      credentials: {
        zcodejwttoken: past,
        "oauth:active_provider": "zai",
        "oauth:zai:user_info": JSON.stringify({ id: "old", displayName: "Old" }),
      },
      virtual_device_mid: "",
    }),
  )
  const d = describeAccount(readOne(home, "acct-old"), { env: ENV, home, platform: "win32" })
  assert.equal(jwtExpired(d.jwt), true)
  const r = await switchStateFor(d, {})
  assert.match(r.error, /已过期/)
})

test("a resolver's coding-plan key is used when the config has none", async () => {
  const home = mkHome()
  writeAccount(home, "a.json", fileAccount())
  const d = describeAccount(readOne(home, "acct-1"), { env: ENV, home, platform: "win32" })
  const seen = []
  const r = await switchStateFor(d, {
    resolve: async (x) => {
      seen.push(x)
      return { key: "minted.secret", base: "https://api.z.ai/api/anthropic", plan: "GLM Coding Pro" }
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].site, "zai")
  assert.equal(seen[0].token, "access-1")
  assert.equal(r.state.key, "minted.secret")
  assert.equal(r.state.plan, "GLM Coding Pro")
  assert.equal(r.expires, 0)
})

test("a failed resolver leaves a usable JWT state", async () => {
  const home = mkHome()
  writeAccount(home, "a.json", fileAccount())
  const d = describeAccount(readOne(home, "acct-1"), { env: ENV, home, platform: "win32" })
  const r = await switchStateFor(d, {
    resolve: async () => {
      throw new Error("network down")
    },
  })
  assert.equal(r.state.key, "")
  assert.equal(r.state.jwt, jwt())
  assert.match(r.warnings.join(" "), /network down/)
})

test("a timeout aborts the resolver and does not fall back to Start Plan", async () => {
  const home = mkHome()
  writeAccount(home, "a.json", fileAccount())
  const d = describeAccount(readOne(home, "acct-1"), { env: ENV, home, platform: "win32" })
  let aborted = false
  const r = await switchStateFor(d, {
    timeout: 80,
    resolve: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      }),
  })
  assert.equal(aborted, true)
  assert.match(r.error, /超时/)
  assert.equal(r.state, undefined)
})

test("a .zsb bundle round-trips and imports the same accounts", () => {
  const payload = {
    format: "zcode-accounts-bundle",
    version: 2,
    exportedAt: "2026-10-01 12:00",
    accounts: [
      {
        name: "Bundled",
        createdAt: "2026-09-01 00:00",
        credentials: {
          zcodejwttoken: jwt({ sub: "bundle-1" }),
          "oauth:active_provider": "zai",
          "oauth:zai:access_token": "bundle-access",
          "oauth:zai:user_info": JSON.stringify({ id: "bundle-1", email: "b@example.test" }),
        },
      },
    ],
  }
  const sealed = sealTestBundle(payload, "correct horse")
  const opened = openBundleText(JSON.stringify(sealed), "correct horse")
  assert.deepEqual(opened, payload)
  assert.throws(() => openBundleText(JSON.stringify(sealed), "wrong"), /口令错误/)
  const accounts = accountsFromPayload(opened)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].name, "Bundled")
  const d = describeAccount(accounts[0], { env: ENV, home: mkHome(), platform: "win32" })
  assert.equal(d.email, "b@example.test")
  assert.equal(d.device, stableDevice(d.uid))
})

test("a corrupted sealed bundle is refused with a clear reason", () => {
  const sealed = sealTestBundle({ accounts: [{ name: "X", credentials: { zcodejwttoken: jwt() } }] }, "pw")
  const badTag = JSON.parse(JSON.stringify(sealed))
  badTag.cipher.tag = "AAAA"
  assert.throws(() => openBundleText(JSON.stringify(badTag), "pw"), /加密参数异常|口令错误/)
  const badAlgo = JSON.parse(JSON.stringify(sealed))
  badAlgo.kdf.algo = "scrypt"
  assert.throws(() => openBundleText(JSON.stringify(badAlgo), "pw"), /不支持的密钥派生算法/)
})

test("a plain bundle, a single account and bare credentials all import", () => {
  const plain = {
    format: "zcode-accounts-bundle",
    accounts: [{ name: "Plain", credentials: { zcodejwttoken: jwt() } }],
  }
  assert.equal(accountsFromPayload(openBundleText(JSON.stringify(plain))).length, 1)
  assert.equal(accountsFromPayload({ name: "One", credentials: { zcodejwttoken: jwt() } }).length, 1)
  assert.equal(accountsFromPayload({ zcodejwttoken: jwt() }).length, 1)
  assert.equal(accountsFromPayload({ hello: "world" }).length, 0)
})

test("a bundle file is read by path, quotes included", () => {
  const home = mkHome()
  const payload = { accounts: [{ name: "File", credentials: { zcodejwttoken: jwt() } }] }
  const file = join(home, "backup.zsb")
  writeFileSync(file, JSON.stringify(sealTestBundle(payload, "pw")))
  assert.equal(accountsFromPayload(readBundleFile(`"${file}"`, "pw")).length, 1)
  assert.throws(() => readBundleFile(join(home, "missing.zsb"), "pw"), /找不到文件/)
})

test("device ids and slots are stable and distinct", () => {
  const a = stableDevice("zai:user-1")
  const b = stableDevice("zai:user-1")
  const c = stableDevice("zai:user-2")
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(slotFor("zai:user-1"), slotFor("zai:user-1"))
  assert.notEqual(slotFor("zai:user-1"), slotFor("zai:user-2"))
  assert.match(slotFor("zai:user-1"), /^zcode#[0-9a-f]{8}$/)
})

test("the credential key follows zcode-switch's fallback rule", () => {
  const key = credSecret({ env: { USERNAME: "tester" }, platform: "win32", home: "C:\\Users\\tester" })
  const want = createHash("sha256").update("zcode-credential-fallback:win32:C:\\Users\\tester:tester").digest()
  assert.deepEqual(key, want)
  const explicit = credSecret({ env: { ZCODE_CREDENTIAL_SECRET: "s3" }, platform: "win32", home: mkHome() })
  assert.deepEqual(explicit, createHash("sha256").update("s3").digest())
  assert.equal(decryptValue(enc("x"), createHash("sha256").update("test-secret").digest()), "x")
})
