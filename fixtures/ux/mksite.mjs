// 生成本地合成小说站 fixture（三种编码场景），用于人肉体验测试。
// 输出目录默认 fixtures/ux/site-root（已在 .gitignore），也可以用第一个参数指定。
import { mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(HERE, 'site-root')
const chapters = [
  ['第一章 破庙夜雨', '沈砚在破庙里醒来的时候，雨已经下了整整一夜。'],
  ['第二章 半卷残经', '那半卷经文摊在膝上，纸页泛黄，边角被虫蛀出细密的孔。'],
  ['第三章 城隍庙前', '城隍庙前的石狮子缺了半只耳朵，香炉里插着三根燃尽的香。'],
  ['第四章 卖炭老翁', '卖炭的老翁推着独轮车，在雪地里留下一道歪斜的车辙。'],
  ['第五章 铁匠铺', '铁匠铺里火光冲天，锤声一下一下，砸得人耳膜发疼。'],
  ['第六章 夜探粮仓', '粮仓的墙很高，墙上拉着铁丝，铁丝上挂着几只风干的麻雀。'],
  ['第七章 血溅长街', '长街上的血被雨水冲淡，流进路边的排水沟，颜色像淡了的墨。'],
  ['第八章 一盏孤灯', '孤灯下，他把那半卷经文抄了一遍，又烧了一遍。'],
  ['第九章 旧识重逢', '“沈砚。”有人在背后叫他的名字，声音很轻，却让他握紧了拳。'],
  ['第十章 断剑重铸', '断剑投入炉中的时候，火苗猛地蹿高，照亮了整间屋子。'],
  ['第十一章 别', '他说要走，她没有留。'],
  ['第十二章 客舟', '客舟离岸的时候，岸上无人相送，只有雨还在下。'],
]

function chapterHtml(title, firstLine, withCharset) {
  const body = [
    firstLine,
    '这一段是正文的第二段，用来验证正文段落的换行与间距是否正常，也顺便看看有没有残留的导航文字。',
    '“你到底是谁？”他终于开口，声音里带着一丝不易察觉的颤抖。',
    '对方没有回答，只是抬起手，指了指窗外那片被雨浇透的夜色。',
    '他顺着看过去，只看见檐角垂下的雨帘，以及雨帘之外一盏将灭未灭的灯笼。',
    '（本章完）',
    '本站所有小说为转载作品，所有章节均由网友上传，转载至本站只是为了宣传本书让更多读者欣赏。',
  ].join('\n\n')
  return `<!DOCTYPE html>
<html>
<head>${withCharset ? '\n<meta charset="utf-8">' : ''}
<title>${title} - 残经 - 测试书站</title>
</head>
<body>
<div class="header"><a href="index.html">测试书站</a> &gt; 残经</div>
<div class="nav"><a href="index.html">目录</a><a href="index.html">上一章</a><a href="index.html">下一章</a></div>
<h1>${title}</h1>
<div id="content">
${body}
</div>
<div class="footer">广告位招租 联系站长</div>
</body>
</html>
`
}

function catalogHtml(withCharset) {
  const items = chapters
    .map(([t], i) => `      <dd><a href="c${i + 1}.html">${t}</a></dd>`)
    .join('\n')
  return `<!DOCTYPE html>
<html>
<head>${withCharset ? '\n<meta charset="utf-8">' : ''}
<title>残经 - 测试书站</title>
</head>
<body>
<div class="header">测试书站</div>
<h1>残经</h1>
<div class="bookinfo"><span class="author">佚名</span><span class="status">连载中</span></div>
<div class="intro">一个关于旧书、雨夜和断剑的故事，共十二章。</div>
<div id="list">
  <dl>
    <dt>正文</dt>
${items}
  </dl>
</div>
<div class="footer">本站所有小说为转载作品</div>
</body>
</html>
`
}

function writeSite(dir, withCharset, encoding) {
  mkdirSync(dir, { recursive: true })
  const enc = (s) => (encoding === 'gbk' ? execSync('iconv -f utf-8 -t gbk', { input: s }) : Buffer.from(s, 'utf8'))
  writeFileSync(join(dir, 'index.html'), enc(catalogHtml(withCharset)))
  chapters.forEach(([t, l], i) => writeFileSync(join(dir, `c${i + 1}.html`), enc(chapterHtml(t, l, withCharset))))
}

writeSite(join(ROOT, 'site'), true, 'utf8') // 规范站：UTF-8 + charset
writeSite(join(ROOT, 'site-nocharset'), false, 'utf8') // 老站：UTF-8 但不声明 charset
writeSite(join(ROOT, 'site-gbk'), true, 'gbk') // 国内常见：GBK + 声明 charset=gbk

// 章节页：GBK 声明
const gbkMeta = (p) => p.replace('<meta charset="utf-8">', '<meta charset="gbk">')
for (const f of ['index.html', ...chapters.map((_, i) => `c${i + 1}.html`)]) {
  const raw = execSync(`iconv -f gbk -t utf-8 ${join(ROOT, 'site-gbk', f)}`).toString()
  writeFileSync(join(ROOT, 'site-gbk', f), execSync('iconv -f utf-8 -t gbk', { input: gbkMeta(raw) }))
}
console.log('site fixtures ready')
