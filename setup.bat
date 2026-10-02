@echo off
setlocal EnableExtensions
title LiteSpeed setup
cd /d "%~dp0"

rem ---- settings --------------------------------------------------------------
set "PORT=8787"
set "REPO_ZIP=https://github.com/deadbytee-del/LiteSpeed/archive/refs/heads/main.zip"

echo.
echo  LiteSpeed - local server setup
echo  ------------------------------

rem ---- 1. Node.js 20 or newer -------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js was not found. Installing it with winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo  winget is not available on this PC.
    echo  Install Node.js 20 or newer from https://nodejs.org and run setup.bat again.
    pause
    exit /b 1
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
  where node >nul 2>&1
  if errorlevel 1 (
    echo  Node.js installed, but this window cannot see it yet.
    echo  Close this window and run setup.bat again.
    pause
    exit /b 1
  )
)

node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"
if errorlevel 1 (
  echo  Your Node.js is older than version 20. Install the current LTS from https://nodejs.org and run setup.bat again.
  pause
  exit /b 1
)

rem ---- 2. Get the project if this file was downloaded on its own --------------
if not exist "package.json" (
  if not exist "LiteSpeed\package.json" (
    echo  Downloading LiteSpeed...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing '%REPO_ZIP%' -OutFile 'litespeed.zip'; Expand-Archive -Force 'litespeed.zip' -DestinationPath '.'; if (Test-Path 'LiteSpeed') { Remove-Item -Recurse -Force 'LiteSpeed' }; Rename-Item 'LiteSpeed-main' 'LiteSpeed'; Remove-Item 'litespeed.zip'"
    if errorlevel 1 (
      echo  Download failed. Check your internet connection and run setup.bat again.
      pause
      exit /b 1
    )
  )
  cd /d "%~dp0LiteSpeed"
)

rem ---- 3. Install dependencies -----------------------------------------------
if not exist "node_modules" (
  echo  Installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo  npm install failed.
    pause
    exit /b 1
  )
)

rem ---- 4. Start the server (listens on this PC only) -------------------------
set "HOST=127.0.0.1"
set "LITESPEED_ALLOWED_ORIGINS=*"

echo.
echo  ============================================================
echo   Your LiteSpeed endpoint:   http://localhost:%PORT%
echo.
echo   - This window must stay open while you use it.
echo   - Use it on its own:       http://localhost:%PORT%
echo   - Or paste the endpoint into Settings on your LiteSpeed
echo     GitHub Pages site (Relay / API endpoint).
echo   - Only this PC can reach it. Close this window to stop.
echo  ============================================================
echo.

start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"
node src\server.js

echo.
echo  The server stopped.
pause
