import { t } from './i18n'
export interface ImageLink {
  key: string
  path: string
  alt: string
  x: number
  y: number
}

/** Small keyboard-accessible links anchored to the same curved surfaces as the printed images. */
export class ImageLinkLayer {
  private root = document.createElement('div')
  private items = new Map<string, HTMLDivElement>()
  private preview: (path: string) => void

  constructor(parent: HTMLElement, preview: (path: string) => void) {
    this.preview = preview
    this.root.className = 'page-image-links'
    this.root.dataset.ui = ''
    parent.appendChild(this.root)
  }

  update(links: ImageLink[]) {
    const keys = new Set(links.map((link) => link.key))
    for (const [key, item] of this.items) if (!keys.has(key)) {
      item.remove()
      this.items.delete(key)
    }
    for (const link of links) {
      let item = this.items.get(link.key)
      if (!item) {
        item = document.createElement('div')
        item.className = 'page-image-actions'
        // The printed image is hit-tested in 3D; expose the same preview to keyboard readers.
        const preview = document.createElement('button')
        preview.type = 'button'
        preview.className = 'page-image-preview-link'
        preview.dataset.bookImage = link.path
        preview.textContent = t("预览图片")
        preview.setAttribute('aria-label', link.alt ? t("预览图片：{0}", link.alt) : t("预览书中图片"))
        preview.onclick = () => this.preview(link.path)
        item.appendChild(preview)
        this.root.appendChild(item)
        this.items.set(link.key, item)
      }
      item.style.left = `${link.x}px`
      item.style.top = `${link.y}px`
    }
  }

  setVisible(visible: boolean) { this.root.style.visibility = visible ? '' : 'hidden' }

  dispose() { this.root.remove() }
}


