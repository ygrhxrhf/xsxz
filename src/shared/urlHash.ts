/**
 * Shared URL canonicalize for hash-router catalogs and classic HTML catalogs.
 * Keep path-like hashes (`#/book/65/`); drop in-page fragments (`#top`, `#content`).
 * Never rewrite `#/` into pathname (empty SPA shell).
 */

/** `#/` plus a non-empty route. Home `#/` is not path-like. */
export function isPathLikeHash(hash: string): boolean {
  if (!hash.startsWith('#/')) return false
  return hash.slice(2).replace(/\/+$/, '').length > 0
}

function stripTrailingSlashOnPathLikeHash(hash: string): string {
  if (!isPathLikeHash(hash)) return hash
  const trimmed = hash.replace(/\/+$/, '')
  return trimmed.length > 1 ? trimmed : hash
}

function leftoverSearchBeforeHash(href: string): string {
  return href.replace(/\?(?=#|$)/, '')
}

export function canonicalizeUrl(url: string): string {
  const u = new URL(url)

  if (isPathLikeHash(u.hash)) {
    const inner = u.hash.slice(1)
    const second = inner.indexOf('#')
    u.hash = '#' + (second === -1 ? inner : inner.slice(0, second))
    u.hash = stripTrailingSlashOnPathLikeHash(u.hash)
  } else {
    u.hash = ''
  }

  for (const key of [...u.searchParams.keys()]) {
    const lower = key.toLowerCase()
    if (lower === 'page' || lower.startsWith('utm_')) u.searchParams.delete(key)
  }
  if (u.searchParams.toString() === '') u.search = ''

  if (u.pathname.length > 1) {
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'
  }

  let href = leftoverSearchBeforeHash(u.toString())
  href = href.replace(/[?&]+$/g, '')
  if (!isPathLikeHash(new URL(href).hash)) {
    href = href.replace(/\/+$/, '')
  }
  return href
}
