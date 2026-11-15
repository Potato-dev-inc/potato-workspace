#!/bin/bash
# The real-app check (P1): the newest release MSI, extracted (no install, no elevation), real agents, one report.
#   bash packages/e2e/real/real-app-check.sh [--msi <file>] [--skip-agents] [--keep]
# Report: D:\pm-night\evidence-1116\realtest\run-<id>\report.md. Needs a second monitor (windows never open on the primary screen).
set -e
cd "$(dirname "$0")"
exec node run-real.mjs "$@"
