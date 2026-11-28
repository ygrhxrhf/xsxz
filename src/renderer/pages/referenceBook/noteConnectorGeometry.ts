export interface Point { x: number; y: number }
interface Connector { start: Point; end: Point }
const EPSILON = 1e-6

const distanceSquared = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

function validQuad(points: readonly Point[]) {
  if (points.length !== 4 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false
  let winding = 0
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < EPSILON || (winding && Math.sign(cross) !== winding)) return false
    winding = Math.sign(cross)
  }
  return true
}

/** Separating axes catch crossing edges as well as full containment. */
function overlaps(a: readonly Point[], b: readonly Point[]) {
  for (const polygon of [a, b]) for (let i = 0; i < 4; i++) {
    const p = polygon[i], q = polygon[(i + 1) % 4]
    const x = p.y - q.y, y = q.x - p.x
    const pa = a.map((v) => v.x * x + v.y * y)
    const pb = b.map((v) => v.x * x + v.y * y)
    if (Math.max(...pa) < Math.min(...pb) - EPSILON || Math.max(...pb) < Math.min(...pa) - EPSILON) return false
  }
  return true
}

function onSegment(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** The shortest boundary-to-boundary link never passes through either convex sheet. */
export function noteConnector(note: readonly Point[], passages: readonly (readonly Point[])[]): Connector | null {
  if (!validQuad(note)) return null
  let best: Connector | null = null
  let distance = Infinity
  for (const passage of passages) {
    if (!validQuad(passage)) continue
    // A note over its own passage needs no connector. Do not jump to another line.
    if (overlaps(note, passage)) return null
    const consider = (start: Point, end: Point) => {
      const d = distanceSquared(start, end)
      if (d < distance) { distance = d; best = { start, end } }
    }
    for (const point of note) for (let i = 0; i < 4; i++) consider(point, onSegment(point, passage[i], passage[(i + 1) % 4]))
    for (const point of passage) for (let i = 0; i < 4; i++) consider(onSegment(point, note[i], note[(i + 1) % 4]), point)
  }
  return distance >= 8 ** 2 ? best : null
}


