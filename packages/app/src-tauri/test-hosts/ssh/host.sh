#!/usr/bin/env bash
# Disposable SSH test host for the real-ssh proof. Everything is named pm-ssh-test-*.
#   host.sh up dash|bash|ash   build (first time), start on 127.0.0.1:2222 (1 CPU, 1 GB), add its key to known_hosts
#   host.sh down               stop + remove the container and remove exactly the known_hosts line it added
#   host.sh purge              also remove the images
set -u
cd "$(dirname "$0")"; SELF="$PWD/host.sh"
KEYS="${PM_SSH_KEYS:-$(cd ../../../../.. && pwd)/.testkeys}"
KH="${PM_SSH_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
case "${1:-}" in
  up)
    v="${2:?variant}"
    docker rm -f pm-ssh-test-host >/dev/null 2>&1
    case "$v" in
      dash) f=Dockerfile.debian; arg="--build-arg SHELL_IS=dash" ;;
      bash) f=Dockerfile.debian; arg="--build-arg SHELL_IS=bash" ;;
      ash)  f=Dockerfile.alpine; arg="" ;;
      *) echo "unknown variant"; exit 2 ;;
    esac
    docker image inspect "pm-ssh-test-host:$v" >/dev/null 2>&1 || \
      docker build -q -t "pm-ssh-test-host:$v" -f "$f" $arg --build-arg "PUBKEY=$(cat "$KEYS/id_ed25519.pub")" . || exit 1
    docker run -d --name pm-ssh-test-host --cpus 1 --memory 1g -p 127.0.0.1:2222:22 "pm-ssh-test-host:$v" >/dev/null || exit 1
    for i in $(seq 1 40); do
      line=$(ssh-keyscan -p 2222 -t ed25519 127.0.0.1 2>/dev/null | grep ssh-ed25519) && [ -n "$line" ] && break
      sleep 1
    done
    [ -n "${line:-}" ] || { echo "sshd did not answer"; exit 1; }
    # drop an older line of ours first (a rebuilt host has a new key), then add this one
    grep -v '^\[127.0.0.1\]:2222 ' "$KH" > "$KH.pm-tmp" 2>/dev/null; cat "$KH.pm-tmp" > "$KH"; rm -f "$KH.pm-tmp"
    echo "$line" >> "$KH"
    echo "up $v: $line" | cut -c1-90
    ;;
  down)
    docker rm -f pm-ssh-test-host >/dev/null 2>&1
    if [ -f "$KH" ]; then grep -v '^\[127.0.0.1\]:2222 ' "$KH" > "$KH.pm-tmp"; cat "$KH.pm-tmp" > "$KH"; rm -f "$KH.pm-tmp"; fi
    echo down
    ;;
  purge)
    bash "$SELF" down
    for v in dash bash ash; do docker rmi "pm-ssh-test-host:$v" >/dev/null 2>&1; done
    echo purged
    ;;
  *) echo "usage: host.sh up|down|purge"; exit 2 ;;
esac
