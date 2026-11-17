#!/usr/bin/env bash
# Remove the now-unused eslint-disable directive (rules.ts:310) and re-lint.
set -eu
cd /Users/mikeolab/spaceworker
python3 - <<'PY'
p = 'lib/hosting/rules.ts'
s = open(p).read()
target = '    // eslint-disable-next-line no-control-regex\n'
assert target in s, 'directive not found'
s = s.replace(target, '', 1)
open(p, 'w').write(s)
print('REMOVED')
PY
grep -c 'eslint-disable-next-line no-control-regex' lib/hosting/rules.ts || echo '0 occurrences (clean)'
npx eslint lib/hosting/rules.ts tests/hosting-files.test.ts; echo "LINT_EXIT=$?"
