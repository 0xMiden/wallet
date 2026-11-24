import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import unittest
import warnings
import zipfile


SPEC = importlib.util.spec_from_file_location("artifact_inspector", Path(__file__).with_name("inspect-artifact.py"))
try:
    INSPECTOR = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(INSPECTOR)
except FileNotFoundError:
    INSPECTOR = None

PROVENANCE = {"version": "1.17.7", "network": "testnet", "sourceSha": "1" * 40, "mode": "production"}
MANIFEST = {"manifest_version": 3, "name": "Bread Wallet by Miden", "version": "1.17.7"}
PLIST = {"CFBundleIdentifier": "com.miden.bread", "CFBundleShortVersionString": "1.17.7", "CFBundleVersion": "19", "CFBundleSupportedPlatforms": ["iPhoneOS"], "CFBundlePackageType": "APPL"}


def archive(entries):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
            for name, content in entries:
                package.writestr(name, content)
    return output.getvalue()


def chrome(manifest=None, marker=PROVENANCE):
    entries = [("manifest.json", json.dumps(manifest or MANIFEST))]
    if marker is not None:
        entries.append(("wallet-release.json", json.dumps(marker)))
    return archive(entries)


def ios(info=None, marker=PROVENANCE):
    entries = [("Payload/App.app/Info.plist", plistlib.dumps(info or PLIST, fmt=plistlib.FMT_BINARY))]
    if marker is not None:
        entries.append(("Payload/App.app/public/wallet-release.json", json.dumps(marker)))
    return archive(entries)


class ArtifactInspection(unittest.TestCase):
    def inspect(self, platform, data):
        self.assertIsNotNone(INSPECTOR, "Artifact inspector must be implemented")
        return INSPECTOR.inspect_artifact(platform, data)

    def test_chrome_extracts_actual_manifest_and_embedded_provenance(self):
        self.assertEqual(self.inspect("chrome", chrome()), {"platform": "chrome", "name": "Bread Wallet by Miden", "version": "1.17.7", "identity": None, "provenance": PROVENANCE})

    def test_chrome_derives_extension_identity_when_public_key_is_embedded(self):
        key = b"public-key-fixture"
        encoded = base64.b64encode(key).decode()
        expected = "".join(chr(ord("a") + int(digit, 16)) for digit in hashlib.sha256(key).hexdigest()[:32])
        self.assertEqual(self.inspect("chrome", chrome({**MANIFEST, "key": encoded}))["identity"], expected)

    def test_device_ipa_extracts_binary_plist_metadata_and_its_own_marker(self):
        self.assertEqual(self.inspect("ios", ios()), {"platform": "ios", "identity": "com.miden.bread", "version": "1.17.7", "buildNumber": "19", "deviceBuild": True, "provenance": PROVENANCE})

    def test_android_extracts_provenance_without_inventing_package_or_version_code(self):
        package = archive([("base/assets/public/wallet-release.json", json.dumps(PROVENANCE))])
        self.assertEqual(self.inspect("android", package), {"platform": "android", "provenance": PROVENANCE})

    def test_missing_marker_is_refused_on_every_platform(self):
        for platform, data in [("chrome", chrome(marker=None)), ("ios", ios(marker=None)), ("android", archive([]))]:
            with self.subTest(platform=platform), self.assertRaisesRegex(ValueError, "provenance"):
                self.inspect(platform, data)

    def test_duplicate_archive_paths_cannot_choose_different_metadata_from_store(self):
        for name in ["manifest.json", "wallet-release.json"]:
            entries = [("manifest.json", json.dumps(MANIFEST)), ("wallet-release.json", json.dumps(PROVENANCE)), (name, "{}")]
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "duplicate"):
                self.inspect("chrome", archive(entries))

    def test_simulator_and_mixed_platform_ipas_are_refused(self):
        for platforms in [["iPhoneSimulator"], ["iPhoneOS", "iPhoneSimulator"], []]:
            with self.subTest(platforms=platforms), self.assertRaisesRegex(ValueError, "device"):
                self.inspect("ios", ios({**PLIST, "CFBundleSupportedPlatforms": platforms}))

    def test_multiple_main_apps_and_nested_only_apps_are_ambiguous(self):
        plist = plistlib.dumps(PLIST)
        cases = [
            [("Payload/App.app/Info.plist", plist), ("Payload/Other.app/Info.plist", plist)],
            [("Payload/Outer.app/Watch/Inner.app/Info.plist", plist)]
        ]
        for entries in cases:
            with self.subTest(entries=[name for name, _ in entries]), self.assertRaisesRegex(ValueError, "main app"):
                self.inspect("ios", archive(entries))

    def test_zip_traversal_and_absolute_paths_are_refused(self):
        for path in ["../manifest.json", "/manifest.json", "folder\\manifest.json"]:
            entries = [("manifest.json", json.dumps(MANIFEST)), ("wallet-release.json", json.dumps(PROVENANCE)), (path, "unsafe")]
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "path"):
                self.inspect("chrome", archive(entries))

    def test_duplicate_json_keys_and_nonobject_provenance_are_refused(self):
        for marker in ['{"mode":"production","mode":"development"}', "[]", "null"]:
            entries = [("manifest.json", json.dumps(MANIFEST)), ("wallet-release.json", marker)]
            with self.subTest(marker=marker), self.assertRaises(ValueError):
                self.inspect("chrome", archive(entries))

    def test_oversized_metadata_is_refused_without_decompressing_it(self):
        entries = [("manifest.json", json.dumps(MANIFEST)), ("wallet-release.json", b"x" * (1024 * 1024 + 1))]
        with self.assertRaisesRegex(ValueError, "large"):
            self.inspect("chrome", archive(entries))

    def test_invalid_archive_and_unknown_platform_are_refused(self):
        with self.assertRaises(ValueError):
            self.inspect("chrome", b"not a zip")
        with self.assertRaises(ValueError):
            self.inspect("desktop", chrome())


if __name__ == "__main__":
    unittest.main()
