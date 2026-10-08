import type { SiteRule } from '../shared/types'

// Keep these narrow: the same browser view is also used for login and navigation.
const DEFAULT_AD_SELECTORS = [
  'ins.adsbygoogle',
  '[data-ad-client]',
  '[data-ad-slot]',
  '[id^="ad-banner"]',
  '[id^="ad_banner"]',
  '[class~="ad-banner"]',
  '[class~="ads-banner"]',
  '[class~="ad-overlay"]',
  '[class~="ad-popup"]',
  '[id^="ad-overlay"]',
  '[id^="ad-popup"]',
  '[id*="advertisement"]',
  '[class*="advertisement"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="doubleclick.net"]',
]

function customSelectors(input?: string): string[] {
  return (input ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || /[,{};@]/.test(line)) return false
    if (/^(?:\*|html|body|:root)$/i.test(line)) return false
    return true
  })
}

/** Only CSS is inserted into the visible browser view; page DOM and requests stay intact. */
export function browserAdCss(rule?: SiteRule): string {
  if (rule?.adFilterEnabled === false) return ''
  return [...DEFAULT_AD_SELECTORS, ...customSelectors(rule?.adHideSelectors)]
    .map((selector) => `${selector} { display: none !important; }`)
    .join('\n')
}
