@echo off
title Phrontis Dev (feature/v3.4.0)
cd /d E:\Projects\KnowledgeRecorder

echo ==================================================
echo  Phrontis Dev
echo  Branch : feature/v3.4.0
echo  Folder : E:\Projects\KnowledgeRecorder
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
