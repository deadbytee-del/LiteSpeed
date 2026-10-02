@echo off
setlocal EnableExtensions
title LiteSpeed setup
cd /d "%~dp0"

rem ---- settings --------------------------------------------------------------
set "REPO_ZIP=https://github.com/deadbytee-del/LiteSpeed/archive/refs/heads/main.zip"
set "DEFAULT_PAGES=https://deadbytee-del.github.io/LiteSpeed/"
set "PORT=8787"

echo.
echo  ============================================================
echo   LiteSpeed setup
echo  ============================================================
echo.
echo   [1] PUBLIC endpoint  - deploys your own free relay to the
echo       Cloudflare Workers network (needs a free Cloudflare account).
echo       Works from any device, nothing runs on this PC.
echo.
echo   [2] THIS PC only     - runs the relay here on localhost.
echo       Uses your home IP address, which sites such as YouTube
echo       trust far more than a datacentre address.
echo.
set "CHOICE="
set /p "CHOICE=  Choose 1 or 2 [1]: "
if "%CHOICE%"=="" set "CHOICE=1"
if "%CHOICE%"=="2" (set "MODE=local") else (set "MODE=public")

rem ---- Node.js 20 or newer ---------------------------------------------------
where node >nul 2>&1
if not errorlevel 1 goto node_ok
echo.
echo  Node.js was not found. Installing it with winget...
where winget >nul 2>&1
if errorlevel 1 goto no_winget
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>&1
if errorlevel 1 goto node_restart

:node_ok
node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"
if errorlevel 1 goto node_old

rem ---- get the project if this file was downloaded on its own ----------------
if exist "package.json" goto have_project
if exist "LiteSpeed\package.json" goto enter_project
echo.
echo  Downloading LiteSpeed...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing '%REPO_ZIP%' -OutFile 'litespeed.zip'; Expand-Archive -Force 'litespeed.zip' -DestinationPath '.'; if (Test-Path 'LiteSpeed') { Remove-Item -Recurse -Force 'LiteSpeed' }; Rename-Item 'LiteSpeed-main' 'LiteSpeed'; Remove-Item 'litespeed.zip'"
if errorlevel 1 goto download_failed
:enter_project
cd /d "%~dp0LiteSpeed"
:have_project

if "%MODE%"=="local" goto local_mode

rem ============================================================================
rem  PUBLIC: deploy to Cloudflare Workers
rem ============================================================================
echo.
echo  Installing deployment tools (first time only, takes a minute)...
if not exist "node_modules\wrangler" call npm install --no-audit --no-fund
if errorlevel 1 goto npm_failed

echo.
echo  Which GitHub Pages site will use this endpoint?
echo  (Only this site, plus localhost, will be allowed to call your relay.)
set "PAGES="
set /p "PAGES=  Pages URL [%DEFAULT_PAGES%]: "
if "%PAGES%"=="" set "PAGES=%DEFAULT_PAGES%"
for /f "delims=" %%O in ('powershell -NoProfile -Command "([uri]'%PAGES%').GetLeftPart('Authority')"') do set "ORIGIN=%%O"
if "%ORIGIN%"=="" goto bad_pages
set "ORIGINS=%ORIGIN%,http://localhost:%PORT%,http://127.0.0.1:%PORT%"

echo.
echo  Checking your Cloudflare login...
call npx wrangler whoami > "%TEMP%\ls_who.txt" 2>&1
findstr /i /c:"not authenticated" "%TEMP%\ls_who.txt" >nul
if errorlevel 1 goto logged_in
echo  A browser window will open: sign in (or sign up, it is free) and click Allow.
call npx wrangler login
if errorlevel 1 goto login_failed
:logged_in

echo.
echo  Deploying your relay (answer any Cloudflare questions below)...
call npx wrangler deploy --var "LITESPEED_ALLOWED_ORIGINS:%ORIGINS%"
if errorlevel 1 goto deploy_failed

echo.
echo  Confirming the deployment and reading your endpoint address...
call npx wrangler deploy --var "LITESPEED_ALLOWED_ORIGINS:%ORIGINS%" > "%TEMP%\ls_deploy.txt" 2>&1
if errorlevel 1 (
  type "%TEMP%\ls_deploy.txt"
  goto deploy_failed
)

