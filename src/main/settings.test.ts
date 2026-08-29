import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-settings-test' },
  safeStorage: {
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

import { DEFAULT_READER_PREFS } from '../shared/types'
import { normalizeReaderPrefs } from './settings'

describe('normalizeReaderPrefs', () => {
  it('returns defaults for missing or damaged reader settings', () => {
    expect(normalizeReaderPrefs(undefined)).toEqual(DEFAULT_READER_PREFS)
    expect(normalizeReaderPrefs('broken')).toEqual(DEFAULT_READER_PREFS)
  })

  it('prefers a valid new theme over the legacy nightMode field', () => {
    expect(normalizeReaderPrefs({ theme: 'sepia', nightMode: true }).theme).toBe('sepia')
    expect(normalizeReaderPrefs({ theme: 'gray', nightMode: false }).theme).toBe('gray')
  })

  it('migrates legacy nightMode only when the new theme is absent or invalid', () => {
    expect(normalizeReaderPrefs({ nightMode: true }).theme).toBe('night')
    expect(normalizeReaderPrefs({ nightMode: false }).theme).toBe('paper')
    expect(normalizeReaderPrefs({ theme: 'invalid', nightMode: true }).theme).toBe('night')
  })

  it('keeps valid enum and boolean fields while defaulting invalid fields independently', () => {
    expect(
      normalizeReaderPrefs({
        fontFamily: 'mono',
        contentWidth: 'wide',
        paragraphSpacing: 'relaxed',
        paragraphIndent: false,
      }),
    ).toMatchObject({
      fontFamily: 'mono',
      contentWidth: 'wide',
      paragraphSpacing: 'relaxed',
      paragraphIndent: false,
    })

    expect(
      normalizeReaderPrefs({
        fontFamily: 'comic',
        contentWidth: 'huge',
        paragraphSpacing: 'loose',
        paragraphIndent: 'yes',
      }),
    ).toMatchObject({
      fontFamily: DEFAULT_READER_PREFS.fontFamily,
      contentWidth: DEFAULT_READER_PREFS.contentWidth,
      paragraphSpacing: DEFAULT_READER_PREFS.paragraphSpacing,
      paragraphIndent: DEFAULT_READER_PREFS.paragraphIndent,
    })
  })

  it('clamps finite numeric fields and defaults non-finite values', () => {
    expect(normalizeReaderPrefs({ fontSize: 8, lineHeight: 0.5 })).toMatchObject({
      fontSize: 12,
      lineHeight: 1.2,
    })
    expect(normalizeReaderPrefs({ fontSize: 80, lineHeight: 9 })).toMatchObject({
      fontSize: 36,
      lineHeight: 3,
    })
    expect(normalizeReaderPrefs({ fontSize: Number.NaN, lineHeight: Number.POSITIVE_INFINITY })).toMatchObject({
      fontSize: DEFAULT_READER_PREFS.fontSize,
      lineHeight: DEFAULT_READER_PREFS.lineHeight,
    })
  })
})
