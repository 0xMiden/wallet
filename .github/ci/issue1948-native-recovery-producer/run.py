#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path.cwd()
CONTROLLER = ROOT / "controller"
WALLET = ROOT / "wallet"
SDK = ROOT / "sdk-reference"
PROOF = ROOT / "proof"
BUILD = ROOT / "producer-build" / "crate"
PREFIX = "playwright/proofs/storage-recovery-native-fixtures/"
CONFIG = json.loads((Path(__file__).parent / "inputs.json").read_text())
PROOF.mkdir(exist_ok=True)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(directory, *args):
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def save(name, value):
    (PROOF / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def command(argv, name, timeout):
    env = dict(os.environ, CARGO_BUILD_JOBS="2", RAYON_NUM_THREADS="2", CARGO_TERM_COLOR="never",
               CARGO_TARGET_DIR=str(BUILD / "target"))
    with (PROOF / name).open("wb") as log:
        subprocess.run(argv, cwd=BUILD, env=env, stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=timeout)


def preserve():
    if git(WALLET, "rev-parse", "HEAD") != CONFIG["source"]:
        raise ValueError("source_revision")
    if git(WALLET, "rev-parse", "HEAD^{tree}") != CONFIG["source_tree"]:
        raise ValueError("source_tree")
    if git(SDK, "rev-parse", "HEAD") != CONFIG["sdk_source"]:
        raise ValueError("sdk_revision")
    if git(SDK, "rev-parse", "HEAD^{tree}") != CONFIG["sdk_tree"]:
        raise ValueError("sdk_tree")
    if sha(SDK / "Cargo.lock") != CONFIG["sdk_lock_sha256"]:
        raise ValueError("sdk_lock")
    for name, expected in CONFIG["files"].items():
        if sha(WALLET / name) != expected:
            raise ValueError("proof_file")
    if git(WALLET, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("wallet_tracked_mutation")
    if git(SDK, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("sdk_tracked_mutation")
    save("preservation.json", {"source": CONFIG["source"], "sdk_source": CONFIG["sdk_source"],
                               "five_source_files_preserved": True, "tracked_mutations": 0})


def bind():
    preserve()
    if git(WALLET, "rev-parse", "HEAD^") != CONFIG["base"]:
        raise ValueError("source_parent")
    if git(WALLET, "rev-parse", CONFIG["base"] + "^{tree}") != CONFIG["base_tree"]:
        raise ValueError("base_tree")
    changed = set(git(WALLET, "diff", "--name-only", CONFIG["base"], CONFIG["source"]).splitlines())
    if changed != set(CONFIG["changed_source_paths"]):
        raise ValueError("source_changed_paths")
    if git(CONTROLLER, "rev-parse", "HEAD^") != CONFIG["source"]:
        raise ValueError("workflow_parent")
    paths = set(git(CONTROLLER, "diff", "--name-only", "HEAD^", "HEAD").splitlines())
    if paths != set(CONFIG["proof_paths"]):
        raise ValueError("workflow_changed_paths")
    save("source.json", {"source": CONFIG["source"], "source_tree": CONFIG["source_tree"],
                         "workflow": git(CONTROLLER, "rev-parse", "HEAD"),
                         "source_changed_paths": sorted(changed), "compile_only": True})


def prepare():
    BUILD.mkdir(parents=True, exist_ok=False)
    for name in CONFIG["files"]:
        if not name.startswith(PREFIX):
            raise ValueError("proof_prefix")
        target = BUILD / name.removeprefix(PREFIX)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(WALLET / name, target)
    shutil.copyfile(BUILD / "pinned-sdk.Cargo.lock", BUILD / "Cargo.lock")


def toolchain():
    command(["rustup", "toolchain", "install", CONFIG["rust_version"], "--profile", "minimal"],
            "toolchain.log", 300)
    command(["rustc", "+" + CONFIG["rust_version"], "--version", "--verbose"],
            "rustc-version.log", 30)


def resolve():
    command(["cargo", "+" + CONFIG["rust_version"], "update", "--workspace"],
            "resolve.log", 600)
    command(["python3", "verify-lock.py"], "dependency-verify.log", 30)
    shutil.copyfile(BUILD / "Cargo.lock", PROOF / "producer-Cargo.lock")
    shutil.copyfile(BUILD / "dependency-receipt.json", PROOF / "dependency-receipt.json")


def build():
    command(["python3", "verify-lock.py"], "prebuild-dependency-verify.log", 30)
    command(["cargo", "+" + CONFIG["rust_version"], "build", "--locked", "--jobs", "2"],
            "compile.log", 1500)
    command(["python3", "verify-lock.py"], "postbuild-dependency-verify.log", 30)
    binary = BUILD / "target" / "debug" / "wallet-recovery-native-fixtures"
    if not binary.is_file() or binary.stat().st_size == 0:
        raise ValueError("missing_binary")
    if sha(BUILD / "Cargo.lock") != sha(PROOF / "producer-Cargo.lock"):
        raise ValueError("build_lock_mutation")
    destination = ROOT / "producer-binary"
    destination.mkdir(exist_ok=False)
    shutil.copy2(binary, destination / binary.name)
    save("compile-receipt.json", {"source": CONFIG["source"], "sdk_source": CONFIG["sdk_source"],
          "native_revision": "9a9b58a598a71801199d69309e1fb8e4ef27293c", "rust_version": CONFIG["rust_version"],
          "jobs": 2, "rayon_threads": 2, "binary_bytes": binary.stat().st_size,
          "binary_sha256": sha(binary), "lock_sha256": sha(BUILD / "Cargo.lock"),
          "dependency_receipt_sha256": sha(PROOF / "dependency-receipt.json"),
          "compiled": True, "producer_executed": False, "browser_executed": False,
          "wallet_recovery_acceptance": False})


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) == 2 else "invalid"
    stages = {"bind": bind, "prepare": prepare, "toolchain": toolchain,
              "resolve": resolve, "build": build, "preserve": preserve}
    try:
        stages[stage]()
        print("PRODUCER_CI_STAGE_OK stage=" + stage)
    except Exception as error:
        save("failure-" + stage + ".json", {"stage": stage, "error_class": type(error).__name__,
                                           "runtime_acceptance": False})
        print("PRODUCER_CI_STAGE_FAILED stage=" + stage, file=sys.stderr)
        sys.exit(1)
