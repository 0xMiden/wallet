#!/usr/bin/env python3
"""Durable per-issue state for /walletissues, shared by up to three sessions. Standard library only."""
import argparse, contextlib, datetime, fcntl, json, os, re, subprocess, sys, tempfile

DEFAULT_PATH = os.path.expanduser('~/.claude/walletissues/ledger.json')
STATES = {'claimed', 'deferred', 'implementing', 'reviewing', 'ci', 'merged', 'parked', 'skipped',
          'needs-definition'}
FINISHED = {'merged', 'parked', 'skipped'}
# Reopened by claim: discovery offers it again once a human removes the label.
REOPENABLE = {'needs-definition'}
INT_FIELDS = {'pr', 'ci_attempts', 'waiting_on'}
# Work a session is carrying; deferred entries wait on another issue and are counted apart.
ACTIVE = {'claimed', 'implementing', 'reviewing', 'ci'}
SESSIONS_DIR = os.path.expanduser('~/.claude/sessions')
# A wallet issue or PR is keyed by its bare number; another repository's PR by `<name>#<number>`, so the two
# never collide (web-sdk PRs joined discovery on 2026-10-07).
OTHER_REPOS = {'web-sdk': '0xMiden/web-sdk'}


class LedgerError(Exception):
    pass


def parse_key(text):
    """The ledger key `text` names: a bare wallet number, or `<name>#<number>` for a repository in OTHER_REPOS."""
    match = re.fullmatch(r'(?:([a-z0-9-]+)#)?([0-9]+)', str(text))
    if not match or (match.group(1) is not None and match.group(1) not in OTHER_REPOS):
        others = ' or '.join('%s#N' % name for name in sorted(OTHER_REPOS))
        raise LedgerError('bad key %r (expected N, or %s)' % (text, others))
    name, number = match.group(1), int(match.group(2))
    return '%s#%d' % (name, number) if name else str(number)


def key_for(repo, number):
    """The ledger key of `repo`'s issue or PR `number`."""
    names = [name for name, full in OTHER_REPOS.items() if full == repo]
    return '%s#%d' % (names[0], number) if names else str(number)


def entry_key(entry):
    """An entry as reports name it: the wallet's bare number, or another repository's `<name>#<number>`."""
    return key_for(entry['repo'], entry['number']) if entry.get('repo') else entry['number']


def _order(entry):
    return (entry.get('repo', ''), entry['number'])


def _start_time(pid):
    out = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    if not out:
        return None
    return int(datetime.datetime.strptime(' '.join(out.split()), '%a %b %d %H:%M:%S %Y').timestamp())


def owner_for(pid):
    start = _start_time(pid)
    if start is None:
        raise LedgerError('no process %d' % pid)
    return 'wi-%d@%d' % (pid, start)


def session_owner():
    """The owner name of the Claude session running this command: its `claude` ancestor's pid and
    start time. Re-derivable on every call, so it survives context compaction; the start time stops
    a reused pid from impersonating a dead session."""
    pid = os.getppid()
    while pid > 1:
        out = subprocess.run(['ps', '-o', 'ppid=,comm=', '-p', str(pid)], capture_output=True, text=True).stdout.split()
        if len(out) < 2:
            break
        if os.path.basename(out[1]) == 'claude':
            return owner_for(pid)
        pid = int(out[0])
    raise LedgerError('not running under a claude process; pass --owner')


def alive(owner):
    try:
        pid, start = owner[len('wi-'):].split('@')
        return _start_time(int(pid)) == int(start)
    except (ValueError, TypeError):
        return False


def load(path=DEFAULT_PATH):
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError) as err:
        # Starting empty here would re-claim issues already merged or parked.
        raise LedgerError('unreadable ledger %s: %s' % (path, err))
    if not isinstance(data, dict):
        raise LedgerError('ledger %s is not an object' % path)
    return data


