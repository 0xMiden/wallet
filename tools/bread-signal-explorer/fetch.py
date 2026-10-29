#!/usr/bin/env python3
"""Refresh the Bread Signal Explorer cache from Sentry.

Credentials stay inside the crash-report helper. This process prints counts
only, and writes the cache under the explorer state directory.
"""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import quote

HELPER = Path.home() / '.agents' / 'skills' / 'walletsentry' / 'scripts'
ORG = 'miden'
PROJECT = 'bread-wallet'
VERSION = re.compile(r'^[0-9A-Za-z.+_-]+$')


def write_json(path, payload):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(payload, handle, indent=1)
        handle.write('\n')
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def quiet_hits(client, query):
    try:
        return hits(client, query)
    except ValueError:
        return None


def hits(client, query):
    payload, headers = client.get('/api/0/organizations/%s/issues/' % ORG, {
        'project': client.project_id,
        'query': query,
        'statsPeriod': '90d',
        'limit': '1',
    })
    if not isinstance(payload, list):
        raise ValueError('Expected an issue list')
    raw = next((value for key, value in headers.items() if key.lower() == 'x-hits'), '0')
    return int(raw) if str(raw).isdigit() else None


def slim(row):
    stats = row.get('stats') if isinstance(row.get('stats'), dict) else {}
    day = stats.get('24h') if isinstance(stats.get('24h'), list) else []
    permalink = row.get('permalink') if isinstance(row.get('permalink'), str) else ''
    return {
        'id': str(row.get('id') or ''),
        'shortId': str(row.get('shortId') or ''),
        'title': str(row.get('title') or '')[:400],
        'culprit': str(row.get('culprit') or '')[:200],
        'count': row.get('count') or 0,
        'userCount': row.get('userCount') or 0,
        'firstSeen': row.get('firstSeen'),
        'lastSeen': row.get('lastSeen'),
        'level': row.get('level'),
        'substatus': row.get('substatus'),
        'status': row.get('status'),
        'isUnhandled': bool(row.get('isUnhandled')),
        'permalink': permalink if permalink.startswith('https://') else '',
        'stats': {'24h': day},
    }


def release_rows(client):
    payload, _ = client.get('/api/0/projects/%s/%s/releases/' % (ORG, PROJECT), {'per_page': '50'})
    if not isinstance(payload, list):
        raise ValueError('Expected a release list')
    rows = []
    for release in payload:
        version = str(release.get('version') or '')
        if not VERSION.fullmatch(version):
            continue
        rows.append({
            'version': version,
            'created': release.get('dateCreated'),
            'newGroups': release.get('newGroups') or 0,
        })
    return rows


def event_totals(client):
    path = ('/api/0/organizations/%s/events/?project=%s&dataset=errors&statsPeriod=90d&per_page=25'
            '&query=%s&field=release&field=count()&field=count_unique(issue)&sort=-count()'
            % (ORG, client.project_id, quote('is:unresolved')))
    payload, _ = client.get(path)
    totals = {}
    if not isinstance(payload, dict):
        return totals
    for row in payload.get('data') or []:
        if not isinstance(row, dict):
            continue
        version = str(row.get('release') or '')
        if not VERSION.fullmatch(version):
            continue
        totals[version] = {
            'events': row.get('count()') or 0,
            'seenReports': row.get('count_unique(issue)') or 0,
        }
    return totals


def short_ids(client, version):
    rows = client.issues('is:unresolved release:%s' % version, '90d')
    return sorted({str(row.get('shortId')) for row in rows if row.get('shortId')})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(HELPER))
    try:
        import sentry_api
    except ImportError:
        print('Sentry helper is not available.', file=sys.stderr)
        return 1
    try:
        client = sentry_api.Client(*sentry_api.credentials())
        client.verify_project()
        unresolved = [slim(row) for row in client.issues('is:unresolved', '90d') if row.get('shortId')]
        write_json(args.cache / 'unresolved.json', unresolved)
        releases = release_rows(client)
        totals = event_totals(client)
        for release in releases:
            extra = totals.get(release['version'], {})
            release['events'] = extra.get('events', 0)
            release['seenReports'] = extra.get('seenReports', 0)
        seen = {}
        for release in releases:
            if not release['version'][:1].isdigit():
                continue
            seen[release['version']] = short_ids(client, release['version'])
            print('%s %d' % (release['version'], len(seen[release['version']])), file=sys.stderr)
        resolved_hits = quiet_hits(client, 'is:resolved')
        ignored_hits = quiet_hits(client, 'is:ignored')
    except ValueError as error:
        print('Sentry read failed: %s' % error, file=sys.stderr)
        return 1
    write_json(args.cache / 'meta.json', {
        'releases': releases,
        'seen': seen,
        'resolvedHits': resolved_hits,
        'ignoredHits': ignored_hits,
    })
    print(json.dumps({
        'unresolved': len(unresolved),
        'releases': len(releases),
        'seen': len(seen),
        'resolvedHits': resolved_hits,
        'ignoredHits': ignored_hits,
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
