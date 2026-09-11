@echo off
REM ============================================================
REM  devbox VM Manager - opens a local control panel in your browser
REM  Backend: Node (bundled with Hermes), standard library only.
REM  No admin rights, no Hyper-V, no WSL, no npm install needed.
REM ============================================================
setlocal
title devbox VM Manager

set NODE=%LOCALAPPDATA%\hermes\node\node.exe
if not exist "%NODE%" set NODE=node

cd /d "%~dp0"

"%NODE%" server.js

echo.
echo [ manager stopped - the browser page will no longer update ]
timeout /t 20 /nobreak >nul
