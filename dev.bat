@echo off
title Phrontis Dev - UI rework worktree (feature/ui-rework)
cd /d E:\Projects\KnowledgeRecorder-ui-rework

echo ==================================================
echo  Phrontis Dev (worktree: UI rework)
echo  Branch : feature/ui-rework
echo  Folder : E:\Projects\KnowledgeRecorder-ui-rework
echo ==================================================
echo.
echo [Note] The app uses a single-instance lock. If another
echo        instance (main worktree) is running, this one
echo        will just hand focus over. Close it first.
echo.

if not exist node_modules (
  echo [Setup] First run - installing dependencies...
  call npm install --no-audit --no-fund
)

call npm run dev
pause
