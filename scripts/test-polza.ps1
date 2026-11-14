$ErrorActionPreference = 'Stop'
$apiKey = $null
foreach ($scope in @('Process', 'User')) {
  foreach ($name in @('POLZA_API_KEY', 'POLZA_AI_API_KEY')) {
    $candidate = [Environment]::GetEnvironmentVariable($name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($candidate)) { $apiKey = $candidate.Trim(); break }
  }
  if ($apiKey) { break }
}
if (-not $apiKey) {
  $envPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
  if (Test-Path -LiteralPath $envPath) {
    foreach ($name in @('POLZA_API_KEY', 'POLZA_AI_API_KEY')) {
      $keyLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
      if ($keyLine) {
        $candidate = $keyLine.Substring($name.Length + 1).Trim().Trim('"').Trim("'")
        if (-not [string]::IsNullOrWhiteSpace($candidate)) { $apiKey = $candidate; break }
      }
    }
  }
}
if (-not $apiKey) { throw 'Set POLZA_API_KEY or POLZA_AI_API_KEY in the Windows process or user environment.' }
$env:POLZA_API_KEY = $apiKey
& npx tsx --test tests/polza.integration.test.ts
exit $LASTEXITCODE
