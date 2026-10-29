import assert from 'node:assert/strict'
import test from 'node:test'
import { captionFor } from './static/labels.mjs'
import { layout } from './static/layout.mjs'
import { areaOf, bucketOf, buildSnapshot, redact, signature } from './snapshot.mjs'

test('a long report keeps its specific tail', () => {
  const title = 'WalletTransactionFailure: Transaction failed: tx_receive; stage sending; realm unknown; proving preference delegated; platform extension; step claim_fee'
  const snapshot = buildSnapshot({
    issues: [issue('BREAD-1', title)],
    ledger: { issues: {} },
    now: '2026-10-27T12:00:00Z',
  })
  assert.match(snapshot.issues[0].clusterLabel, /claim_fee/)
  assert.match(snapshot.issues[0].clusterLabel, /Transaction failed/)
})

test('stage in the report names the area, and a surface is the fallback', () => {
  assert.equal(areaOf('WalletTransactionFailure: Transaction stage: signing; stage signing').id, 'stage:signing')
  assert.equal(areaOf('WalletUserVisibleError: something; surface status_screen').label, 'Status screen')
  assert.equal(areaOf('TypeError: Cannot read properties of null').id, 'other')
})

test('a number changing in the message does not split a cluster, an email is not kept', () => {
  assert.equal(signature('Failed after 3 tries'), signature('Failed after 9 tries'))
  assert.notEqual(signature('Failed after 3 tries'), signature('Failed after 3 notes'))
  assert.equal(redact('write to ada@example.com about 0xabc123def456'), 'write to … about 0x…')
})

test('two reports with the same cause share a cluster, and a duplicate follows them', () => {
  const snapshot = buildSnapshot({
    issues: [
      issue('BREAD-1', 'WalletTransactionFailure: Transaction stage: signing; stage signing; fee short 3'),
      issue('BREAD-2', 'WalletTransactionFailure: Transaction stage: submitting; stage submitting; other fault'),
      issue('BREAD-3', 'WalletTransactionFailure: Transaction stage: signing; stage signing; fee short 9'),
    ],
    ledger: {
      issues: {
        'BREAD-1': { status: 'fixing', stage: 'reviewing', fix_group: 'fee-shortfall', pr: 12 },
        'BREAD-2': { status: 'duplicate', duplicate_of: 'BREAD-1' },
        'BREAD-3': { status: 'new' },
      },
    },
    now: '2026-10-27T12:00:00Z',
  })
  const byKey = Object.fromEntries(snapshot.issues.map((row) => [row.key, row]))
  assert.equal(byKey['BREAD-1'].clusterId, byKey['BREAD-2'].clusterId)
  assert.equal(byKey['BREAD-1'].kind, 'work')
  assert.notEqual(byKey['BREAD-1'].clusterId, byKey['BREAD-3'].clusterId)
  assert.equal(byKey['BREAD-1'].bucket, 'in_progress')
  assert.equal(byKey['BREAD-3'].clusterArea, 'stage:signing')
  assert.equal(bucketOf({ status: 'merged', regressed: true }), 'regressed')
})

test('a fix lands in the release that was current, and a regression is not closed', () => {
  const releases = [
    { version: '1.17.7', created: '2026-10-26T00:00:00Z' },
    { version: '1.17.8', created: '2026-10-27T00:00:00Z' },
  ]
  const snapshot = buildSnapshot({
    issues: [
      issue('BREAD-1', 'WalletTransactionFailure: Transaction stage: proving; stage proving'),
      issue('BREAD-2', 'WalletTransactionFailure: Transaction stage: sending; stage sending'),
      issue('BREAD-3', 'plain failure'),
    ],
    ledger: {
      issues: {
        'BREAD-1': { status: 'merged', fixed_at: '2026-10-27T08:00:00Z', outcome: 'fix' },
        'BREAD-2': { status: 'not-actionable', history: [{ at: '2026-10-26T12:00:00Z', status: 'not-actionable' }] },
        'BREAD-3': { status: 'merged', fixed_at: '2026-10-27T09:00:00Z', regressed: true },
      },
    },
    releases,
    seen: { '1.17.8': ['BREAD-1', 'BREAD-3'], '1.17.7': ['BREAD-2'] },
    now: '2026-10-27T12:00:00Z',
  })
  const byKey = Object.fromEntries(snapshot.issues.map((row) => [row.key, row]))
  assert.equal(byKey['BREAD-1'].closedDuring, '1.17.8')
  assert.equal(byKey['BREAD-2'].closedDuring, '1.17.7')
  assert.equal(byKey['BREAD-3'].closedDuring, null)
  assert.equal(byKey['BREAD-3'].bucket, 'regressed')
  assert.deepEqual(byKey['BREAD-1'].seenIn, ['1.17.8'])
  assert.equal(byKey['BREAD-1'].needs, '')
  assert.equal(snapshot.meta.closedUnplaced, 0)
})

