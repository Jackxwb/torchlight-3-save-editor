@echo off
cls
rem ---------------------------------------------------------------
rem  Torchlight 3 save editor - local UI launcher
rem  Requires Node.js. No npm install needed (zero dependencies).
rem ---------------------------------------------------------------
cd /d %~dp0..
if not exist "ui\server.js" (
  echo [ERROR] ui\server.js not found. Run this bat inside the project folder.
  pause
  exit /b 1
)
node ui\server.js
if errorlevel 1 (
  echo.
  echo [ERROR] server exited. Make sure Node.js is installed ^(node -v^).
  pause
)
