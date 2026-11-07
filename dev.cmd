@echo off
setlocal
set "POTATO_WORKSPACE_PROFILE=workspace"
cd /d "%~dp0"
npm run dev
