// Squarified treemap. Values are areas; the result tiles the given box.

function worst(row, side) {
  const sum = row.reduce((total, item) => total + item.size, 0)
  const max = Math.max(...row.map((item) => item.size))
  const min = Math.min(...row.map((item) => item.size))
  const side2 = side * side
  const sum2 = sum * sum
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min))
}

function placeRow(row, rect) {
  const sum = row.reduce((total, item) => total + item.size, 0)
  const placed = []
  if (rect.w >= rect.h) {
    const thickness = rect.h === 0 ? 0 : sum / rect.h
    let y = rect.y
    for (const item of row) {
      const height = thickness === 0 ? 0 : item.size / thickness
      placed.push({ ...item, x: rect.x, y, w: thickness, h: height })
      y += height
    }
    return { placed, rest: { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h } }
  }
  const thickness = rect.w === 0 ? 0 : sum / rect.w
  let x = rect.x
  for (const item of row) {
    const width = thickness === 0 ? 0 : item.size / thickness
    placed.push({ ...item, x, y: rect.y, w: width, h: thickness })
    x += width
  }
  return { placed, rest: { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness } }
}

export function layout(items, width, height) {
  const usable = items.filter((item) => item.value > 0)
  const total = usable.reduce((sum, item) => sum + item.value, 0)
  if (total <= 0 || width <= 0 || height <= 0) return []
  const area = width * height
  let pending = usable
    .map((item) => ({ ...item, size: (item.value / total) * area }))
    .sort((a, b) => b.size - a.size)
  let rect = { x: 0, y: 0, w: width, h: height }
  const placed = []
  while (pending.length) {
    const side = Math.min(rect.w, rect.h)
    const row = [pending[0]]
    let index = 1
    while (index < pending.length && worst(row, side) >= worst(row.concat(pending[index]), side)) {
      row.push(pending[index])
      index += 1
    }
    const step = placeRow(row, rect)
    placed.push(...step.placed)
    rect = step.rest
    pending = pending.slice(row.length)
  }
  return placed
}
