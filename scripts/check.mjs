// Loads the plugin the way magpie and OpenCode do and checks the shape of
// what it returns. It signs in to nothing, reads no zcode-switch account and
// sends no request.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const tmp = mkdtempSync(join(tmpdir(), "zsw-check-"))
process.env.ZCODE_SWITCH_HOME = tmp

const problems = []
try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  if (!pkg.name) problems.push("package.json has no name")
  if (!pkg.magpie || typeof pkg.magpie !== "object") problems.push("package.json has no magpie metadata")
  if (!pkg.main) problems.push("package.json has no main")

  const mod = await import(pathToFileURL(join(root, pkg.main ?? "src/index.mjs")).href)
  const fns = Object.values(mod).filter((v) => typeof v === "function")
  if (fns.length !== 1) problems.push(`expected one plugin function, found ${fns.length}`)
  const client = {
    app: { log: async () => {} },
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
    config: { get: async () => ({ data: {} }) },
  }
  for (const fn of fns) {
    const hooks = await fn({ client, directory: root, worktree: root, project: { id: "magpie" } })
    const auth = hooks?.auth
    if (!auth) {
      problems.push(`${fn.name}: no auth hook`)
      continue
    }
    if (auth.provider !== "zcode") problems.push(`auth.provider is ${auth.provider}`)
    if (typeof auth.loader !== "function") problems.push("auth.loader is not a function")
    if (!Array.isArray(auth.methods) || auth.methods.length < 5) {
      problems.push(`auth.methods is short: ${Array.isArray(auth.methods) ? auth.methods.length : "none"} of at least 5`)
    }
    for (const m of auth.methods ?? []) {
      if (!["oauth", "api"].includes(m.type)) problems.push(`${m.label}: method type ${m.type}`)
      if (m.type === "oauth" && typeof m.authorize !== "function") problems.push(`${m.label}: no authorize`)
      if (m.type === "api" && m.prompts?.some((p) => !["text", "select", "password"].includes(p.type)))
        problems.push(`${m.label}: unknown prompt type`)
    }
    if (!hooks.config) problems.push("no config hook")
    else {
      const cfg = { provider: {} }
      await hooks.config(cfg)
      const p = cfg.provider.zcode
      if (!p?.npm) problems.push("config gives zcode no npm")
      if (!p?.models || !Object.keys(p.models).length) problems.push("config gives zcode no models")
    }
    if (!hooks.provider || hooks.provider.id !== "zcode" || typeof hooks.provider.models !== "function")
      problems.push("no provider.models hook")
  }
} catch (e) {
  problems.push(String(e?.stack ?? e))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (problems.length) {
  console.error("✗ magpie-zcode-switch-auth\n  " + problems.join("\n  "))
  process.exit(1)
}
console.log("✓ magpie-zcode-switch-auth")
