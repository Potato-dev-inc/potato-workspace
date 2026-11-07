@echo off
setlocal
set "PUPPET_MASTER_PROFILE=workspace"
cd /d "%~dp0"
start "" "packages\app\src-tauri\target\debug\puppet_master_app.exe"
