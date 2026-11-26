import type { Point } from './noteConnectorGeometry'

export interface NoteLink { id: string; start: Point; end: Point }
const NS = 'http://www.w3.org/2000/svg'

/** Decorative screen-space links; never intercept reading or dragging gestures. */
export class NoteLinkLayer {
  private root = document.createElementNS(NS, 'svg')
  private paths = new Map<string, SVGPathElement>()

  constructor(parent: HTMLElement) {
    this.root.classList.add('note-connectors')
    this.root.setAttribute('aria-hidden', 'true')
    this.root.setAttribute('focusable', 'false')
    parent.appendChild(this.root)
  }

  update(links: NoteLink[]) {
    const ids = new Set(links.map((link) => link.id))
    for (const [id, path] of this.paths) if (!ids.has(id)) {
      path.remove()
      this.paths.delete(id)
    }
    for (const { id, start, end } of links) {
      let path = this.paths.get(id)
      if (!path) {
        path = document.createElementNS(NS, 'path')
        path.dataset.noteId = id
        this.paths.set(id, path)
        this.root.appendChild(path)
      }
      path.setAttribute('d', `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} L ${end.x.toFixed(2)} ${end.y.toFixed(2)}`)
    }
  }

  dispose() { this.root.remove() }
}