set "ENDPOINT="
for /f "delims=" %%U in ('powershell -NoProfile -Command "$m = Select-String -Path $env:TEMP\ls_deploy.txt -Pattern 'https://[A-Za-z0-9._-]+\.workers\.dev' | Select-Object -First 1; if ($m) { $m.Matches[0].Value }"') do set "ENDPOINT=%%U"
if "%ENDPOINT%"=="" goto no_url

echo.
echo  Waiting for the endpoint to come online...
powershell -NoProfile -Command "$ok=$false; for ($i=0; $i -lt 15 -and -not $ok; $i++) { try { $r = Invoke-RestMethod -UseBasicParsing '%ENDPOINT%/api/health' -TimeoutSec 8; if ($r.name -eq 'litespeed') { $ok=$true } } catch { Start-Sleep -Seconds 2 } }; if ($ok) { exit 0 } else { exit 1 }"
if errorlevel 1 (set "HEALTH=not answering yet - give it a minute and retry") else (set "HEALTH=online")

echo %ENDPOINT%| clip
echo.
echo  ============================================================
echo   Your public LiteSpeed endpoint:
echo.
echo       %ENDPOINT%
echo.
echo   Status: %HEALTH%   (the address is also on your clipboard)
echo.
echo   Allowed to use it: %ORIGIN%
echo.
echo   Use it:  open your Pages site, Settings, "Relay / API endpoint",
echo            paste the address, Save.
echo   Or:      open  %PAGES%?api=%ENDPOINT%
echo.
echo   Good to know:
echo    - Free Cloudflare plan: about 100,000 requests per day.
echo    - Sites like YouTube often refuse datacentre addresses. For
echo      those, run this again and choose [2] (this PC).
echo    - To remove it later: npx wrangler delete litespeed-api
echo  ============================================================
echo.
set "OPEN="
set /p "OPEN=  Open your site with the endpoint set now? [Y/n]: "
if /i "%OPEN%"=="n" goto done
start "" "%PAGES%?api=%ENDPOINT%"
goto done

rem ============================================================================
rem  LOCAL: run the relay on this PC
rem ============================================================================
:local_mode
if not exist "node_modules" (
  echo.
  echo  Installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
)
if errorlevel 1 goto npm_failed
set "HOST=127.0.0.1"
set "LITESPEED_ALLOWED_ORIGINS=*"
echo.
echo  ============================================================
echo   Your LiteSpeed endpoint:   http://localhost:%PORT%
echo.
echo   - Keep this window open while you use it (close it to stop).
echo   - Open http://localhost:%PORT% to use it directly, or paste
echo     the address into Settings on your GitHub Pages site.
echo   - Only this PC can reach it.
echo  ============================================================
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"
node src\server.js
echo.
echo  The server stopped.
goto done

rem ---- error exits ------------------------------------------------------------
:no_winget
echo  winget is not available on this PC.
echo  Install Node.js 20 or newer from https://nodejs.org and run setup.bat again.
goto fail
:node_restart
echo  Node.js was installed, but this window cannot see it yet.
echo  Close this window and run setup.bat again.
goto fail
:node_old
echo  Your Node.js is older than version 20. Install the current LTS from https://nodejs.org and run setup.bat again.
goto fail
:download_failed
echo  Download failed. Check your internet connection and run setup.bat again.
goto fail
:npm_failed
echo  npm install failed. Check your internet connection and run setup.bat again.
goto fail
:bad_pages
echo  That does not look like a URL (example: https://yourname.github.io/LiteSpeed/).
goto fail
:login_failed
echo  Cloudflare login did not complete. Run setup.bat again to retry.
goto fail
:deploy_failed
echo.
echo  The deploy failed (see the messages above). Run setup.bat again after fixing it.
goto fail
:no_url
echo.
echo  The deploy finished but the endpoint address could not be read from the output above.
echo  Look for a line ending in .workers.dev, that is your endpoint.
goto fail

:fail
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
