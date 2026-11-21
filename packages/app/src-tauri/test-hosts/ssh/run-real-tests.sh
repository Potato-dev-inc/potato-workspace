#!/usr/bin/env bash
# The real-sshd proof of the SSH chat transport (ignored tests). Needs Docker. Everything it makes is named pm-ssh-test-*.
#   ./run-real-tests.sh dash|bash|ash [path-to-ssh-program]
# It makes a throwaway key under <repo>/.testkeys (gitignored), starts the host (host.sh up), runs both ignored tests with
# the real `ssh`, then removes the container and the known_hosts lines (host.sh down). Images stay; `host.sh purge` removes them.
# Run from packages/app/src-tauri after a normal `cargo test --lib --no-run`; set PM_TEST_EXE to the test binary if it is not the default.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
mkdir -p "$repo/.testkeys"
[ -f "$repo/.testkeys/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C pm-ssh-test -f "$repo/.testkeys/id_ed25519"
bash "$here/host.sh" up "${1:?dash|bash|ash}"
trap 'bash "$here/host.sh" down' EXIT
export PM_SSH_REAL_HOST=127.0.0.1:2222 PM_SSH_REAL_KEY="$(cygpath -w "$repo/.testkeys/id_ed25519" 2>/dev/null || echo "$repo/.testkeys/id_ed25519")"
[ -n "${2:-}" ] && export PM_SSH_REAL_EXE="$2"
cd "$repo/packages/app/src-tauri"
exe="${PM_TEST_EXE:?set PM_TEST_EXE to the cargo test binary (cargo test --lib --no-run prints it)}"
"$exe" --ignored --nocapture --test-threads=1 the_real_ssh
"$exe" --ignored --nocapture --test-threads=1 a_remote_chat_start_runs
"$exe" --ignored --nocapture --test-threads=1 a_real_ssh_browse
