# OP-4 操作记录

清单原文：OP-4：打开长章，点正文右侧三分之一一次。应看到仍是同一章标题。视口相对下移约一屏。

操作：继续使用已打开的100段长章，先只读采集标题及滚动值；CDP 在正文 (900,385) 按下/释放一次。纸面 x=324..1008，右侧三分之一 x=780..1008；没有点窗口右边缘的换章箭头，没有写入 scrollTop。

操作前：章标题 DOM 为「第二章 样例长夜」，纸面可见章标题及第1至第5段；scrollTop=0，clientHeight=723，scrollHeight=14155。
操作后：章标题 DOM 仍为「第二章 样例长夜」，scrollTop=651，clientHeight=723，scrollHeight=14155；差值651，为 clientHeight 的0.9004倍。可视段落变为第4至第10段，包含「夜色沿着河岸缓缓展开，船上的灯光照亮纸页」；原来的章首标题随正文滚出上边缘，截图里不再可见，未把 DOM 中仍在的标题当作屏幕可见标题。工具仍隐藏，左侧书脊「样」保留。

截图：OP-4-before.png、OP-4-after.png，均1280×771完整纸面。
只读值及实际文字：OP-4-before-state.json、OP-4-after-state.json。
无障碍树：OP-4-before-ax.json、OP-4-after-ax.json。
