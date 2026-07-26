@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "PORT=3344"
set "URL=http://127.0.0.1:%PORT%"

if exist "%~dp0runtime\node\node.exe" (
  set "PATH=%~dp0runtime\node;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 goto no_node

where npm >nul 2>nul
if errorlevel 1 goto no_npm

if not exist "node_modules\openai-oauth\package.json" (
  echo.
  echo [1/3] 필요한 프로그램 파일을 설치합니다. 첫 실행에는 몇 분 걸릴 수 있습니다.
  call npm install
  if errorlevel 1 goto install_failed
) else (
  echo [1/3] 프로그램 파일 확인 완료
)

echo [2/3] Codex 로그인 상태를 확인합니다.
where codex >nul 2>nul
if errorlevel 1 goto check_login_with_npx

call codex login status >nul 2>nul
if not errorlevel 1 goto login_ready

echo.
echo Codex 로그인이 필요합니다. 브라우저 안내에 따라 로그인해 주세요.
call codex login
if errorlevel 1 goto login_failed
goto login_ready

:check_login_with_npx
call npx -y @openai/codex login status >nul 2>nul
if not errorlevel 1 goto login_ready

echo.
echo Codex 로그인이 필요합니다. 브라우저 안내에 따라 로그인해 주세요.
call npx -y @openai/codex login
if errorlevel 1 goto login_failed

:login_ready
echo [3/3] 판갤 만화번역기를 시작합니다.

powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:%PORT%/api/shutdown | Out-Null } catch {}"
timeout /t 1 /nobreak >nul

start "판갤 만화번역기" /min cmd /c "cd /d ""%~dp0"" && node server.mjs > translator-server.log 2>&1"
timeout /t 5 /nobreak >nul
start "" "%URL%"
exit /b 0

:no_node
echo.
echo Node.js 20 이상이 필요합니다.
echo https://nodejs.org/ 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
start "" "https://nodejs.org/"
pause
exit /b 1

:no_npm
echo.
echo npm을 찾을 수 없습니다. Node.js LTS를 다시 설치해 주세요.
pause
exit /b 1

:install_failed
echo.
echo npm install에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요.
pause
exit /b 1

:login_failed
echo.
echo Codex 로그인을 완료하지 못했습니다. 다시 실행해 주세요.
pause
exit /b 1
