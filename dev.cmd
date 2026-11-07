@echo off
setlocal
set "PUPPET_MASTER_PROFILE=workspace"
cd /d "%~dp0"
npm run dev
