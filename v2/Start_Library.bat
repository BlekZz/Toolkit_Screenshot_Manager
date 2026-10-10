@echo off
REM Photo Library v2 launcher. Library lives outside the repo (see dev/Sprint_Photo_Library_v2.md).
cd /d "%~dp0"
if "%PHOTO_LIBRARY%"=="" set "PHOTO_LIBRARY=D:\PhotoLibrary"
if not exist node_modules call npm install
if not exist dist call npm run build
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3040"
node server\index.mjs
pause
