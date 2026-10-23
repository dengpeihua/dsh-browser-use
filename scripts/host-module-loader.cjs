// Use an installed host's DSH packages without changing the plugin's dependencies.
// For packaged desktop hosts, run with their Electron executable in Node mode.
const { registerHooks } = require("node:module")
const { resolve } = require("node:path")
const { pathToFileURL } = require("node:url")

if (!process.env.DSH_TEST_HOST_ROOT) throw new Error("Set DSH_TEST_HOST_ROOT to the host directory containing node_modules")
const parentURL = pathToFileURL(resolve(process.env.DSH_TEST_HOST_ROOT, "host-test.mjs")).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, specifier.startsWith("@deepseek-ai/") ? { ...context, parentURL } : context)
  },
})
