#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
echo "########## A. sw-lab LOCAL schema facts ##########"
cd /Users/mikeolab/sw-lab || exit 1
echo "--- sw-lab: deviceMonitorExePriceUsd in schema? ---"
grep -n 'deviceMonitorExePriceUsd' prisma/schema.prisma || echo "ABSENT in sw-lab"
echo "--- sw-lab: AdminSetting model has it? (context) ---"
awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma | grep -n 'deviceMonitorExePriceUsd' || echo "NOT in AdminSetting model"
echo "--- sw-lab: sourceDeviceId inside LabTarget model? ---"
awk '/model LabTarget /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma | grep -n 'sourceDeviceId' || echo "NOT in LabTarget"
echo
echo "########## B. spaceworker origin/main schema facts ##########"
cd /Users/mikeolab/spaceworker || exit 1
echo "--- origin/main: deviceMonitorExePriceUsd in schema? ---"
git show origin/main:prisma/schema.prisma | grep -n 'deviceMonitorExePriceUsd' || echo "ABSENT in origin/main"
echo "--- origin/main: sourceDeviceId inside LabTarget? ---"
git show origin/main:prisma/schema.prisma | awk '/model LabTarget /{f=1} f{print} f&&/^}/{exit}' | grep -n 'sourceDeviceId' || echo "NOT in origin/main LabTarget"
echo
echo "########## C. is sw-lab BEHIND origin/main? (how many commits) ##########"
echo "sw-lab commits not in origin/main (cyberlab):"
git -C /Users/mikeolab/sw-lab rev-list --count origin/main..HEAD 2>/dev/null || echo "n/a"
echo "origin/main commits not in sw-lab:"
git -C /Users/mikeolab/sw-lab rev-list --count HEAD..origin/main 2>/dev/null || echo "n/a"
echo
echo "########## D. diff AdminSetting model: sw-lab vs origin/main ##########"
diff <(git -C /Users/mikeolab/sw-lab show HEAD:prisma/schema.prisma | awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}') \
     <(git -C /Users/mikeolab/spaceworker show origin/main:prisma/schema.prisma | awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}') && echo "AdminSetting IDENTICAL" || echo "^^ AdminSetting DIFFERS (lines < sw-lab, > origin/main)"
