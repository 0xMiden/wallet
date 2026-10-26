#!/usr/bin/env python3
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import PurePosixPath
import plistlib
import re
import stat
import sys
import zipfile


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate metadata key")
        value[key] = item
    return value


def metadata(package, path, kind, limit=1024 * 1024):
    try:
        item = package.getinfo(path)
    except KeyError:
        raise ValueError(f"missing {kind} metadata") from None
    if item.file_size > limit or item.flag_bits & 1:
        raise ValueError(f"{kind} metadata is too large or encrypted")
    return package.read(item)


def json_object(payload, kind):
    try:
        value = json.loads(payload, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise ValueError(f"invalid {kind} metadata") from None
    if not isinstance(value, dict):
        raise ValueError(f"invalid {kind} metadata object")
    return value


def require_string(value, name):
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing artifact {name}")
    return value


def inspect_artifact(platform, payload):
    if platform not in {"chrome", "ios", "android"}:
        raise ValueError("unsupported artifact platform")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as package:
            names = package.namelist()
            if len(names) != len(set(names)):
                raise ValueError("duplicate archive path")
            for name in names:
                if "\\" in name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
                    raise ValueError("unsafe archive path")

            if platform == "chrome":
                manifest = json_object(metadata(package, "manifest.json", "manifest"), "manifest")
                if manifest.get("manifest_version") != 3:
                    raise ValueError("a Manifest V3 Chrome artifact is required")
                identity = None
                if "key" in manifest:
                    try:
                        public_key = base64.b64decode(manifest["key"], validate=True)
                    except (ValueError, TypeError):
                        raise ValueError("invalid embedded Chrome public key") from None
                    if not public_key:
                        raise ValueError("empty embedded Chrome public key")
                    digest = hashlib.sha256(public_key).hexdigest()[:32]
                    identity = "".join(chr(ord("a") + int(digit, 16)) for digit in digest)
                result = {
                    "platform": platform,
                    "name": require_string(manifest.get("name"), "name"),
                    "version": require_string(manifest.get("version"), "version"),
                    "identity": identity,
                }
                marker_path = "wallet-release.json"
            elif platform == "ios":
                roots = [name for name in names if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
                if len(roots) != 1:
                    raise ValueError("an unambiguous main app is required in the IPA")
                info = plistlib.loads(metadata(package, roots[0], "Info.plist", 4 * 1024 * 1024))
                if not isinstance(info, dict):
                    raise ValueError("invalid main app Info.plist")
                platforms = info.get("CFBundleSupportedPlatforms")
                if not isinstance(platforms, list) or "iPhoneOS" not in platforms or "iPhoneSimulator" in platforms:
                    raise ValueError("an iOS device build is required")
                if info.get("CFBundlePackageType") != "APPL":
                    raise ValueError("an iOS device application is required")
                result = {
                    "platform": platform,
                    "identity": require_string(info.get("CFBundleIdentifier"), "bundle identity"),
                    "version": require_string(info.get("CFBundleShortVersionString"), "version"),
                    "buildNumber": require_string(info.get("CFBundleVersion"), "build number"),
                    "deviceBuild": True,
                }
                marker_path = roots[0].removesuffix("Info.plist") + "public/wallet-release.json"
            else:
                # Package/versionCode are checked by Play against the upload URL
                # and returned bundle. This marker binds the AAB to its build source.
                result = {"platform": platform}
                marker_path = "base/assets/public/wallet-release.json"

            result["provenance"] = json_object(metadata(package, marker_path, "provenance"), "provenance")
            return result
    except (zipfile.BadZipFile, RuntimeError, plistlib.InvalidFileException, OSError, EOFError):
        raise ValueError("invalid artifact archive or metadata") from None


def main():
    parser = argparse.ArgumentParser(description="Inspect packaged wallet metadata without extracting an archive")
    parser.add_argument("platform", choices=["chrome", "ios", "android"])
    parser.add_argument("artifact", nargs="?")
    args = parser.parse_args()
    if args.artifact:
        descriptor = os.open(args.artifact, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError("artifact must be a regular file")
            payload = source.read()
    else:
        payload = sys.stdin.buffer.read()
    print(json.dumps(inspect_artifact(args.platform, payload), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError):
        print("Artifact inspection failed; check package metadata and embedded provenance.", file=sys.stderr)
        sys.exit(1)
