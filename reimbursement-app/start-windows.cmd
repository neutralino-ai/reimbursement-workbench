@echo off
setlocal
cd /d "%~dp0"
set "REIMBURSE_NODE=node"
where node.exe >nul 2>nul
if errorlevel 1 set "REIMBURSE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%REIMBURSE_NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
set "REIMBURSE_LAUNCH_SCRIPT=%~dp0scripts\open-workbench.mjs"
set "REIMBURSE_LAUNCH_DIR=%~dp0"
powershell.exe -NoProfile -Command "Start-Process -FilePath $env:REIMBURSE_NODE -ArgumentList ([string][char]34 + $env:REIMBURSE_LAUNCH_SCRIPT + [char]34) -WorkingDirectory $env:REIMBURSE_LAUNCH_DIR -WindowStyle Hidden"
if errorlevel 1 (
  echo Unable to start the frontend. Run node scripts/open-workbench.mjs to inspect the error.
  pause
)
