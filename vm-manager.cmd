@echo off
REM ============================================================
REM  devbox VM Manager - local control panel for QEMU sandbox VMs
REM  Needs Node.js 18.17 or newer. No admin rights, no npm install,
REM  no Hyper-V or WSL. Closing this window stops the manager
REM  (running VMs keep running and are picked up next time).
REM
REM  Arguments are passed through to server.js:
REM    --port <n>   --data <dir>   --no-open   --help
REM ============================================================
setlocal
title devbox VM Manager

REM Find node: PATH first, then the usual install locations.
set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%LOCALAPPDATA%\hermes\node\node.exe" set "NODE=%LOCALAPPDATA%\hermes\node\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo.
  echo   Node.js was not found on this PC.
  echo   Install Node.js 18.17 or newer from https://nodejs.org
  echo   ^(the "LTS" Windows Installer is fine^), then run this launcher again.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0server.js" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo   [ the manager stopped with an error ^(exit code %RC%^) - see the messages above ]
  pause
)
exit /b %RC%
