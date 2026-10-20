import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const plan = args => JSON.parse(execFileSync(process.execPath, ["scripts/eval/run.mjs", "--dry-run", "--count", "1", ...args], { cwd: root, encoding: "utf8" }))

test("evaluation defaults to webvoyager while allowing an explicit output directory", () => {
  assert.equal(plan([]).output_directory, resolve(root, "output/evals/webvoyager"))
  assert.equal(plan(["--out", "output/evals/custom-run"]).output_directory, resolve(root, "output/evals/custom-run"))
})
