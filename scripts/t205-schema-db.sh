#!/usr/bin/env bash
set -u
# TASK_205 schema+DB step. Uses the MERGED schema (task-205 cols + cyberlab sourceDeviceId).
# Applies the 3 additive ALTERs via audited psql (idempotent-guarded), NOT db push.
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96

echo "=== 1. scp MERGED schema -> box (preserves sourceDeviceId) ==="
scp -i "$KEY" -o BatchMode=yes /tmp/merged-schema.prisma "$HOST:/opt/spaceworker/prisma/schema.prisma"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "chown trmm:trmm /opt/spaceworker/prisma/schema.prisma && echo chown_ok"
echo "=== 2. confirm merged schema has all 4 + no orphan root schema ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cd /opt/spaceworker && echo -n 'desktopTitle: '; grep -c desktopTitle prisma/schema.prisma; echo -n 'mobileTarget: '; grep -c mobileTarget prisma/schema.prisma; echo -n 'LabTarget.sourceDeviceId: '; awk '/model LabTarget /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma | grep -c sourceDeviceId; echo -n 'root schema.prisma exists: '; ls schema.prisma 2>/dev/null && echo YES_BAD || echo no_good"

echo "=== 3. prisma generate (reads prisma/schema.prisma) ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cd /opt/spaceworker && sudo -u trmm npx --no-install prisma generate 2>&1 | tail -3"
echo "=== 4. apply 3 additive ALTERs via psql (idempotent) ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
for col in desktopTitle desktopBody mobileTarget; do
  exists=$(sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LinkRedirect' AND column_name='$col';")
  if [ "$exists" = "0" ]; then
    sudo -u postgres psql -d spaceworker -v ON_ERROR_STOP=1 -c "ALTER TABLE \"LinkRedirect\" ADD COLUMN \"$col\" TEXT;" && echo "added $col"
  else
    echo "$col already present (skip)"
  fi
done
echo "=== 5. verify LinkRedirect now has all task-205 cols ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='LinkRedirect' AND column_name IN ('desktopTitle','desktopBody','mobileTarget','desktopOnly','target') ORDER BY column_name;" | tr '\n' ' '; echo
echo "=== 6. confirm cyberlab sourceDeviceId STILL in DB ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LabTarget' AND column_name='sourceDeviceId';"
REMOTE
