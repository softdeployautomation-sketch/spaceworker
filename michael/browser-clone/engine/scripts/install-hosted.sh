#!/usr/bin/env bash
# install-hosted.sh - hosted-PC (Linux server) installer for the browser-clone
# receiver.
#
# DEPLOYMENT RULE (enforced, not optional): the install folder is QUARANTINED
# BEFORE the binary is installed into it. On POSIX the quarantine is file
#system isolation: a root-owned 0700 directory with no group/world access.
# `preflight --dir` creates/locks the folder and fails the install when the
# mode cannot be enforced.
#
# usage: install-hosted.sh <new-exe> [install-dir] [addr] [staging-root]
set -euo pipefail

NEW_EXE="${1:?usage: install-hosted.sh <new-exe> [install-dir] [addr] [staging-root]}"
INSTALL_DIR="${2:-/opt/tacticalrmm/clone-tool}"
ADDR="${3:-:8080}"
STAGING="${4:-/var/lib/tacticalrmm/Clones}"
UNIT=/etc/systemd/system/spaceworker-clone.service

# 1. RULE: quarantine first (run from the SOURCE copy - the install folder
#    must stay empty until the quarantine is verified).
"$NEW_EXE" preflight --dir "$INSTALL_DIR"

# 2. install the binary into the quarantined folder.
install -d -m 0700 "$INSTALL_DIR"
install -m 0700 "$NEW_EXE" "$INSTALL_DIR/hack-browser-clone"

# 3. install + start the receiver as a systemd service (Linux hosted server).
cat >"$UNIT" <<UNIT
[Unit]
Description=Spaceworker browser-clone receiver (directive section 6)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$INSTALL_DIR/hack-browser-clone serve --addr $ADDR --staging-root $STAGING
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now spaceworker-clone.service
echo "installed $INSTALL_DIR/hack-browser-clone"
echo "receiver: spaceworker-clone.service on $ADDR (staging $STAGING)"