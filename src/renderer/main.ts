import { createApp } from 'vue'
import naive from 'naive-ui'
import App from './App.vue'
// 霞鹜文楷（屏幕版）：参考站的默认正文字体；按 unicode-range 分片，浏览器只取用到的片。
import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css'
import './styles.css'

createApp(App).use(naive).mount('#app')
