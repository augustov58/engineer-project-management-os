#!/usr/bin/env bash
#
# The helpers' own tests, run from each helper's own directory (issue #107).
#
# The fifth gate. ADR-0052's four gate what this repository wrote; this one
# gates what it pinned — `apps/api/tools/` is a submodule of another repository,
# and a bad commit moved into it is a wrong number on a drawing rather than a
# red typecheck. The command is not written here: each manifest names its own,
# so adding a helper is adding a directory and this script does not change.
#
# Runs the command with the helper's directory as the working directory, which
# is how the API runs it too.
set -euo pipefail

# The API runs every helper under `python3 -B`, so it never writes bytecode
# beside a script. The manifests name a bare `python3`, so the gate sets the
# variable instead — otherwise a green run leaves `__pycache__` behind and the
# comparison at the end of this file reads it as a drift.
export PYTHONDONTWRITEBYTECODE=1

tools="$(cd "$(dirname "$0")/.." && pwd)/apps/api/tools"

if [ ! -d "$tools" ]; then
  echo "no $tools — the helpers submodule is not checked out" >&2
  exit 1
fi

found=0
for manifest in "$tools"/*/manifest.json; do
  [ -e "$manifest" ] || continue
  directory="$(dirname "$manifest")"
  name="$(basename "$directory")"
  # `eval` of a string out of the submodule's own JSON, deliberately: the
  # manifest names the command, which is what keeps this script from naming a
  # helper. What licenses it is that the string comes from a commit pinned by
  # this repository and reviewed when the pin moves — the same thing that
  # licenses running the scripts at all.
  check="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["test"])' "$manifest")"
  echo "=== $name: $check"
  ( cd "$directory" && eval "$check" )
  found=$((found + 1))
done

# A guard on the sweep itself, the shape `gate.test.ts` and `audit.test.ts`
# both use: a submodule that failed to check out leaves this loop running
# nothing and exiting 0, which is a green gate that ran no test.
if [ "$found" -lt 3 ]; then
  echo "only $found helper test commands ran; at least three are registered" >&2
  exit 1
fi

# short-circuit/ and voltage-drop/ carry byte-identical copies of one script
# set, because a helper is a directory and each is what its subprocess is given.
# The 40-case handbook harness runs in both above, which catches a drift that
# changes an answer; this catches one that does not.
diff -r -x __pycache__ "$tools/short-circuit/scripts" "$tools/voltage-drop/scripts"

echo "$found helper test commands ran, and the two SPD copies agree"
