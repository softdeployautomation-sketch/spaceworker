#!/usr/bin/env bash
set -u
echo '=== package.json: sw-lab vs origin/main (shared file risk) ==='
diff <(git -C /Users/mikeolab/sw-lab show HEAD:package.json) \
     <(git -C /Users/mikeolab/spaceworker show origin/main:package.json)
echo "--- (empty above = identical) ---"
echo '=== .gitignore: sw-lab vs origin/main ==='
diff <(git -C /Users/mikeolab/sw-lab show HEAD:.gitignore) \
     <(git -C /Users/mikeolab/spaceworker show origin/main:.gitignore)
echo "--- (empty above = identical) ---"
echo '=== app/globals.css: sw-lab vs origin/main (should only ADD lab-ops theme) ==='
diff <(git -C /Users/mikeolab/sw-lab show HEAD:app/globals.css) \
     <(git -C /Users/mikeolab/spaceworker show origin/main:app/globals.css) | head -40
echo '=== does sw-lab add any NEW dependency not on live? check deps delta ==='
diff <(git -C /Users/mikeolab/spaceworker show origin/main:package.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('\\n'.join(sorted(list(d.get('dependencies',{}))+list(d.get('devDependencies',{})))))") \
     <(git -C /Users/mikeolab/sw-lab show HEAD:package.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('\\n'.join(sorted(list(d.get('dependencies',{}))+list(d.get('devDependencies',{})))))") \
  && echo 'IDENTICAL dependency set' || echo '^^ lines with > are NEW in sw-lab (must be installed on live)'
