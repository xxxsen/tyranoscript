import json
import pathlib
import tempfile
import unittest

from importlib.util import module_from_spec, spec_from_file_location


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = spec_from_file_location("build_release", ROOT / ".github/rpg-runtime/build-release.py")
BUILD_RELEASE = module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILD_RELEASE)


class RetromReleaseTests(unittest.TestCase):
    def test_release_contains_only_the_authored_bridge_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary)
            BUILD_RELEASE.build(
                output,
                "https://github.com/retrom-project/tyranoscript",
                "retrom-core-gc8dbfd492afd-r1-rc.1",
                "1" * 40,
            )
            self.assertEqual(
                sorted(path.name for path in output.iterdir()),
                ["RETROM-BRIDGE-LICENSE", "retrom-tyranoscript-bridge.js", "rpg-runtime-release.json"],
            )
            metadata = json.loads((output / "rpg-runtime-release.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["releaseMode"], "HOST_BRIDGE_ONLY")
            self.assertFalse(metadata["containsUpstreamEngine"])
            self.assertEqual(metadata["adapterAbi"], "tyranoscript-snapshot-v1")
            self.assertEqual(
                [record["filename"] for record in metadata["files"]],
                ["RETROM-BRIDGE-LICENSE", "retrom-tyranoscript-bridge.js"],
            )

    def test_rejects_a_floating_or_alias_release_tag(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "RELEASE_TAG_INVALID"):
                BUILD_RELEASE.build(
                    pathlib.Path(temporary),
                    "https://github.com/retrom-project/tyranoscript",
                    "latest",
                    "1" * 40,
                )


if __name__ == "__main__":
    unittest.main()
