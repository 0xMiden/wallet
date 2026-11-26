#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import uuid

TEAM = 'LHU7B7J5WL'
BUNDLE = 'com.miden.bread'
PROFILE_NAME = 'iOS Team Store Provisioning Profile: ' + BUNDLE
LIMIT = 1024 * 1024


def distribution_identities(text, certificate_records):
    identities = set(re.findall(r'^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Apple Distribution: [^\n]+ \(' + TEAM + r'\)"', text, re.M))
    if not identities:
        raise ValueError('An installed distribution signing identity is required')
    # Apple's SHA-1 labels join keychain records; certificate binding itself uses SHA-256.
    fingerprints = {}
    for sha256, label in re.findall(r'SHA-256 hash:\s*([A-Fa-f0-9]{64})\s*\nSHA-1 hash:\s*([A-Fa-f0-9]{40})', certificate_records):
        fingerprints.setdefault(label.lower(), set()).add(sha256.lower())
    allowed = set()
    for label in identities:
        matches = fingerprints.get(label.lower(), set())
        if len(matches) != 1:
            raise ValueError('Distribution identity has no unambiguous SHA256 certificate')
        allowed.update(matches)
    return allowed


def utc(value):
    if not isinstance(value, dt.datetime):
        raise ValueError('Invalid profile date')
    return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)


def validate_profile(profile, identities, now=None):
    now = utc(now or dt.datetime.now(dt.timezone.utc))
    if not isinstance(profile, dict):
        raise ValueError('Invalid profile')
    identifier = str(uuid.UUID(profile.get('UUID', '')))
    entitlements = profile.get('Entitlements')
    if (profile.get('Name') != PROFILE_NAME or profile.get('TeamIdentifier') != [TEAM]
            or not isinstance(profile.get('Platform'), list) or 'iOS' not in profile['Platform'] or not isinstance(entitlements, dict)
            or entitlements.get('application-identifier') != TEAM + '.' + BUNDLE
            or entitlements.get('com.apple.developer.team-identifier') != TEAM
            or entitlements.get('get-task-allow') is not False
            or 'ProvisionedDevices' in profile or profile.get('ProvisionsAllDevices', False) is not False
            or not utc(profile.get('CreationDate')) <= now < utc(profile.get('ExpirationDate'))):
        raise ValueError('An active matching App Store profile is required')
    certificates = profile.get('DeveloperCertificates')
    if not isinstance(certificates, list) or not certificates or any(not isinstance(c, bytes) for c in certificates):
        raise ValueError('Invalid profile certificates')
    if len({hashlib.sha256(cert).hexdigest() for cert in certificates} & identities) != 1:
        raise ValueError('Profile must match exactly one installed distribution identity')
    return identifier


