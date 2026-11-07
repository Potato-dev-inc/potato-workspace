@echo off
setlocal
set "POTATO_WORKSPACE_PROFILE=workspace"
cd /d "%~dp0"
start "" "packages\app\src-tauri\target\debug\puppet_master_app.exe"
