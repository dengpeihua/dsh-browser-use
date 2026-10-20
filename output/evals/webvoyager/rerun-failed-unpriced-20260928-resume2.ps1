$ErrorActionPreference = 'Stop'
$repo = '<USER_HOME>\Desktop\dsh-browser'
$out = Join-Path $repo 'output\evals\webvoyager-126-concurrency1'
$selectionPath = Join-Path $out 'rerun-failed-unpriced-20260927.json'
$stdoutPath = Join-Path $out 'rerun-failed-unpriced-20260928-resume2.stdout.log'
$stderrPath = Join-Path $out 'rerun-failed-unpriced-20260928-resume2.stderr.log'
$statusPath = Join-Path $out 'rerun-failed-unpriced-20260928-resume2.exit.json'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
try {
  Set-Location -LiteralPath $repo
  $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
  $ids = $selection.task_ids -join ','
  & node 'scripts/eval/run.mjs' --out 'output/evals/webvoyager-126-concurrency1' --data 'assets/benchmark/WebVoyager_data.json' --timeout 600000 --preflight-timeout 60000 --max-rounds 50 --concurrency 1 --reasoning-effort high --judge reference --headed --rerun-ids $ids --allow-protected-rerun 1> $stdoutPath 2> $stderrPath
  $exitCode = $LASTEXITCODE
} catch {
  $_ | Out-String | Add-Content -LiteralPath $stderrPath
  $exitCode = 1
}
@{
  started_at = $startedAt
  ended_at = (Get-Date).ToUniversalTime().ToString('o')
  exit_code = $exitCode
} | ConvertTo-Json | Set-Content -LiteralPath $statusPath
exit $exitCode
