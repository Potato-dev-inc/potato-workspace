#!/usr/bin/env bash
# Builds the app-only MSI (the app without Node, Git and cloudflared) from the SAME exe a full `tauri build --bundles msi`
# just made. No Rust recompile: `tauri bundle` only packs the files again with tauri.app-only.conf.json.
# See docs/features/app-only-updates.md.
#
#   bash scripts/build-app-only-msi.sh <full-out-folder> <app-only-out-folder>
#
# Run it from the repo root, right after the full build, with the same environment (CARGO_TARGET_DIR, RUSTFLAGS,
# TAURI_SIGNING_PRIVATE_KEY and _PASSWORD). It:
#   1. moves the full MSI and its .sig out of the bundle folder (the app-only MSI gets the same file name there);
#   2. runs `tauri bundle --bundles msi --config src-tauri/tauri.app-only.conf.json`;
#   3. moves the app-only MSI and its .sig to <app-only-out-folder>;
#   4. checks both MSIs (scripts/check-msi-contents.mjs): tools only in the full one, app-only under 60 MB.
# Exit 0: both folders are ready. Exit 1: the app-only step failed (the caller prints APP-ONLY SKIPPED and ships the full
# MSI alone; the full MSI is already safe in <full-out-folder>).
set -u
FULL_OUT="${1:?folder for the full MSI and its .sig}"
APP_OUT="${2:?folder for the app-only MSI and its .sig}"
cd "$(dirname "$0")/.." || exit 1

V=$(node -p "require('./packages/app/src-tauri/tauri.conf.json').version") || exit 1
TARGET="${CARGO_TARGET_DIR:-packages/app/src-tauri/target}"
BUNDLE="$TARGET/release/bundle/msi"
NAME="Potato Workspace_${V}_x64_en-US.msi"

[ -f "$BUNDLE/$NAME" ] && [ -f "$BUNDLE/$NAME.sig" ] || { echo "no full MSI + .sig for $V in $BUNDLE (run the full build first)"; exit 1; }
mkdir -p "$FULL_OUT" "$APP_OUT" || exit 1
mv -f "$BUNDLE/$NAME" "$BUNDLE/$NAME.sig" "$FULL_OUT/" || exit 1

echo "== app-only bundle (same exe, no tools)"
if ! npm run tauri -- bundle --bundles msi --config src-tauri/tauri.app-only.conf.json; then
  echo "tauri bundle failed"; exit 1
fi
[ -f "$BUNDLE/$NAME" ] && [ -f "$BUNDLE/$NAME.sig" ] || { echo "tauri bundle made no MSI + .sig"; exit 1; }
mv -f "$BUNDLE/$NAME" "$BUNDLE/$NAME.sig" "$APP_OUT/" || exit 1

node scripts/check-msi-contents.mjs "$FULL_OUT/$NAME" full || exit 1
node scripts/check-msi-contents.mjs "$APP_OUT/$NAME" app-only || exit 1
echo "full:     $(stat -c %s "$FULL_OUT/$NAME") bytes"
echo "app-only: $(stat -c %s "$APP_OUT/$NAME") bytes"
