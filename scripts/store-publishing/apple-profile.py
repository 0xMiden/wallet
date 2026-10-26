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
import uuid

TEAM = 'LHU7B7J5WL'
BUNDLE = 'com.miden.bread'
PROFILE_NAME = 'iOS Team Store Provisioning Profile: ' + BUNDLE
LIMIT = 1024 * 1024


def distribution_identities(text):
    identities = set(re.findall(r'^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Apple Distribution: [^\n]+ \(' + TEAM + r'\)"', text, re.M))
    if not identities:
        raise ValueError('An installed distribution signing identity is required')
    return {value.lower() for value in identities}


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
    if len({hashlib.sha1(cert).hexdigest() for cert in certificates} & identities) != 1:
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['install', 'remove'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--profiles-directory', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'remove':
        remove_profile(args.directory, args.profiles_directory)
        return
    payload = private_bytes(args.directory / 'store.mobileprovision')
    decoded = subprocess.run(['/usr/bin/security', 'cms', '-D'], input=payload, capture_output=True, check=True).stdout
    profile = plistlib.loads(decoded)
    identities = distribution_identities(private_bytes(args.directory / 'identities.txt').decode())
    install_profile(payload, profile, identities, args.directory, args.profiles_directory)
    print('Verified existing App Store profile installed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('App Store profile validation or installation failed', file=sys.stderr)
        sys.exit(1)
