# Packs the package to a local NuGet folder feed and registers that feed as a source,
# so any project on this machine can install it with `dotnet add package`.
#
# Usage (from the repo root, in PowerShell):
#   .\test\pack-local.ps1
#
# Note: NuGet's "global-packages" folder (%userprofile%\.nuget\packages) is a *cache*, not a
# feed — you don't copy .nupkg files into it directly. You publish to a folder feed (below);
# NuGet then extracts into global-packages automatically on the first restore.

param(
    [string]$Feed = (Join-Path $env:USERPROFILE 'LocalNuget'),
    [string]$SourceName = 'LocalFeed'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $repo 'src\Lait.Umbraco.UI.ScrollToField\Lait.Umbraco.UI.ScrollToField.csproj'

New-Item -ItemType Directory -Force -Path $Feed | Out-Null

Write-Host "==> Packing to $Feed" -ForegroundColor Cyan
dotnet pack $proj -c Release -o $Feed

# Register the local feed as a NuGet source (once).
$alreadyRegistered = (dotnet nuget list source) -match [regex]::Escape($Feed)
if (-not $alreadyRegistered) {
    Write-Host "==> Registering NuGet source '$SourceName' -> $Feed" -ForegroundColor Cyan
    dotnet nuget add source $Feed -n $SourceName
} else {
    Write-Host "==> NuGet source already points at $Feed" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. In any Umbraco 17 site:" -ForegroundColor Green
Write-Host "  dotnet add package Lait.Umbraco.UI.ScrollToField" -ForegroundColor Green
Write-Host ""
Write-Host "Iterating? Bump <Version> in the .csproj before re-packing, otherwise clear the cached copy:" -ForegroundColor Yellow
Write-Host "  dotnet nuget locals global-packages --clear" -ForegroundColor Yellow