@contextlib.contextmanager
def _locked(path):
    # Every read-modify-write holds this lock, or two sessions lose each other's writes.
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _write(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or '.', prefix='.ledger-')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def _stamp(entry):
    entry['updated'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def update(path, number, owner, **fields):
    """Change an entry this session owns. Refuses another session's entry and an unclaimed issue."""
    if 'state' in fields and fields['state'] not in STATES:
        raise LedgerError('unknown state %r (expected one of %s)' % (fields['state'], sorted(STATES)))
    key = parse_key(number)
    with _locked(path):
        data = load(path)
        entry = data.get(key)
        if entry is None:
            raise LedgerError('issue %s is not claimed; claim it first' % number)
        if entry.get('owner') != owner:
            raise LedgerError('issue %s belongs to %s, not %s; drop it' % (number, entry.get('owner'), owner))
        entry.update(fields)
        _stamp(entry)
        _write(path, data)
    return entry


def claim(path, number, owner, **fields):
    """Take issue `number` for `owner`. True when it is now owner's. A live session's entry and a
    finished one are refused; a dead session's entry is adopted as it stands; a needs-definition
    entry reopens as claimed."""
    key = parse_key(number)
    with _locked(path):
        data = load(path)
        entry = data.get(key)
        if entry is None:
            name, _, digits = key.rpartition('#')
            entry = data[key] = {'number': int(digits), 'state': 'claimed'}
            if name:
                entry['repo'] = OTHER_REPOS[name]
        elif entry.get('state') in REOPENABLE:
            entry['state'] = 'claimed'
        elif entry.get('state') in FINISHED:
            return False
        elif entry.get('owner') != owner and alive(entry.get('owner', '')):
            return False
        entry.update(fields)
        entry['owner'] = owner
        entry.pop('released_by', None)
        _stamp(entry)
        _write(path, data)
    return True


def adopt(path, owner):
    """Take every unfinished entry whose session is dead. Returns the adopted entries' keys (entry_key)."""
    with _locked(path):
        data = load(path)
        taken = []
        for entry in sorted(data.values(), key=_order):
            state = entry.get('state')
            if state in FINISHED or state in REOPENABLE or entry.get('owner') == owner:
                continue
            if entry.get('released_by') and not entry.get('owner'):
                continue
            if not alive(entry.get('owner', '')):
                entry['owner'] = owner
                _stamp(entry)
                taken.append(entry_key(entry))
        if taken:
            _write(path, data)
    return taken


def release(path, number, owner, handoff):
    """Hand an unfinished entry this session owns to whichever session claims it next, as it stands,
    with a note saying where it stands. The entry has no owner until then, so adopt leaves it alone."""
    if not handoff:
        raise LedgerError('release needs a handoff note: where the issue stands and its next step')
    key = parse_key(number)
    with _locked(path):
        data = load(path)
        entry = data.get(key)
        if entry is None:
            raise LedgerError('issue %s is not claimed' % number)
        if entry.get('owner') != owner:
            raise LedgerError('issue %s belongs to %s, not %s' % (number, entry.get('owner'), owner))
        if entry.get('state') in FINISHED | REOPENABLE:
            raise LedgerError('issue %s is %s; only unfinished work is released' % (number, entry.get('state')))
        entry.update(owner='', released_by=owner, handoff=handoff)
        _stamp(entry)
        _write(path, data)
    return entry


def offered(path):
    """Released entries waiting for a session to claim them, oldest issue first."""
    return sorted((e for e in load(path).values() if e.get('released_by') and not e.get('owner')),
                  key=_order)


def _session_name(owner):
    try:
        pid = int(owner[len('wi-'):].split('@')[0])
        with open(os.path.join(SESSIONS_DIR, '%d.json' % pid)) as f:
            return json.load(f).get('name')
    except (OSError, ValueError, AttributeError):
        return None


def session_load(path):
    """Per live session that owns any entry: how many issues it is working (active) and waiting on
    (deferred), and its session name for SendMessage."""
    counts = {}
    for entry in load(path).values():
        owner = entry.get('owner')
        if not owner or not alive(owner):
            continue
        row = counts.setdefault(owner, {'active': 0, 'deferred': 0, 'name': _session_name(owner)})
        if entry.get('state') in ACTIVE:
            row['active'] += 1
        elif entry.get('state') == 'deferred':
            row['deferred'] += 1
    return counts


def mine(path, owner):
    """This session's unfinished entries, oldest issue first."""
    return sorted((e for e in load(path).values()
                   if e.get('owner') == owner and e.get('state') not in FINISHED | REOPENABLE),
                  key=_order)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--path', default=DEFAULT_PATH)
    parser.add_argument('--owner', help='defaults to this Claude session (its claude pid and start time)')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('show')
    sub.add_parser('whoami')
    sub.add_parser('mine')
    sub.add_parser('adopt')
    sub.add_parser('load')
    sub.add_parser('offered')
    releasep = sub.add_parser('release')
    releasep.add_argument('number', help='N, or web-sdk#N')
    releasep.add_argument('handoff')
    claimp = sub.add_parser('claim')
    claimp.add_argument('number', help='N, or web-sdk#N')
    claimp.add_argument('pairs', nargs='*')
    setp = sub.add_parser('set')
    setp.add_argument('number', help='N, or web-sdk#N')
    setp.add_argument('pairs', nargs='+')
    args = parser.parse_args(argv)
    if args.cmd == 'show':
        print(json.dumps(load(args.path), indent=2, sort_keys=True))
        return 0
    if args.cmd == 'offered':
        print(json.dumps(offered(args.path), indent=2, sort_keys=True))
        return 0
    if args.cmd == 'load':
        print(json.dumps(session_load(args.path), indent=2, sort_keys=True))
        return 0
    owner = args.owner or session_owner()
    if args.cmd == 'whoami':
        print(owner)
        return 0
    if args.cmd == 'mine':
        print(json.dumps(mine(args.path, owner), indent=2, sort_keys=True))
        return 0
    if args.cmd == 'adopt':
        print(json.dumps(adopt(args.path, owner)))
        return 0
    if args.cmd == 'release':
        print(json.dumps(release(args.path, args.number, owner, args.handoff), indent=2, sort_keys=True))
        return 0
    fields = parse_pairs(args.pairs)
    if args.cmd == 'claim':
        # Fields land in the claim's own locked write, so a PR is never briefly an issue-shaped entry.
        won = claim(args.path, args.number, owner, **fields)
        print('claimed' if won else 'taken')
        return 0 if won else 3
    print(json.dumps(update(args.path, args.number, owner, **fields), indent=2, sort_keys=True))
    return 0


def parse_pairs(pairs):
    fields = {}
    for pair in pairs:
        key, sep, value = pair.partition('=')
        if not sep or not key or key in {'number', 'owner', 'repo'}:
            raise LedgerError('bad field %r (expected key=value; number, owner and repo are not settable)' % pair)
        if key in INT_FIELDS:
            try:
                value = int(value)
            except ValueError:
                raise LedgerError('%s must be an integer, got %r' % (key, value))
        fields[key] = value
    return fields


if __name__ == '__main__':
    try:
        sys.exit(main())
    except LedgerError as err:
        print('ledger: %s' % err, file=sys.stderr)
        sys.exit(2)
