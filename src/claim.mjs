// Gift-plan claiming, the way zcode-switch does it: /billing/preview lists
// the plans ZCode is holding for the account, the Aliyun captcha is passed
// the way the ZCode app's page passes it, and /billing/claim spends the
// ticket on a plan. The captcha runs in a small page this module serves on
// 127.0.0.1 and the host opens in the browser (a plugin has no webview of
// its own); the page hands the verify param back, and the claim request
// itself goes out from here with the account's own JWT. Only zcode.z.ai is
// contacted, and no token ever reaches the page.
//
// Endpoints, headers, error codes and the captcha scene are zcode-switch's
// (MIT, Saktawdi/zcode-switch): preview is
// GET /api/v1/zcode-plan/billing/preview, claim is
// POST /api/v1/zcode-plan/billing/claim with the ticket in
// X-Aliyun-Captcha-Verify-Param, and the scene comes from
// /api/v1/client/configs (data.configs.captcha).

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

const CONFIGS_URL = "https://zcode.z.ai/api/v1/client/configs"
const PREVIEW_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview"
const CLAIM_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim"
const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"

// a ticket shorter than this never passes the vendor's check (zcode-switch
// refuses it before it wastes a claim attempt on a 3007)
const MIN_PARAM = 200
const CLAIM_TIMEOUT_MS = 25_000

// the captcha scene ZCode ships, used only when /client/configs can't be
// read (zcode-switch keeps the same fallback)
const FALLBACK_CAPTCHA = { enabled: true, region: "sgp", prefix: "no8xfe", sceneId: "11xygtvd" }

const str = (v) => (typeof v === "string" ? v.trim() : "")
const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : 0
}
const field = (o, snake, camel) => str(o?.[snake]) || str(o?.[camel])

// billingHeaders is what zcode.z.ai's billing endpoints see: the ZCode app's
// own headers (meta carries the plugin's view of them) with the account's
// JWT on top. X-Device-Mid goes on by the caller's device.
export function billingHeaders({ jwt, meta }) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `ZCode/${meta.appVersion}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": meta.appVersion,
    "X-Platform": meta.platform,
    "X-Release-Channel": "stable",
    "X-Client-Language": meta.language,
    "X-Client-Timezone": meta.timezone,
    "X-Os-Category": meta.osCategory,
    "X-Os-Version": meta.osVersion,
    Authorization: "Bearer " + jwt,
    "x-request-id": crypto.randomUUID(),
  }
}

// run is one JSON request with those headers; the whole envelope comes back,
// so the claim's own error codes (1001..1005, 3001, 3007) stay readable —
// the plugin's generic call() would flatten them into a message.
async function run({ fetchImpl, officialURL, method, url, jwt, device, meta, body, headers, timeoutMs }) {
  officialURL(url)
  const h = billingHeaders({ jwt, meta })
  h["X-Device-Mid"] = device
  Object.assign(h, headers ?? {})
  const res = await fetchImpl(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? CLAIM_TIMEOUT_MS),
  })
  const text = await res.text()
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}${str(v?.msg) ? "：" + str(v.msg) : ""}`)
  return v && typeof v === "object" ? v : { code: -1, msg: "响应不是 JSON" }
}

// captchaConfig reads the scene ZCode's client config names; a config that
// is readable but disabled means the event is over — refused, not guessed.
export async function captchaConfig({ fetchImpl, officialURL, meta }) {
  try {
    const env = await run({
      fetchImpl,
      officialURL,
      method: "GET",
      url: `${CONFIGS_URL}?app_version=${encodeURIComponent(meta.appVersion)}&platform=${encodeURIComponent(meta.platform)}`,
      jwt: "",
      device: crypto.randomUUID(),
      meta,
      timeoutMs: 10_000,
    })
    const c = env?.data?.configs?.captcha
    if (c && typeof c === "object") {
      const cfg = {
        enabled: c.enabled !== false,
        region: str(c.region),
        prefix: str(c.prefix),
        sceneId: str(c.sceneId ?? c.scene_id),
      }
      if (cfg.enabled && cfg.sceneId) return cfg
      return { ...cfg, sceneId: "" }
    }
  } catch {}
  return { ...FALLBACK_CAPTCHA }
}

