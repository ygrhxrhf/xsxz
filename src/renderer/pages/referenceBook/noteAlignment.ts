interface Point { x: number; y: number }
interface Sheet { x: number; y: number; z: number; size: number; curlRise: number }

/** Match the inner paper edge to the adjacent book edge in the current camera projection. */
export function alignedNoteRotation(sheet: Sheet, side: 1 | -1, bookEdge: [Point, Point], project: (x: number, y: number, z: number) => Point) {
  const [a, b] = bookEdge
  const bx = b.x - a.x, by = b.y - a.y
  if (Math.hypot(bx, by) < 1e-6) return 0
  const half = sheet.size / 2, innerX = -side * half
  const error = (rotation: number) => {
    const c = Math.cos(rotation), s = Math.sin(rotation)
    const top = project(sheet.x + innerX * c - half * s, sheet.y + innerX * s + half * c, sheet.z)
    const bottom = project(sheet.x + innerX * c + half * s, sheet.y + innerX * s - half * c, sheet.z + sheet.curlRise)
    const nx = bottom.x - top.x, ny = bottom.y - top.y
    return Math.atan2(nx * by - ny * bx, nx * bx + ny * by)
  }
  let rotation = 0
  // A small camera-dependent correction also accounts for the paper's curled lower edge.
  for (let i = 0; i < 5; i++) {
    const e = error(rotation)
    if (!Number.isFinite(e) || Math.abs(e) < 1e-7) break
    const slope = (error(rotation + 0.001) - error(rotation - 0.001)) / 0.002
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-6) break
    rotation = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, rotation - e / slope))
  }
  return rotation
}


