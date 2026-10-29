# OP-5 操作记录

清单原文：OP-5：滚轮向下。应看到正文连续滚动，不强制换章。

操作：承接 OP-4，先读取当前位置。在正文 (700,450) 发送一次 CDP Input.dispatchMouseEvent type=mouseWheel、deltaY=380、deltaX=0；没有写入任何滚动属性，也没有点换章。

操作前：章标题 DOM「第二章 样例长夜」，scrollTop=651，clientHeight=723，scrollHeight=14155；可视段落第4至第10段。
操作后：章标题 DOM「第二章 样例长夜」，scrollTop=1031，clientHeight=723，scrollHeight=14155，差值380；可视段落第7至第12段。纸面实际文字包括「第8段：夜色沿着河岸缓缓展开，船上的灯光照亮纸页」「故事仍在同一章节中继续」。章首标题仍在 DOM 中但处于视口上方，工具保持隐藏，左侧书脊「样」。

截图：OP-5-before.png、OP-5-after.png，均1280×771完整纸面。
只读值及实际文字：OP-5-before-state.json、OP-5-after-state.json。
无障碍树：OP-5-before-ax.json、OP-5-after-ax.json。
