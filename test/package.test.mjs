import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { satisfies } from "semver"

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")
const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8")
const expectedPackageDocumentation = ["AGENTS.md", "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "assets/benchmark/judge-prompt.md", "docs/evaluation.md", "docs/evidence.md", "docs/reliability.md"]
const expectedRepositoryDocumentation = expectedPackageDocumentation

async function findDocumentation(directory, prefix = "") {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "output"].includes(entry.name)) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...await findDocumentation(new URL(`${entry.name}/`, directory), relative))
    } else if (entry.name.endsWith(".md") || entry.name === "LICENSE") {
      found.push(relative)
    }
  }
  return found
}

test("repository keeps standard documentation and the published reliability guide", async () => {
  const documentation = await findDocumentation(new URL("../", import.meta.url))
  assert.deepEqual(documentation.sort(), expectedRepositoryDocumentation)
})

test("package is a self-contained DSH web bundle", () => {
  assert.equal(packageJson.dsh.bundle.patch, "./cordis.patch.yml")
  assert.deepEqual(packageJson.dsh.marketplace, {
    profiles: ["web"],
    requiresBuildApproval: false,
    requiresRestart: true,
    manualSteps: false,
  })
  assert.equal(packageJson.scripts.prepack, "npm run build")
  assert.match(patch, new RegExp(`name: ['\"]?${packageJson.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['\"]?`))
})

test("package dependencies never point at a local Harness checkout", () => {
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const [name, specifier] of Object.entries(packageJson[field] ?? {})) {
      assert.doesNotMatch(specifier, /^(?:file:|link:|workspace:)/, `${field}.${name}`)
    }
  }
})

test("DSH peers require the verified host surface-replacement contract", () => {
  const dshPeers = [
    "@deepseek-ai/dsh-attachment",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-system-prompt",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/dsh-user-approval",
    "@deepseek-ai/dsh-agent",
    "@deepseek-ai/dsh-llm",
  ]
  for (const name of dshPeers) {
    const range = packageJson.peerDependencies[name]
    assert.equal(satisfies("0.1.1-rc.2", range), false, `${name} must not advertise an unverified old host`)
    assert.equal(satisfies("0.1.2-alpha.2", range), true, `${name} must support the locked host`)
  }
})

test("installation docs use the published DSH launcher instead of a Harness checkout", () => {
  assert.match(readme, /npx @deepseek-ai\/dsh@0\.1\.2-alpha\.2 plugin --profile web add/)
  assert.match(readme, /npx @deepseek-ai\/dsh@0\.1\.2-alpha\.2 web/)
  assert.match(readme, /尚未发布到 npm/)
  assert.match(readme, /npm install --global pnpm/)
  assert.doesNotMatch(readme, /(?:Set-Location|cd)\s+[^\r\n]*deepseek-harness/i)
  assert.doesNotMatch(readme, /(?:file|link|workspace):[^\r\n]*deepseek-harness/i)
})

test("npm package never contains the local Harness checkout", () => {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm"
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"]
    : ["pack", "--dry-run", "--json", "--ignore-scripts"]
  const packed = spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  })
  assert.ifError(packed.error)
  assert.equal(packed.status, 0, packed.stderr)
  const [{ files }] = JSON.parse(packed.stdout)
  const paths = files.map(file => file.path)
  assert.ok(paths.includes("lib/index.js"))
  assert.ok(paths.includes("cordis.patch.yml"))
  assert.ok(paths.includes("package.json"))
  const documentation = paths
    .filter(path => path.endsWith(".md") || path === "LICENSE")
    .sort()
  assert.deepEqual(documentation, expectedPackageDocumentation)
  assert.equal(paths.some(path => path.startsWith("deepseek-harness/")), false)
  assert.equal(paths.some(path => path.startsWith("node_modules/")), false)
})
