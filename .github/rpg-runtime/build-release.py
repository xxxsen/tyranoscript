#!/usr/bin/env python3
"""Build the bridge-only release without redistributing TyranoScript."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil


ROOT = pathlib.Path(__file__).resolve().parents[2]
TAG_PATTERN = re.compile(r"^rpg-runtime-gc8dbfd492afd-r[1-9][0-9]*(-rc\.[1-9][0-9]*)?$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
ASSETS = {
    "retrom-tyranoscript-bridge.js": ROOT / "retrom-runtime" / "bridge.js",
    "RETROM-BRIDGE-LICENSE": ROOT / "retrom-runtime" / "RETROM-BRIDGE-LICENSE",
}


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(128 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build(output: pathlib.Path, repository: str, tag: str, commit: str) -> None:
    if repository != "https://github.com/xxxsen/tyranoscript":
        raise ValueError("RELEASE_REPOSITORY_INVALID")
    if not TAG_PATTERN.fullmatch(tag):
        raise ValueError("RELEASE_TAG_INVALID")
    if not COMMIT_PATTERN.fullmatch(commit):
        raise ValueError("RELEASE_COMMIT_INVALID")
    if output.exists() and any(output.iterdir()):
        raise ValueError("RELEASE_OUTPUT_NOT_EMPTY")
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for filename, source in ASSETS.items():
        if not source.is_file() or source.stat().st_size == 0:
            raise ValueError("RELEASE_SOURCE_MISSING")
        target = output / filename
        shutil.copyfile(source, target)
        records.append({"filename": filename, "sizeBytes": target.stat().st_size, "sha256": sha256(target)})
    metadata = {
        "schemaVersion": 1,
        "repository": repository,
        "tag": tag,
        "commit": commit,
        "adapterAbi": "tyranoscript-snapshot-v1",
        "releaseMode": "HOST_BRIDGE_ONLY",
        "containsUpstreamEngine": False,
        "engineBaseline": "c8dbfd492afd3d79b0954fcf4477236f5c6c4830",
        "files": sorted(records, key=lambda record: record["filename"]),
    }
    (output / "rpg-runtime-release.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    build(args.output.resolve(), args.repository, args.tag, args.commit)
    print(f"TyranoScript bridge release: {args.output}")


if __name__ == "__main__":
    main()
