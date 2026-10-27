#!/usr/bin/env python3
"""Validate dependency identity against the immutable SDK lock before compiling."""
import hashlib
import json
import pathlib
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent
EXPECTED_LOCK_SHA256 = "c8b254c0e0ee462271c5d5805b1a79399cb709c97bd7c650d8d5b2f2f058fac1"
NATIVE_SOURCE = "git+https://github.com/0xMiden/rust-sdk?rev=9a9b58a598a71801199d69309e1fb8e4ef27293c#9a9b58a598a71801199d69309e1fb8e4ef27293c"
ROOT_NAME = "wallet-recovery-native-fixtures"


def identity(package):
    return tuple(package.get(k) for k in ("name", "version", "source", "checksum"))


def main():
    pinned_bytes = (ROOT / "pinned-sdk.Cargo.lock").read_bytes()
    if hashlib.sha256(pinned_bytes).hexdigest() != EXPECTED_LOCK_SHA256:
        raise ValueError("pinned_lock_hash")
    pinned = tomllib.loads(pinned_bytes.decode())["package"]
    allowed = {identity(package) for package in pinned}
    current_bytes = (ROOT / "Cargo.lock").read_bytes()
    current = tomllib.loads(current_bytes.decode())["package"]
    roots = [p for p in current if p["name"] == ROOT_NAME]
    if len(roots) != 1 or roots[0]["version"] != "0.0.0" or "source" in roots[0]:
        raise ValueError("producer_root")
    for package in current:
        if package["name"] != ROOT_NAME and identity(package) not in allowed:
            raise ValueError("dependency_drift")
    native = [p for p in current if p["name"] == "miden-client"]
    if len(native) != 1 or native[0].get("source") != NATIVE_SOURCE:
        raise ValueError("native_revision")
    for name, version in (("miden-testing", "0.17.0"), ("miden-protocol", "0.17.1"),
                          ("miden-objects", "0.17.1"), ("miden-node-proto-build", "0.17.3"),
                          ("prost", "0.14.4")):
        if [p["version"] for p in current if p["name"] == name] != [version]:
            raise ValueError("required_dependency_identity")
    receipt = {"schema": 1, "packages": len(current), "all_dependencies_in_exact_sdk_lock": True,
               "native_revision_bound": True, "lock_sha256": hashlib.sha256(current_bytes).hexdigest()}
    (ROOT / "dependency-receipt.json").write_text(json.dumps(receipt, sort_keys=True) + "\n")
    print("DEPENDENCY_CLOSURE_OK packages=" + str(len(current)))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("DEPENDENCY_CLOSURE_REFUSED", file=sys.stderr)
        sys.exit(1)
