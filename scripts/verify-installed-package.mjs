import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-browser-installed-package-"))
const npmCli = process.env.npm_execpath

if (!npmCli) {
  throw new Error("verify-installed-package must be launched through npm run")
}

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

try {
  const packedFilename = npm(["pack", "--silent", "--pack-destination", temporaryRoot], root)
    .trim()
    .split(/\r?\n/)
    .at(-1)
  assert.ok(packedFilename, "npm pack did not return a tarball filename")
  const tarball = join(temporaryRoot, packedFilename)
  const consumer = join(temporaryRoot, "consumer")
  const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"))
  const hostDependencies = Object.fromEntries(
    Object.entries(lockfile.packages)
      .filter(([path, metadata]) => path.startsWith("node_modules/@deepseek-ai/") && metadata.version)
      .map(([path, metadata]) => [path.slice("node_modules/".length), metadata.version]),
  )
  await mkdir(consumer)
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      ...hostDependencies,
      "dsh-browser-plugin": `file:${tarball.replaceAll("\\", "/")}`,
    },
  }, null, 2)}\n`)
  npm([
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
  ], consumer)

  const installedRoot = join(consumer, "node_modules", "dsh-browser-plugin")
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"))
  const bundlePatch = await readFile(join(installedRoot, "cordis.patch.yml"), "utf8")
  const plugin = await import(pathToFileURL(join(installedRoot, "lib", "index.js")))

  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml")
  assert.match(bundlePatch, /name:\s*dsh-browser-plugin/)
  assert.equal(plugin.name, "dsh-browser")
  assert.equal(plugin.TOOL_IDS.length, 17)
  const diagnostics = await import(pathToFileURL(join(installedRoot, manifest.exports["./diagnostics"].default)))
  assert.equal(typeof diagnostics.captureDomTape, "function")
  assert.equal(typeof diagnostics.replayDomTape, "function")
  assert.equal(typeof plugin.recordBrowserFacts, "function")
  console.log("verify-installed-package: tarball installed and imported successfully (17 tools and diagnostics).")
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
