@echo off
rem Sets up, or updates, the Media Service on Windows: double-click this file. It runs
rem install-windows.ps1 with -ExecutionPolicy Bypass, because Windows disables scripts by default
rem (which also makes right-click > Run with PowerShell close at once on many PCs); that lifts it
rem for this one run only. The window stays open at the end. Options go to the script, e.g.
rem   install-windows.cmd -PublicUrl https://example.com/ffmpeg
rem   install-windows.cmd -Models "fast,balanced"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" -NoPause %*
set "exitcode=%errorlevel%"
echo.
pause
exit /b %exitcode%
