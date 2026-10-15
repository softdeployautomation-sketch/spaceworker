#!/usr/bin/env bash
#
# preflight-shared-drift.sh — TASK_210 S3: the shared-file clobber detector.
#
# WHY (2026-10-15, TASK_209): a deploy list shipped a REVERT of a helper file
# (.vbs) because nobody diffed the listed files against the OTHER local branches
# first — another branch had a newer copy, and a later merge would silently undo
# work. Run this BEFORE every deploy list and paste the matrix into STEPS.
#
# usage:
#   scripts/preflight-shared-drift.sh <files-list> <base-ref> [--ack <branch>]...
#
#   <files-list>  deploy file list, one repo-relative path per line
#                 (same format deploy-vps.sh consumes)
#   <base-ref>    what you intend to ship FROM (e.g. main, agent/task-209-…)
#   --ack <b>     acknowledge the divergence vs branch <b> (repeatable); those
#                 hits print ACKED and do not fail the run
#
# output (paste-able matrix):
#   MISSING_BASE <file>                     (not in <base-ref> — fix the list)
#   DIVERGENT <file> <branch> +<added>/-<deleted>
#   ACKED <file> <branch> +<added>/-<deleted>
#   ABSENT <file> <branch>                  (branch simply lacks the file)
#   DRIFT-NONE <file>                       (one identical copy everywhere)
#
# exit: 1 on any un-acked DIVERGENT or any MISSING_BASE, else 0.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FILES_FROM=""
BASE_REF=""
ACK=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ack)
      [ $# -ge 2 ] || { echo "--ack needs a branch name" >&2; exit 2; }
      ACK+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)
      if [ -z "$FILES_FROM" ]; then FILES_FROM="$1"
      elif [ -z "$BASE_REF" ]; then BASE_REF="$1"
      else echo "unexpected argument: $1" >&2; exit 2
      fi
      shift ;;
  esac
done
[ -n "$FILES_FROM" ] && [ -n "$BASE_REF" ] || {
  echo "usage: $0 <files-list> <base-ref> [--ack <branch>]..." >&2; exit 2; }
[ -f "$FILES_FROM" ] || { echo "no such file list: $FILES_FROM" >&2; exit 2; }
git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null || {
  echo "base-ref does not resolve to a commit: $BASE_REF" >&2; exit 2; }

# Branch set: every local branch (refs/heads) + origin/mailer-exe when present.
BRANCHES="$(git for-each-ref --format='%(refname:short)' refs/heads)"
if git rev-parse --verify --quiet origin/mailer-exe >/dev/null; then
  BRANCHES="$BRANCHES
origin/mailer-exe"
fi

acked() {
  local b="$1" a
  for a in ${ACK[@]+"${ACK[@]}"}; do [ "$a" = "$b" ] && return 0; done
  return 1
}

FAIL=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  f="${f%/}"   # directory entries (trailing /) compare as trees
  if ! git cat-file -e "$BASE_REF:$f" 2>/dev/null; then
    echo "MISSING_BASE $f"
    FAIL=1
    continue
  fi
  base_blob="$(git rev-parse "$BASE_REF:$f")"
  saw_diff=0
  while IFS= read -r b; do
    [ -z "$b" ] && continue
    [ "$b" = "$BASE_REF" ] && continue
    if ! git cat-file -e "$b:$f" 2>/dev/null; then
      echo "ABSENT $f $b"
      continue
    fi
    b_blob="$(git rev-parse "$b:$f")"
    [ "$b_blob" = "$base_blob" ] && continue
    numstat="$(git --literal-pathspecs diff --numstat "$BASE_REF" "$b" -- "$f" \
      | awk '{a+=$1; d+=$2} END {printf "+%d/-%d", a, d}')"
    if acked "$b"; then
      echo "ACKED $f $b $numstat"
    else
      echo "DIVERGENT $f $b $numstat"
      saw_diff=1
      FAIL=1
    fi
  done <<EOF
$BRANCHES
EOF
  [ "$saw_diff" -eq 0 ] && echo "DRIFT-NONE $f"
done < "$FILES_FROM"

if [ "$FAIL" -ne 0 ]; then
  echo "DRIFT DETECTED — reconcile the list (or --ack <branch>) before deploying." >&2
  exit 1
fi
echo "no shared-file drift across $(printf '%s\n' "$BRANCHES" | wc -l | tr -d ' ') branch(es)."
