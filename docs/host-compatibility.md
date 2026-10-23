# Browser context compatibility

Browser-generated messages use producer-owned source kinds: `dsh-browser:recovery`,
`dsh-browser:evidence-record`, `dsh-browser:fact-record`, `dsh-browser:task-memory`,
and `dsh-browser:state-change`. DSH format v4 rejects the old generic `plugin` kind.
Readers still accept legacy v3 browser sources so historical facts and evidence
remain usable. Existing message provenance and surface replacement semantics stay intact.

The pre-step listener logs context preparation failures and allows the Agent Loop
to continue. It does not roll back context edits already completed before a failure.
Cancellation, downstream pre-step failures, and the repeated-access-failure stop
condition still propagate.

## Regression checks

`npm test` covers the six context write paths, archive replay, legacy reads, and
context failure/cancellation behavior. `npm run test:host` uses real Chromium and
the repository's pinned DSH Agent Loop with deterministic model decisions.
It includes a local HTTP server that is stopped before `browser_refresh`, checks
the resulting error-page URL notice, and verifies that another step starts.

To test an installed DSH desktop host, build first and run with its Electron
executable in Node mode (Node 22.15+ is needed for `registerHooks`). Example on Windows:

```powershell
npm run build
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_TEST_HOST_ROOT = 'D:\DeepSeek Harness\resources\app.asar\dsh'
$env:DSH_TEST_V4_CODEC = '@deepseek-ai/dsh-session-format-v3-to-v4'
& 'D:\DeepSeek Harness\DeepSeek Harness.exe' --require ./scripts/host-module-loader.cjs --test test/browser-message-source.test.mjs | Out-Host
& 'D:\DeepSeek Harness\DeepSeek Harness.exe' --require ./scripts/host-module-loader.cjs scripts/smoke-host.mjs | Out-Host
Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:DSH_TEST_HOST_ROOT, Env:DSH_TEST_V4_CODEC
```

Adjust the installation path to your host. The loader resolves all `@deepseek-ai/*`
imports from that installation, including imports made by the plugin. When
`DSH_TEST_V4_CODEC` is set, the source regression checks real v4 encoding and
rejection of legacy source shapes; the host smoke encodes every generated event.
These checks use isolated in-memory Sessions and local fixture pages. They do not
modify desktop conversations, call a paid model, or exercise desktop UI interactions.

After rebuilding a locally linked plugin, restart the host when no task is running
to load the new code in the desktop process.