const PERIODS = { daily: "每日", weekly: "每周", monthly: "每月", one_time: "一次性" }

const fmtUnits = (n) => {
  const trim = (x) => {
    const r = Math.round(x * 10) / 10
    return Number.isInteger(r) ? String(Math.trunc(r)) : r.toFixed(1)
  }
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return String(Math.round(n))
}

const grantLine = (g) => `${g.name} · ${fmtUnits(g.units)} Token（${PERIODS[g.period] ?? "一次性"}）`

const grantSummary = (grants) => grants.map(grantLine).join("；")

// previewPlans reads the plans ZCode is holding for the account: token
// grants with a name, best (highest priority) first.
export async function previewPlans({ fetchImpl, officialURL, meta, jwt, device }) {
  const env = await run({
    fetchImpl,
    officialURL,
    method: "GET",
    url: `${PREVIEW_URL}?app_version=${encodeURIComponent(meta.appVersion)}&platform=${encodeURIComponent(meta.platform)}`,
    jwt,
    device,
    meta,
  })
  if (env.code !== 0 && env.code !== "0") throw new Error(str(env.msg) || "读取可领套餐失败")
  const raw = Array.isArray(env?.data?.plans) ? env.data.plans : []
  const out = []
  for (const p of raw) {
    const planId = field(p, "plan_id", "planId")
    if (!planId) continue
    const grants = []
    for (const e of Array.isArray(p?.entitlements) ? p.entitlements : []) {
      if (field(e, "meter", "meter") !== "model_usage") continue
      if (field(e, "unit_type", "unitType") !== "token") continue
      const name = field(e, "show_name", "showName")
      if (!name) continue
      grants.push({ name, units: num(e?.grant_units ?? e?.grantUnits), period: field(e, "period", "period") || "one_time" })
    }
    const name = str(p?.name)
    const summary = grantSummary(grants)
    out.push({
      planId,
      name,
      description: str(p?.description),
      priority: num(p?.priority),
      grants,
      display: [name, summary].filter(Boolean).join(" · "),
    })
  }
  out.sort((a, b) => b.priority - a.priority || a.planId.localeCompare(b.planId))
  return out
}

// the claim's own failure codes, as zcode-switch words them
const FAILURES = {
  1001: "套餐不存在",
  1002: "活动已结束或套餐暂不可领取",
  1003: "该套餐已经领取过",
  1004: "不符合领取条件",
  1005: "今日领取名额已用完",
  3001: "领取参数错误，请刷新后重试",
  3007: "验证码校验失败，请重试",
  401: "请先登录后再领取",
}

export function claimFailureMessage(code, body) {
  const server = str(body?.msg) || str(body?.message)
  const base = FAILURES[code] ?? "领取失败"
  return server ? `${base}（${server}）` : base
}

export function claimNextAt(code, body) {
  const end = code === 1005 ? num(body?.data?.plan?.ends_at) : 0
  return end > 0 ? end * 1000 : 0
}

export async function submitClaim({ fetchImpl, officialURL, meta, jwt, device, planId, param, region }) {
  const headers = { "X-Aliyun-Captcha-Verify-Param": param }
  if (region) headers["X-Aliyun-Captcha-Verify-Region"] = region
  return run({ fetchImpl, officialURL, method: "POST", url: CLAIM_URL, jwt, device, meta, body: { plan_id: planId }, headers })
}

// ---- the local captcha page -------------------------------------------------------

