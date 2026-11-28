import { t } from './i18n'
export interface NoteHandle {
  id: string
  x: number
  y: number
  // Projected paper axes per unit, allowing the handle to follow its scale and tilt.
  ax: number
  ay: number
  bx: number
  by: number
  order: number
}

const NS = 'http://www.w3.org/2000/svg'

/** Screen-space drag handles keep notes reachable above the page text layer. */
export class NoteHandleLayer {
  private root = document.createElement('div')
  private buttons = new Map<string, HTMLButtonElement>()

  constructor(parent: HTMLElement) {
    this.root.className = 'note-drag-handles'
    this.root.dataset.ui = ''
    parent.appendChild(this.root)
  }

  update(handles: NoteHandle[]) {
    const ids = new Set(handles.map((handle) => handle.id))
    for (const [id, button] of this.buttons) if (!ids.has(id)) {
      button.remove()
      this.buttons.delete(id)
    }

    for (const { id, x, y, ax, ay, bx, by, order } of handles) {
      let button = this.buttons.get(id)
      if (!button) {
        button = document.createElement('button')
        button.className = 'note-drag-handle'
        button.type = 'button'
        button.dataset.noteId = id
        button.setAttribute('aria-label', t("拖动便笺"))
        button.title = t("拖动便笺")
        button.tabIndex = -1

        const icon = document.createElementNS(NS, 'svg')
        icon.setAttribute('viewBox', '0 0 16 20')
        icon.setAttribute('aria-hidden', 'true')
        icon.setAttribute('focusable', 'false')
        for (const cy of [4, 10, 16]) for (const cx of [5, 11]) {
          const dot = document.createElementNS(NS, 'circle')
          dot.setAttribute('cx', String(cx))
          dot.setAttribute('cy', String(cy))
          dot.setAttribute('r', '1.45')
          dot.setAttribute('fill', 'currentColor')
          icon.appendChild(dot)
        }
        button.appendChild(icon)

        // Pointer dragging is owned by the scene; suppress release clicks here.
        const stopClick = (event: MouseEvent) => {
          event.preventDefault()
          event.stopPropagation()
        }
        button.addEventListener('click', stopClick)
        button.addEventListener('dblclick', stopClick)
        this.buttons.set(id, button)
        this.root.appendChild(button)
      }

      button.style.transform = `matrix(${ax}, ${ay}, ${bx}, ${by}, ${x}, ${y})`
      // Preserve a usable transparent target at small scales without enlarging the visible dots.
      const extra = (scale: number) => Math.min(22, Math.max(0, 14 / Math.max(scale, 0.001) - 14))
      button.style.setProperty('--handle-hit-x', `${extra(Math.hypot(ax, ay))}px`)
      button.style.setProperty('--handle-hit-y', `${extra(Math.hypot(bx, by))}px`)
      button.style.zIndex = String(order)
    }
  }

  dispose() {
    this.root.remove()
    this.buttons.clear()
  }
}


