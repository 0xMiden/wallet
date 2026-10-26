import datetime as dt
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('apple_profile', Path(__file__).with_name('apple-profile.py'))
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)
NOW = dt.datetime(2026, 10, 26, tzinfo=dt.timezone.utc)
CERT = b'distribution-certificate-fixture'
IDENTITIES = {hashlib.sha1(CERT).hexdigest()}


def valid():
    return {
        'UUID': '12345678-1234-1234-1234-123456789abc',
        'Name': 'iOS Team Store Provisioning Profile: com.miden.bread',
        'TeamIdentifier': ['LHU7B7J5WL'],
        'Platform': ['iOS'],
        'CreationDate': NOW - dt.timedelta(days=10),
        'ExpirationDate': NOW + dt.timedelta(days=10),
        'DeveloperCertificates': [CERT],
        'Entitlements': {'application-identifier': 'LHU7B7J5WL.com.miden.bread',
                         'com.apple.developer.team-identifier': 'LHU7B7J5WL', 'get-task-allow': False}
    }


class ProfileTests(unittest.TestCase):
    def test_valid_store_profile_binds_installed_distribution_certificate(self):
        self.assertEqual(PROFILE.validate_profile(valid(), IDENTITIES, NOW), valid()['UUID'])

    def test_invalid_profiles_are_rejected(self):
        cases = [
            {'TeamIdentifier': ['OTHERTEAM0']}, {'Name': 'development'}, {'Platform': ['OSX']}, {'Platform': 'iOS'},
            {'UUID': '../escape'}, {'ExpirationDate': NOW}, {'CreationDate': NOW + dt.timedelta(days=1)},
            {'DeveloperCertificates': [b'unrelated-certificate']}, {'DeveloperCertificates': []},
            {'ProvisionedDevices': []}, {'ProvisionsAllDevices': True}, {'ExpirationDate': 'tomorrow'}
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                profile = valid()
                profile.update(changes)
                with self.assertRaises(ValueError):
                    PROFILE.validate_profile(profile, IDENTITIES, NOW)

    def test_entitlements_cannot_enable_debugging_or_change_app_or_team(self):
        for changes in [{'get-task-allow': True}, {'get-task-allow': 0}, {'get-task-allow': None},
                        {'application-identifier': 'LHU7B7J5WL.other.app'},
                        {'com.apple.developer.team-identifier': 'OTHERTEAM0'}]:
            profile = valid()
            profile['Entitlements'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                PROFILE.validate_profile(profile, IDENTITIES, NOW)

    def test_install_is_private_exclusive_and_cleanup_only_removes_its_own_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signing = root / 'signing'
            signing.mkdir(mode=0o700)
            profiles = root / 'profiles'
            target = PROFILE.install_profile(b'approved-cms', valid(), IDENTITIES, signing, profiles, NOW)
            self.assertEqual(target.read_bytes(), b'approved-cms')
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                PROFILE.install_profile(b'approved-cms', valid(), IDENTITIES, signing, profiles, NOW)
            target.write_bytes(b'replacement')
            with self.assertRaises(ValueError):
                PROFILE.remove_profile(signing, profiles)
            self.assertEqual(target.read_bytes(), b'replacement')
            target.write_bytes(b'approved-cms')
            PROFILE.remove_profile(signing, profiles)
            self.assertFalse(target.exists())
            PROFILE.remove_profile(signing, profiles)

    def test_rejected_profile_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad = valid()
            bad['ProvisionedDevices'] = ['fixture']
            with self.assertRaises(ValueError):
                PROFILE.install_profile(b'cms', bad, IDENTITIES, root, root / 'profiles', NOW)
            self.assertEqual(list(root.iterdir()), [])

    def test_private_material_refuses_symlinks_and_public_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'profile'
            path.write_bytes(b'profile')
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                PROFILE.private_bytes(path)
            path.chmod(0o600)
            self.assertEqual(PROFILE.private_bytes(path), b'profile')
            link = Path(tmp) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                PROFILE.private_bytes(link)

    def test_identity_parser_requires_distribution_and_exact_team(self):
        good = '  1) ' + next(iter(IDENTITIES)).upper() + ' "Apple Distribution: Fixture (LHU7B7J5WL)"'
        other = good.replace('Apple Distribution:', 'Apple Development:')
        wrong_team = good.replace('LHU7B7J5WL', 'OTHERTEAM0')
        self.assertEqual(PROFILE.distribution_identities(good + '\n' + other + '\n' + wrong_team), IDENTITIES)
        with self.assertRaises(ValueError):
            PROFILE.distribution_identities(other + '\n' + wrong_team)


if __name__ == '__main__':
    unittest.main()