// claimPage is the whole page: it loads Aliyun's SDK, tries the traceless
// check and falls back to the slider, and POSTs each ticket to the local
// server, which alone holds the JWT and talks to zcode.z.ai.
export function claimPage({ captcha, plans, auto, label, secret }) {
  const boot = JSON.stringify({ captcha, plans, auto, label, secret, sdk: SDK_URL }).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>领取赠送套餐</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0c; color: #e7e7ea; font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  #app { width: min(640px, 92vw); padding: 28px 26px; border: 1px solid #26262c; border-radius: 14px; background: #131317; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .acct { color: #9a9aa5; font-size: 12px; margin-bottom: 14px; word-break: break-all; }
  #status { margin: 0 0 12px; font-size: 13px; color: #d9d9e3; }
  .plan { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #26262c;
    border-radius: 10px; margin-bottom: 8px; background: #191920; }
  .plan .info { flex: 1; min-width: 0; }
  .plan .name { font-weight: 600; }
  .plan .grant { color: #9a9aa5; font-size: 12px; word-break: break-all; }
  .plan .st { font-size: 12px; white-space: nowrap; }
  .plan .st.ok { color: #4ade80; }
  .plan .st.err { color: #f87171; }
  .plan .st.run { color: #fbbf24; }
  .plan button { flex: none; }
  button { background: #2e2e38; color: #e7e7ea; border: 1px solid #3a3a46; border-radius: 8px;
    padding: 6px 14px; font-size: 13px; cursor: pointer; }
  button:hover { background: #383845; }
  button[disabled] { opacity: 0.45; cursor: default; }
  #cap-holder { min-height: 0; }
  .foot { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .note { margin-top: 12px; color: #6b6b76; font-size: 12px; }
  .empty { color: #9a9aa5; padding: 8px 0; }
</style>
</head>
<body>
<div id="app">
  <h1>领取赠送套餐</h1>
  <div class="acct"></div>
  <div id="status">正在准备安全验证…</div>
  <div id="plans"></div>
  <div id="cap-holder"></div>
  <button id="cap-btn" type="button" hidden>点击完成验证</button>
  <div class="foot">
    <button id="rescan">重新扫描</button>
    <button id="claimall">全部领取</button>
    <button id="finish">完成</button>
  </div>
  <div class="note">验证由阿里云提供 · 与 ZCode 客户端同款流程</div>
</div>
<script>
const BOOT = ${boot};
const $ = (id) => document.getElementById(id);
const status = (t) => { $("status").textContent = t; };
let sdkReady = null;
const rows = new Map();

function loadSdk() {
  if (typeof window.initAliyunCaptcha === "function") return Promise.resolve();
  if (sdkReady) return sdkReady;
  sdkReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = BOOT.sdk;
    s.onload = resolve;
    s.onerror = () => { sdkReady = null; reject(new Error("验证码组件加载失败，请检查网络")); };
    document.head.appendChild(s);
  });
  return sdkReady;
}

// the SDK keeps a session in local storage; reusing a certifyId is read as
// a duplicate (F008), so every ticket starts from a wiped session
async function wipeSdkState() {
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    for (const d of dbs || []) { try { indexedDB.deleteDatabase(d.name); } catch (e) {} }
  } catch (e) {}
}

function solveCaptcha() {
  const holder = $("cap-holder");
  holder.innerHTML = "";
  const btn = $("cap-btn");
  btn.hidden = true;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    let interactiveTimer = 0;
    loadSdk().then(() => {
      window.AliyunCaptchaConfig = { region: BOOT.captcha.region, prefix: BOOT.captcha.prefix };
      window.initAliyunCaptcha({
        SceneId: BOOT.captcha.sceneId,
        mode: "popup",
        region: BOOT.captcha.region,
        prefix: BOOT.captcha.prefix,
        language: "zh-CN",
        showErrorTip: false,
        element: "#cap-holder",
        button: "#cap-btn",
        getInstance: (instance) => {
          if (instance && typeof instance.startTracelessVerification === "function") {
            instance.startTracelessVerification();
            interactiveTimer = setTimeout(() => {
              status("需要人工验证，请在弹窗中完成");
              btn.hidden = false;
              btn.focus();
            }, 8000);
          } else {
            status("需要人工验证，请在弹窗中完成");
            btn.hidden = false;
            btn.focus();
          }
        },
        success: (p) => {
          clearTimeout(interactiveTimer);
          const param = typeof p === "string" ? p : p && (p.captchaVerifyParam || p.verifyParam || p.data || p.param);
          if (p && typeof p === "object" && p.verifyResult === false) {
            done(reject, new Error("验证被拒（" + (p.verifyCode || "F008") + "），请重试"));
            return;
          }
          if (!param) { done(reject, new Error("验证未返回凭据，请重试")); return; }
          status("验证通过，正在领取…");
          btn.hidden = true;
          done(resolve, String(param));
        },
        fail: () => {
          clearTimeout(interactiveTimer);
          status("需要人工验证，请在弹窗中完成");
          btn.hidden = false;
          btn.focus();
        },
        onError: (p) => {
          clearTimeout(interactiveTimer);
          done(reject, new Error("验证码出错" + (p ? "：" + String(typeof p === "string" ? p : JSON.stringify(p)).slice(0, 80) : "")));
        },
      });
    }, (e) => done(reject, e));
  });
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claim-Secret": BOOT.secret },
    body: JSON.stringify(body || {}),
  });
  let v = null;
  try { v = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((v && v.error) || ("请求失败（HTTP " + res.status + "）"));
  return v;
}

function render(plans) {
  const box = $("plans");
  box.innerHTML = "";
  rows.clear();
  if (!plans.length) {
    box.innerHTML = '<div class="empty">当前没有可领取的赠送套餐（活动可能已结束）</div>';
    return;
  }
  for (const p of plans) {
    const div = document.createElement("div");
    div.className = "plan";
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name || p.planId;
    const grant = document.createElement("div");
    grant.className = "grant";
    grant.textContent = p.display && p.name ? p.display.slice(p.name.length + 3) || "" : "";
    info.appendChild(name);
    info.appendChild(grant);
    const st = document.createElement("span");
    st.className = "st";
    const btn = document.createElement("button");
    btn.textContent = "领取";
    btn.addEventListener("click", () => claimOne(p, st, btn));
    div.appendChild(info);
    div.appendChild(st);
    div.appendChild(btn);
    box.appendChild(div);
    rows.set(p.planId, { st, btn });
  }
}

function setRow(planId, text, cls) {
  const row = rows.get(planId);
  if (!row) return;
  row.st.textContent = text;
  row.st.className = "st" + (cls ? " " + cls : "");
}

async function claimOne(plan) {
  const row = rows.get(plan.planId);
  if (!row || row.busy) return;
  row.busy = true;
  row.btn.disabled = true;
  setRow(plan.planId, "验证中…", "run");
  try {
    const param = await solveCaptcha();
    const r = await post("/api/claim", { planId: plan.planId, param, region: BOOT.captcha.region || "" });
    if (r.ok) setRow(plan.planId, "已领取", "ok");
    else setRow(plan.planId, r.message || "领取失败", "err");
  } catch (e) {
    setRow(plan.planId, String(e.message || e), "err");
  } finally {
    row.busy = false;
    row.btn.disabled = false;
  }
}

async function claimAll() {
  status("正在逐个领取…");
  for (const p of BOOT.plans) {
    const row = rows.get(p.planId);
    if (row && !row.done) await claimOne(p);
  }
  status("全部套餐已处理");
  await finish();
}

async function finish() {
  try { await post("/api/done", {}); } catch (e) {}
  status("完成。本页可以关闭了。");
}

async function rescan() {
  status("正在重新扫描…");
  try {
    const r = await fetch("/api/preview").then((x) => x.json());
    if (r.plans) { BOOT.plans = r.plans; render(BOOT.plans); }
    status(BOOT.plans.length ? "共 " + BOOT.plans.length + " 个可领套餐" : "当前没有可领取的赠送套餐");
  } catch (e) {
    status("扫描失败：" + String(e.message || e));
  }
}

$("rescan").addEventListener("click", rescan);
$("claimall").addEventListener("click", claimAll);
$("finish").addEventListener("click", finish);
document.querySelector(".acct").textContent = BOOT.label || "";

render(BOOT.plans);
if (BOOT.auto && BOOT.plans.length) claimAll();
else status(BOOT.plans.length ? "共 " + BOOT.plans.length + " 个可领套餐" : "当前没有可领取的赠送套餐");
</script>
</body>
</html>`
}

// ---- the local server -------------------------------------------------------------

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

const sendJSON = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

// startClaimSession scans the claimable plans, serves the captcha page on
// 127.0.0.1 and submits each claim the page returns a ticket for. wait()
// resolves once every scanned plan has an outcome, the page says it is done,
// or the deadline passes; close() takes the server down either way.
export async function startClaimSession({ fetchImpl, officialURL, meta, jwt, device, label, auto, log }) {
  const captcha = await captchaConfig({ fetchImpl, officialURL, meta })
  if (!captcha.enabled || !captcha.sceneId) throw new Error("验证码配置不可用（活动可能已结束）")
  let plans = await previewPlans({ fetchImpl, officialURL, meta, jwt, device })
  if (!plans.length) throw new Error("没有可领取的赠送套餐")

  const secret = randomBytes(16).toString("hex")
  const known = new Set(plans.map((p) => p.planId))
  const results = new Map()
  const state = { done: false }
  const note = (m) => {
    try {
      log?.(m)
    } catch {}
  }

  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0]
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(claimPage({ captcha, plans, auto, label, secret }))
      return
    }
    if (req.method === "GET" && path === "/api/preview") {
      previewPlans({ fetchImpl, officialURL, meta, jwt, device })
        .then((next) => {
          plans = next
          for (const p of next) known.add(p.planId)
          sendJSON(res, 200, { plans })
        })
        .catch((e) => sendJSON(res, 502, { error: e?.message ?? String(e) }))
      return
    }
    let raw = ""
    req.on("data", (c) => {
      raw += c
      if (raw.length > 1 << 20) req.destroy()
    })
    req.on("end", async () => {
      if ((req.method === "POST" && path === "/api/claim") || (req.method === "POST" && path === "/api/done")) {
        if ((req.headers["x-claim-secret"] ?? "") !== secret) return sendJSON(res, 403, { error: "会话不匹配" })
        if (path === "/api/done") {
          state.done = true
          return sendJSON(res, 200, { ok: true })
        }
        let body = {}
        try {
          body = JSON.parse(raw || "{}")
        } catch {}
        const param = str(body?.param)
        const planId = str(body?.planId)
        if (!known.has(planId)) return sendJSON(res, 400, { error: "未知套餐，请刷新后重试" })
        if (param.length < MIN_PARAM) return sendJSON(res, 400, { error: "验证凭据无效，请重新完成验证" })
        note(`zcode 领取：正在领取 ${planId}`)
        try {
          const env = await submitClaim({ fetchImpl, officialURL, meta, jwt, device, planId, param, region: str(body?.region) })
          if (env.code === 0 || env.code === "0") {
            results.set(planId, { ok: true, name: str(env?.data?.plan?.name) })
            sendJSON(res, 200, { ok: true, message: "已领取" })
          } else {
            const message = claimFailureMessage(Number(env.code) || env.code, env)
            results.set(planId, { ok: false, code: Number(env.code) || env.code, message })
            sendJSON(res, 200, { ok: false, message })
          }
        } catch (e) {
          const message = e?.message ?? String(e)
          results.set(planId, { ok: false, code: -1, message })
          sendJSON(res, 200, { ok: false, message })
        }
        return
      }
      sendJSON(res, 404, { error: "not found" })
    })
  })
  await listen(server, 0, "127.0.0.1")
  const url = `http://127.0.0.1:${server.address().port}/`
  note(`zcode 领取页面：${url}`)

  const close = () => {
    try {
      server.close()
      if (typeof server.closeAllConnections === "function") server.closeAllConnections()
    } catch {}
  }

  const wait = (timeoutMs) =>
    new Promise((resolve) => {
      const t0 = Date.now()
      const settle = () => {
        const resultsOf = (ok) => plans.filter((p) => results.get(p.planId)?.ok === ok).map((p) => ({ planId: p.planId, name: p.name, ...(results.get(p.planId) ?? {}) }))
        resolve({
          claimed: resultsOf(true),
          failed: resultsOf(false),
          scans: state.done ? "done" : "timeout",
        })
      }
      const iv = setInterval(() => {
        if (state.done || (plans.length && plans.every((p) => results.has(p.planId))) || Date.now() - t0 > timeoutMs) {
          clearInterval(iv)
          settle()
        }
      }, 300)
    })

  return { url, wait, close }
}
