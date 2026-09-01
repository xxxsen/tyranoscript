#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?absolute empty output directory is required}
python3 "$root/.github/rpg-runtime/candidate_descriptor.py" prepare "$output"
python3 "$root/.github/rpg-runtime/verify-source.py"
commit=$(git -C "$root" rev-parse HEAD)
python3 "$root/.github/rpg-runtime/build-release.py" --output "$output" \
  --repository https://github.com/retrom-project/tyranoscript \
  --tag retrom-core-gc8dbfd492afd-r999999 --commit "$commit"
rm "$output/rpg-runtime-release.json"
python3 "$root/.github/rpg-runtime/candidate_descriptor.py" finalize "$output" --core-id tyranoscript
