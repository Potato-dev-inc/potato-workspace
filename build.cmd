@echo off
setlocal
set "POTATO_WORKSPACE_PROFILE=workspace"
cd /d "%~dp0"
npm run build --workspace=@potato-workspace/app || exit /b 1
cargo build --manifest-path packages\app\src-tauri\Cargo.toml || exit /b 1
echo Built target\debug\puppet_master_app.exe - start it with run.cmd
