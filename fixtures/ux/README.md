# 本机体验测试夹具

用来手工复现「内置浏览 → 下载本书 → 书库 / 阅读器 → AI」这条主路径，
不需要连真实站点。全部离线、合成文本、不含任何真实站点内容。

```bash
node fixtures/ux/mksite.mjs          # 生成三种编码场景到 fixtures/ux/site-root/
node fixtures/ux/server.mjs          # 起三个静态站（前台占用终端）
```

| 端口 | 目录 | 特征 |
|---|---|---|
| 5180 | `site-root/site` | UTF-8 且声明 `charset=utf-8`（规范站） |
| 5181 | `site-root/site-nocharset` | UTF-8 但不声明 charset（老站，要猜编码） |
| 5182 | `site-root/site-gbk` | GBK 且声明 `charset=gbk` |

在浏览页打开 `http://127.0.0.1:5180/index.html`，然后「下载本书」即可。
三个站点目录名、章节名与正文完全一致，只有编码和 charset 声明不同，
方便对比同一步骤在三种编码下的落盘结果。

`mock-ai.mjs` 是一个不联网的 OpenAI 兼容假服务：

```bash
node fixtures/ux/mock-ai.mjs         # 监听 127.0.0.1:18080
```

在设置页把「接口地址」指向 `http://127.0.0.1:18080/v1`、密钥随便填，
就能在完全不花额度的前提下走通 AI 面板。

`crlf-novel.txt` / `lf-novel.txt` 是同一本书的两份换行变体（CRLF / LF），
用于验证导入后段落是否切得开：两份导入后的正文必须一致。
