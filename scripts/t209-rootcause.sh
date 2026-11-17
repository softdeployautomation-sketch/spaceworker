#!/usr/bin/env bash
# Which list clobbered lib/license-service.ts today, and where's the good copy?
set -u
{
echo "=== [1] which of todays deploy lists contained license-service.ts ==="
grep -l 'license-service' /tmp/*files* /tmp/*list* 2>/dev/null || echo 'none found in /tmp lists'

echo '=== [2] mailer-exe branch version: does it pass issuedAt? ==='
cd /Users/mikeolab/spaceworker
git show origin/mailer-exe:lib/license-service.ts 2>/dev/null | grep -n -A7 'exeLicenseIssuedEmailHtml({' | head -10 || echo 'no mailer-exe / no match'

echo '=== [3] md5: mailer-exe vs sw-lab(=current box) vs main ==='
git show origin/mailer-exe:lib/license-service.ts 2>/dev/null | md5 -q || echo no-mailer
md5 -q /Users/mikeolab/sw-lab/lib/license-service.ts
git show origin/main:lib/license-service.ts | md5 -q

echo '=== [4] when did origin/mailer-exe last touch license-service? ==='
git log --oneline -3 --date=short --format='%h %ad %s' origin/mailer-exe -- lib/license-service.ts

echo '=== [5] does mailer-exe email.ts match the BOX email.ts (issuedAt-required pair)? ==='
git show origin/mailer-exe:lib/email.ts | md5 -q || echo no-mailer-email
echo '(box email.ts md5 was e7b1125d55fb44d16602924de109a917)'
echo ROOTCAUSE_DONE
} > /tmp/t209-rootcause.txt 2>&1