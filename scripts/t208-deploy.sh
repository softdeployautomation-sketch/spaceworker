#!/usr/bin/env bash
# TASK_208 deploy: 208 files only (branch agent/task-208-neko-mobile working tree).
# Uses hardened deploy-vps.sh (TSTP-immune, full build log, rollback). Full log: /tmp/t208-deploy.log
set -u
cd /Users/mikeolab/spaceworker
rm -f /tmp/t208-deploy.log
nohup bash scripts/deploy-vps.sh /tmp/t208-files.txt > /tmp/t208-deploy.log 2>&1 &
echo "deploy_pid=$!"
