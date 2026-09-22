@echo off
rem ===========================================================
rem  Phrontis one-click launcher -- canonical copy, in version control.
rem  The desktop shortcut is a thin wrapper that calls this file.
rem
rem  TWO RULES FOR ANYONE EDITING THIS FILE. Both were learned the
rem  hard way on this project; breaking either one makes the script
rem  fail in ways that look like "the script is fine but nothing
rem  happens":
rem
rem   1) Line endings MUST be CRLF. With LF-only endings cmd.exe
rem      resyncs its read offset in the middle of a line and then
rem      executes fragments of the text as if they were commands.
rem
rem   2) Text MUST stay ASCII. A console here runs in the OEM
rem      codepage, and Chinese inside a .bat corrupts the parser in
rem      BOTH utf-8 and gbk files. Chinese user-facing messages live
rem      in start-desktop.js instead, where node prints them right.
rem ===========================================================
setlocal

rem --- 1. Locate node.exe --------------------------------------
rem Why this is not a bare "node": a console launched from Explorer
rem only inherits the PATH stored in the registry. A portable / zip
rem Node install is not registered there, so the bare command dies
rem with
rem     'node' is not recognized as an internal or external command
rem and the window parks at "press any key" -- which is exactly the
rem "double-clicking the launcher does nothing" symptom.
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"

if not defined NODE_EXE (
  for %%D in (
    "%ProgramFiles%\nodejs"
    "%ProgramFiles(x86)%\nodejs"
    "%LOCALAPPDATA%\Programs\nodejs"
    "%APPDATA%\nvm\current"
    "%USERPROFILE%\scoop\apps\nodejs\current"
  ) do if not defined NODE_EXE if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
)

rem Fallback for a machine-local install: scripts\node-path.local.txt
rem holds the folder of the node install on one line. Git-ignored on
rem purpose -- an absolute machine path must not enter version control.
if not defined NODE_EXE if exist "%~dp0node-path.local.txt" (
  for /f "usebackq delims=" %%L in ("%~dp0node-path.local.txt") do (
    if not defined NODE_EXE if exist "%%~L\node.exe" set "NODE_EXE=%%~L\node.exe"
  )
)

if not defined NODE_EXE (
  echo [launcher] Node.js not found.
  echo [launcher] Either put its folder on PATH, or write that folder
  echo [launcher] on a single line into scripts\node-path.local.txt
  echo [launcher] Example: D:\develp\Nodejs
  pause
  exit /b 1
)

rem --- 2. Run from the repository this script lives in ----------
rem %~dp0 is the ...\scripts\ folder, so ".." is the repo root. This
rem makes the launcher self-locating: a worktree copy starts its own
rem worktree instead of a hard-coded path (the previous version always
rem cd'd into the main checkout).
cd /d "%~dp0.."

"%NODE_EXE%" "scripts\start-desktop.js"
if errorlevel 1 pause