test('needs text loses an address and the ledger-only report stays out of the sentry count', () => {
  const snapshot = buildSnapshot({
    issues: [issue('BREAD-1', 'TypeError: failed')],
    ledger: {
      updated: '2026-10-27T00:00:00Z',
      issues: {
        'BREAD-1': { status: 'blocked', needs: 'see ada@example.com and 0xdeadbeefcafe' },
        'BREAD-2': { status: 'already-fixed', title: 'old report', count: 4, fixed_at: '2026-01-01T00:00:00Z' },
      },
    },
    releases: [{ version: '1.17.8', created: '2026-10-27T00:00:00Z' }],
    now: '2026-10-27T12:00:00Z',
  })
  const blocked = snapshot.issues.find((row) => row.key === 'BREAD-1')
  assert.equal(blocked.bucket, 'needs_evidence')
  assert.equal(blocked.needs.includes('@'), false)
  assert.equal(blocked.needs.includes('0xdeadbeefcafe'), false)
  assert.equal(snapshot.counts.sentry, 1)
  assert.equal(snapshot.counts.ledgerOnly, 1)
  assert.equal(snapshot.meta.closedUnplaced, 1)
  assert.equal(snapshot.meta.oldestRelease, '1.17.8')
})

test('a map tile names the specific failure, not the shared boilerplate', () => {
  const caption = captionFor('WalletTransactionFailure: Transaction failed: tx_receive; stage sending; offscreen_aborted_transport; authentication preparation unavailable; layout unavailable; commitment m')
  assert.equal(caption.kicker, 'tx receive')
  assert.equal(caption.text, 'offscreen aborted transport')
  assert.deepEqual(captionFor('Sending'), { kicker: '', text: 'Sending' })
})

test('treemap keeps the area id used to zoom', () => {
  const placed = layout([{ id: 'stage:signing', value: 2, area: 'stage:signing' }], 100, 80)
  assert.equal(placed[0].area, 'stage:signing')
})

test('treemap tiles cover the box', () => {
  const placed = layout(
    [
      { id: 'a', value: 2 },
      { id: 'b', value: 1 },
      { id: 'c', value: 1 },
    ],
    100,
    80,
  )
  assert.equal(placed.length, 3)
  const area = placed.reduce((sum, item) => sum + item.w * item.h, 0)
  assert.ok(Math.abs(area - 8000) < 1)
  for (const item of placed) {
    assert.ok(item.w > 0 && item.h > 0)
    assert.ok(item.x >= -0.001 && item.y >= -0.001)
    assert.ok(item.x + item.w <= 100.001)
    assert.ok(item.y + item.h <= 80.001)
  }
})

function issue(shortId, title) {
  return {
    shortId,
    id: shortId.slice(-1),
    title,
    count: 10,
    userCount: 0,
    level: 'error',
    substatus: 'new',
    isUnhandled: false,
    firstSeen: '2026-10-01T00:00:00Z',
    lastSeen: '2026-10-20T00:00:00Z',
    permalink: 'https://miden.sentry.io/issues/1/',
    stats: { '24h': [[100, 2], [200, 3]] },
  }
}
