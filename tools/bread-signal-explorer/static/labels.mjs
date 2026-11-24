// Shared phrases that show up on almost every report. A tile should name what
// sets it apart, not the boilerplate around it.
const FILLER = [
  'realm unknown',
  'real unknown',
  'proving preference delegated',
  'platform extension',
  'platform android',
  'platform ios',
  'layout unavailable',
  'commitment match',
  'authentication preparation unavailable',
]

function words(value) {
  return String(value || '').replace(/[_./]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function filler(part) {
  const text = part.toLowerCase().replace(/…$/, '').trim()
  if (text.length < 4) return true
  if (/^stage\s/.test(text) || /^surface\s/.test(text)) return true
  return FILLER.some((item) => text.includes(item) || (text.length >= 6 && item.startsWith(text)))
}

export function captionFor(label) {
  const cleaned = String(label || '')
    .replace(/^WalletTransactionFailure:\s*/i, '')
    .replace(/^WalletUserVisibleError:\s*/i, '')
  const parts = cleaned.split(';').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return { kicker: '', text: '' }
  const first = parts[0]
    .replace(/^transaction failed:\s*/i, '')
    .replace(/^transaction unconfirmed:\s*/i, '')
    .replace(/^user-visible error:\s*/i, '')
    .trim()
  // The specific reason is the first detail. Later segments repeat on almost every report,
  // and a truncated title often ends in the middle of one of them.
  const specific = parts.slice(1).find((part) => !filler(part)) || ''
  if (!specific || specific.toLowerCase() === first.toLowerCase()) return { kicker: '', text: words(first) }
  return { kicker: words(first), text: words(specific) }
}
