#!/usr/bin/env python3
"""Validate the fixed fork baseline without packaging upstream TyranoScript."""

from __future__ import annotations

import json
import pathlib
import re
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[2]
BASELINE = "c8dbfd492afd3d79b0954fcf4477236f5c6c4830"
BRANCH = "retrom/gc8dbfd492afd"
TAG_PATTERN = r"^rpg-runtime-gc8dbfd492afd-r[1-9][0-9]*(-rc\.[1-9][0-9]*)?$"


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def main() -> None:
    contract = json.loads((ROOT / "retrom-fork.json").read_text(encoding="utf-8"))
    assert contract["schemaVersion"] == 1
    assert contract["defaultBranch"] == BRANCH
    assert contract["upstreamMirrorBranch"] == "master"
    assert contract["releaseMode"] == "HOST_BRIDGE_ONLY"
    assert contract["releaseTagPattern"] == TAG_PATTERN
    assert re.fullmatch(TAG_PATTERN, "rpg-runtime-gc8dbfd492afd-r1")
    assert contract["adapterAbi"] == "tyranoscript-snapshot-v1"
    assert contract["upstreams"] == [
        {
            "role": "engine-baseline",
            "repository": "https://github.com/ShikemokuMK/tyranoscript",
            "refType": "COMMIT",
            "ref": BASELINE,
            "commit": BASELINE,
        }
    ]
    assert contract["releaseAssets"] == [
        "retrom-tyranoscript-bridge.js",
        "RETROM-BRIDGE-LICENSE",
        "rpg-runtime-release.json",
    ]
    assert git("merge-base", "--is-ancestor", BASELINE, "HEAD") == ""
    assert not git("rev-list", "--min-parents=2", f"{BASELINE}..HEAD")
    print("retrom TyranoScript fork source contract: ok")


if __name__ == "__main__":
    main()
