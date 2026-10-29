// 取本刀实例「小说浏览器」页面的 CDP ws 地址（只读）。
export async function pageWs(port = 37496) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const t = list.find((x) => x.type === 'page' && x.title === '小说浏览器')
  if (!t) throw new Error('no 小说浏览器 page target: ' + JSON.stringify(list.map((x) => [x.type, x.title])))
  return t.webSocketDebuggerUrl
}
