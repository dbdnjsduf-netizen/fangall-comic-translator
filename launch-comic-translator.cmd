@echo off
setlocal

cd /d "%~dp0"

set PORT=3344
set URL=http://127.0.0.1:%PORT%

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 goto no_node

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if %ERRORLEVEL% NEQ 0 goto install_failed
)

echo Starting server...
start "" /min cmd /c "cd /d ""%~dp0"" && node server.mjs > launch.log 2>&1"

echo Opening browser...
timeout /t 5 /nobreak >nul
start "" "%URL%"
goto end

:no_node
echo Node.js is not installed.
pause
exit /b 1

:install_failed
echo npm install failed.
pause
exit /b 1

:end
exit /b 0
