import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { once } from "node:events"
import { readJson } from "./core.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const { values: flags } = parseArgs({ options: {
  out: { type: "string" },
  data: { type: "string", default: "assets/benchmark/webvoyager-126.json" },
  execute: { type: "boolean" },
  help: { type: "boolean" },
} })

if (flags.help) {
  console.log("Audit or backfill only missing trajectories in an existing evaluation run.")
  console.log("Usage: npm run eval:backfill -- --out output/evals/RUN [--data assets/benchmark/webvoyager-126.json] [--execute]")
  console.log("Without --execute this is a read-only plan. Existing manifest tasks are protected from rerun and rejudging.")
  process.exit(0)
}
if (!flags.out) throw new Error("--out is required")

const output = resolve(root, flags.out)
const manifest = readJson(resolve(output, "manifest.json"))
const args = [
  resolve(root, "scripts/eval/run.mjs"),
  "--backfill-missing",
  "--out", output,
  "--data", resolve(root, flags.data),
  "--timeout", String(manifest.settings.timeout),
  "--preflight-timeout", String(manifest.settings.preflightTimeout),
  "--max-rounds", String(manifest.settings.maxRounds),
  "--concurrency", String(manifest.concurrency),
  "--judge", manifest.judge_mode,
]
if (manifest.settings.headed) args.push("--headed")
if (manifest.agent?.reasoningEffort) args.push("--reasoning-effort", manifest.agent.reasoningEffort)
if (!flags.execute) args.push("--dry-run")

const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true, stdio: "inherit" })
const [code, signal] = await once(child, "close")
if (signal) throw new Error(`Backfill runner terminated by ${signal}`)
process.exitCode = code ?? 1
