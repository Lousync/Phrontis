@echo off
title Phrontis Dev - v3.5.2
setlocal

set "ROOT=E:\Projects\KnowledgeRecorder-v3.5.2"
cd /d "%ROOT%"

echo ==================================================
echo  Phrontis Dev   v3.5.2   (feature/v3.5.2)
echo  Folder: %ROOT%
echo ==================================================
echo.
echo [Note] Single-instance lock may be shared with the main
echo        repo. Close other Phrontis windows before starting.
echo.

if not exist "%ROOT%\package.json" goto :err_root
if not exist "%ROOT%\node_modules\electron-vite\bin\electron-vite.js" goto :err_deps

set "ELECTRON_RUN_AS_NODE="

set "NODE_EXE="
if exist "D:\develp\Nodejs\node.exe" set "NODE_EXE=D:\develp\Nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE goto :err_node

for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

echo [Run] "%NODE_EXE%" scripts\start-desktop.js
echo.
"%NODE_EXE%" scripts\start-desktop.js
set "RC=%ERRORLEVEL%"

echo.
echo [Exit] code = %RC%
pause >nul
exit /b %RC%

:err_node
echo   [xx] Node.js not found.
echo        Install Node LTS, or edit NODE_EXE in this file.
pause >nul
exit /b 1

:err_deps
echo   [xx] Missing dependencies: node_modules\electron-vite
echo        Run once:  cd /d "%ROOT%"  ^&^&  npm install
pause >nul
exit /b 1

:err_root
echo   [xx] Project root not found: %ROOT%
echo        Recreate the worktree:
echo          git -C E:\Projects\KnowledgeRecorder worktree add "%ROOT%" -b feature/v3.5.2 b58705e
pause >nul
exit /b 1