def private_bytes(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > LIMIT:
            raise ValueError('Private regular signing file required')
        return source.read(LIMIT + 1)


def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as target:
        target.write(data)


def install_profile(payload, decoded, identities, directory, profiles, now=None):
    identifier = validate_profile(decoded, identities, now)
    if not payload or len(payload) > LIMIT or profiles.is_symlink():
        raise ValueError('Invalid profile payload or destination')
    profiles.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = profiles / (identifier + '.mobileprovision')
    write_private(target, payload)
    try:
        record = {'uuid': identifier, 'sha256': hashlib.sha256(payload).hexdigest()}
        write_private(directory / 'profile-install.json', json.dumps(record).encode())
    except Exception:
        target.unlink()
        raise
    return target


def remove_profile(directory, profiles):
    if profiles.is_symlink():
        raise ValueError('Invalid profile destination')
    record_path = directory / 'profile-install.json'
    if not record_path.exists():
        return
    record = json.loads(private_bytes(record_path))
    identifier = str(uuid.UUID(record['uuid']))
    target = profiles / (identifier + '.mobileprovision')
    if target.exists():
        if hashlib.sha256(private_bytes(target)).hexdigest() != record['sha256']:
            raise ValueError('Installed profile changed; refusing removal')
        target.unlink()
    record_path.unlink()


def validate_exported_signing(profile, profile_hash, record, leaf, identities, signed, expected, now=None):
    if (leaf not in identities or profile_hash != record['sha256']
            or validate_profile(profile, {leaf}, now) != record['uuid']):
        raise ValueError('Export must use the verified App Store profile and distribution identity')
    if (signed.get('application-identifier') != TEAM + '.' + BUNDLE
            or signed.get('com.apple.developer.team-identifier') != TEAM
            or signed.get('get-task-allow') is not False):
        raise ValueError('Invalid signed app identity or production entitlements')
    for key in ('com.apple.developer.associated-domains', 'keychain-access-groups'):
        values = expected.get(key)
        if not isinstance(values, list) or not values or any(not isinstance(value, str) or not value for value in values):
            raise ValueError('Missing required source entitlements')
        expanded = [value.replace('$(AppIdentifierPrefix)', TEAM + '.')
                         .replace('$(PRODUCT_BUNDLE_IDENTIFIER)', BUNDLE) for value in values]
        if signed.get(key) != expanded:
            raise ValueError('Exported app is missing required production capabilities')


def verify_ipa(ipa_dir, directory, entitlements_path, identities):
    print('Checking exported IPA structure', flush=True)
    packages = list(ipa_dir.glob('*.ipa'))
    if len(packages) != 1 or not packages[0].is_file() or packages[0].is_symlink():
        raise ValueError('Expected one exported IPA')
    with tempfile.TemporaryDirectory(dir=directory) as scratch:
        root = Path(scratch)
        subprocess.run(['/usr/bin/ditto', '-x', '-k', str(packages[0]), str(root)], capture_output=True, check=True)
        apps = list((root / 'Payload').glob('*.app'))
        if len(apps) != 1 or not apps[0].is_dir() or apps[0].is_symlink():
            raise ValueError('Expected one exported app')
        app = apps[0]
        print('Checking exported app signature and signing certificate', flush=True)
        codesign = '/usr/bin/codesign'
        subprocess.run([codesign, '--verify', '--deep', '--strict', str(app)], capture_output=True, check=True)
        if plistlib.loads((app / 'Info.plist').read_bytes()).get('CFBundleIdentifier') != BUNDLE:
            raise ValueError('Invalid exported bundle identifier')
        subprocess.run([codesign, '--display', f'--extract-certificates={root / "cert"}', str(app)],
                       capture_output=True, check=True)
        certificate = (root / 'cert0').read_bytes()
        signed = plistlib.loads(subprocess.run([codesign, '--display', '--entitlements', '-', '--xml', str(app)],
                                              capture_output=True, check=True).stdout)
        print('Checking embedded App Store profile', flush=True)
        embedded = app / 'embedded.mobileprovision'
        if embedded.is_symlink() or not embedded.is_file() or embedded.stat().st_size > LIMIT:
            raise ValueError('Expected an embedded App Store profile')
        payload = embedded.read_bytes()
        profile = plistlib.loads(subprocess.run(['/usr/bin/security', 'cms', '-D'], input=payload,
                                               capture_output=True, check=True).stdout)
        record = json.loads(private_bytes(directory / 'profile-install.json'))
        expected = plistlib.loads(entitlements_path.read_bytes())
        print('Checking exported signing identity and production entitlements', flush=True)
        validate_exported_signing(profile, hashlib.sha256(payload).hexdigest(), record,
                                  hashlib.sha256(certificate).hexdigest(), identities, signed, expected)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['install', 'remove', 'verify-ipa'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--profiles-directory', type=Path)
    parser.add_argument('--ipa-dir', type=Path)
    parser.add_argument('--entitlements', type=Path)
    args = parser.parse_args()
    if args.mode == 'verify-ipa':
        if args.ipa_dir is None or args.entitlements is None:
            parser.error('verify-ipa requires --ipa-dir and --entitlements')
    elif args.profiles_directory is None:
        parser.error('install and remove require --profiles-directory')
    if args.mode == 'remove':
        remove_profile(args.directory, args.profiles_directory)
        return
    identities = distribution_identities(private_bytes(args.directory / 'identities.txt').decode(),
                                           private_bytes(args.directory / 'certificate-fingerprints.txt').decode())
    if args.mode == 'verify-ipa':
        verify_ipa(args.ipa_dir, args.directory, args.entitlements, identities)
        print('Verified exported App Store signature and production entitlements')
        return
    payload = private_bytes(args.directory / 'store.mobileprovision')
    decoded = subprocess.run(['/usr/bin/security', 'cms', '-D'], input=payload, capture_output=True, check=True).stdout
    profile = plistlib.loads(decoded)
    install_profile(payload, profile, identities, args.directory, args.profiles_directory)
    print('Verified existing App Store profile installed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('App Store signing verification or profile operation failed', file=sys.stderr)
        sys.exit(1)
