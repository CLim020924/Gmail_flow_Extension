$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$distRoot = Join-Path $projectRoot 'dist'
$stageRoot = Join-Path $distRoot 'webstore-staging'
$localManifest = Join-Path $projectRoot 'manifest.json'
$webStoreClientId = '1055778436707-d0mf03fgja6s9bgpmtltmmd9nt04lsdo.apps.googleusercontent.com'

$manifest = [System.IO.File]::ReadAllText($localManifest) | ConvertFrom-Json
$manifest.oauth2.client_id = $webStoreClientId
$version = $manifest.version
$archivePath = Join-Path $distRoot "Gmail-Flow-v$version-webstore.zip"

if (Test-Path -LiteralPath $stageRoot) {
  Remove-Item -Recurse -Force -LiteralPath $stageRoot
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

$runtimeFiles = @(
  'background.js',
  'core.js',
  'desktop-shim.js',
  'popup.html',
  'popup.js',
  'styles.css'
)

foreach ($file in $runtimeFiles) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $stageRoot
}

Copy-Item -Recurse -LiteralPath (Join-Path $projectRoot 'icons') -Destination $stageRoot
$manifestJson = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText(
  (Join-Path $stageRoot 'manifest.json'),
  $manifestJson,
  [System.Text.UTF8Encoding]::new($false)
)

if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -Force -LiteralPath $archivePath
}

Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $archivePath
Remove-Item -Recurse -Force -LiteralPath $stageRoot

Write-Output $archivePath
