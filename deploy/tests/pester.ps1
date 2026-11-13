# PSScriptAnalyzer and Pester for the Windows installer (install-windows.ps1); installs both if
# missing. deploy/tests/run.sh runs it in Linux with PowerShell 7; CI runs it on Windows with
# Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$deploy = Split-Path -Parent $PSScriptRoot

function Install-TestModule([string]$Name, [version]$Minimum) {
    if (Get-Module -ListAvailable $Name | Where-Object { $_.Version -ge $Minimum }) { return }
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        # Windows PowerShell needs the NuGet provider before it can install from the gallery.
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force | Out-Null
    }
    Install-Module $Name -MinimumVersion $Minimum -Scope CurrentUser -Force -SkipPublisherCheck -AllowClobber
}

Install-TestModule Pester '5.5.0'
Install-TestModule PSScriptAnalyzer '1.21.0'
Import-Module Pester -MinimumVersion '5.5.0'
Write-Output "--- PowerShell $($PSVersionTable.PSVersion)"

Write-Output '--- PSScriptAnalyzer'
$files = @((Join-Path $deploy 'install-windows.ps1')) + @(Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' | ForEach-Object FullName)
$issues = @($files | ForEach-Object { Invoke-ScriptAnalyzer -Path $_ -Severity Warning, Error })
if ($issues.Count -gt 0) {
    $issues | Format-Table RuleName, ScriptName, Line, Message -AutoSize -Wrap | Out-String -Width 200
    throw "PSScriptAnalyzer found $($issues.Count) issue(s)."
}
Write-Output 'no issues'

Write-Output '--- Pester'
$config = New-PesterConfiguration
$config.Run.Path = (Join-Path $PSScriptRoot 'install-windows.Tests.ps1')
$config.Run.Exit = $true
$config.Output.Verbosity = 'Detailed'
Invoke-Pester -Configuration $config
