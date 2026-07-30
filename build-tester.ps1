$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$distRoot = Join-Path $projectRoot 'dist'
$packageRoot = Join-Path $distRoot 'tester-package'
$extensionRoot = Join-Path $packageRoot 'Gmail-Flow-Tester'
$localManifest = Join-Path $projectRoot 'manifest.json'

$testerClientId = '1055778436707-sqrmr27b3a7iat6760kj1fvqdnlhaitv.apps.googleusercontent.com'
$testerPublicKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvj8/M6ut/6iiyUJPz+ThhzV1RsA24yBA6uyPE3XHe2HvWD3Zq1tufCWZbOOjdn5gR2Hntj1t+U5O2kwUfcc5fpG2EBpC+dAXgptR6qM5L3LJOASBAE02CyHUTmtO4kSi+Bi59wf7UKxUustq6V6zXhU4c52Hiq+YN1ntVSH54nOquxpMGkVFJhtjJNdSGvC8iO3j03MLrzlmyGRk7uGuoRPHMeMPZYrxIr6QOnm9hoCK7FNw+6FuWR3+ihKyFcLdd95xS/D/VC7tu/3K5kAXIj6VMLNlYT4HP/1aS6gfW2raE4yKS7+9qmbrCQVA8lcuuOr1mwoT+BwzpNv0s7qZHwIDAQAB'

$manifest = [System.IO.File]::ReadAllText($localManifest) | ConvertFrom-Json
$manifest.name = 'Gmail Flow Tester'
$manifest.oauth2.client_id = $testerClientId
$manifest | Add-Member -NotePropertyName 'key' -NotePropertyValue $testerPublicKey -Force

$version = $manifest.version
$archivePath = Join-Path $distRoot "Gmail-Flow-v$version-tester.zip"

if (Test-Path -LiteralPath $packageRoot) {
  Remove-Item -Recurse -Force -LiteralPath $packageRoot
}

New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null

$runtimeFiles = @(
  'background.js',
  'core.js',
  'popup.html',
  'popup.js',
  'styles.css'
)

foreach ($file in $runtimeFiles) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $extensionRoot
}

Copy-Item -Recurse -LiteralPath (Join-Path $projectRoot 'icons') -Destination $extensionRoot

$manifestJson = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText(
  (Join-Path $extensionRoot 'manifest.json'),
  $manifestJson,
  [System.Text.UTF8Encoding]::new($false)
)

Copy-Item -LiteralPath (Join-Path $projectRoot 'TESTER_INSTALL.txt') -Destination (Join-Path $packageRoot 'INSTALL-KO.txt')

if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -Force -LiteralPath $archivePath
}

Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $archivePath
Remove-Item -Recurse -Force -LiteralPath $packageRoot

Write-Output $archivePath
