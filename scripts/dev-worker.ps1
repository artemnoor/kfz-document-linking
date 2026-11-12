$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$devVarsPath = Join-Path $repoRoot '.dev.vars'
$apiKey = [Environment]::GetEnvironmentVariable('POLZA_API_KEY', 'Process')
if (-not $apiKey) { $apiKey = [Environment]::GetEnvironmentVariable('POLZA_AI_API_KEY', 'Process') }
if (-not $apiKey) { $apiKey = [Environment]::GetEnvironmentVariable('POLZA_API_KEY', 'User') }
if (-not $apiKey) { $apiKey = [Environment]::GetEnvironmentVariable('POLZA_AI_API_KEY', 'User') }

$envFile = $null
try {
  if ($apiKey) {
    $lines = if (Test-Path -LiteralPath $devVarsPath) { @(Get-Content -LiteralPath $devVarsPath) } else { @() }
    $lines = @($lines | Where-Object { $_ -notmatch '^(POLZA_API_KEY|LLM_ENABLED)=' })
    $lines += "POLZA_API_KEY=$apiKey"
    $lines += 'LLM_ENABLED=true'
    $envFile = Join-Path ([IO.Path]::GetTempPath()) "kfz-document-linking-$([guid]::NewGuid().ToString('N')).env"
    [IO.File]::WriteAllText($envFile, ($lines -join "`n"), [Text.UTF8Encoding]::new($false))
    & npx wrangler dev --local --env local --ip 127.0.0.1 --port 8791 --env-file $envFile
  } else {
    Write-Warning 'POLZA_API_KEY / POLZA_AI_API_KEY is not set in the Windows process or user environment. Linking requests will return an explicit configuration error.'
    & npx wrangler dev --local --env local --ip 127.0.0.1 --port 8791
  }
  exit $LASTEXITCODE
} finally {
  if ($envFile -and (Test-Path -LiteralPath $envFile)) { [IO.File]::Delete($envFile) }
}
