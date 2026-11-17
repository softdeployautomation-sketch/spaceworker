#!/usr/bin/env bash
set -u
# Cyberlab UI-1 deploy FROM sw-lab via the HARDENED spaceworker deploy script.
# - LOCAL_ROOT=/Users/mikeolab/sw-lab so it rsyncs the tree that HAS the cyberlab code.
# - No --prune (additive). Maintenance auto-managed by the script. Rollback-on-failed-build.
# File list already validated (28 entries, no clone/device-console/.env).
# TSTP-immune so a stray monitoring signal can't freeze the server-side build (2026-10-14 lesson).
trap "" TSTP INT HUP
cd /Users/mikeolab/spaceworker || exit 1
LOCAL_ROOT=/Users/mikeolab/sw-lab bash scripts/deploy-vps.sh /tmp/cyberlab-files.txt 2>&1
echo "CYBERLAB_DEPLOY_EXIT_$?"

