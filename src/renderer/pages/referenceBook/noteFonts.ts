import { t } from './i18n'
import { noteFont } from './noteText'

export async function ensureNoteFont(text: string) {
  if (noteFont(text).cjk) await document.fonts.load('500 20px "LXGW WenKai"', text)
  else await document.fonts.load('600 20px "Caveat Variable"', text || t("Note"))
}


