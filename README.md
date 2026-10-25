# dsh-netease-float

给你的 DeepSeek Harness 装一个**网易云音乐小窗**——浮在界面角落，能拖动、能放大缩小，背景调Wallpaper Engine的动态壁纸。

> 壁纸只铺在这个小窗里面，**不会动你的 DSH 主界面**。对话区、侧栏还是原来的样子。

---

## 能干什么

**放歌**

- 搜歌名，点一下就播
- 上一首 / 下一首 / 拖进度条
- 循环切三档：列表循环 → 单曲循环 → 不循环
- 打开**你自己的网易云歌单**（"我喜欢的音乐"也在里面），点一下整张单子排队开播
- 歌词显示在小窗中间的空白处，当前那句高亮，前后各带一句

**小窗**

- 按住标题栏拖到任意位置
- 右下角那个小三角按住拖动 → 放大缩小（280×150 ~ 900×720）
- 位置和大小会记住，下次打开还是原样

**壁纸**

- 视频（`.mp4` `.webm`）、图片（`.jpg` `.png` `.gif`）都行
- **Wallpaper Engine 的场景壁纸**也能用，是真渲染不是截张图
- 想省电就切"静态帧"，画面停住不动

---

## 装

> 这个插件是给 **DSH 桌面版**用的。桌面版的 profile 被 Electron 锁着，命令行装不了。

**方法一：插件面板**（简单）

1. 把仓库下载/克隆到本机任意位置
2. 打开 DSH → 设置 → 插件 → 添加插件，填**你存放它的那个目录**
3. 装好后**完全退出 DSH**（不是关窗口，是退进程）再重新打开

改代码之后也要这样重启才生效，热更新不管用。

**方法二：手动改配置**

先把仓库放到一个固定的目录（下称 `<插件目录>`），然后打开 `~/.dsh/profiles/desktop/package.json`
（Windows 上是 `%USERPROFILE%\.dsh\profiles\desktop\package.json`）：

```json
{
  "dependencies": {
    "dsh-netease-float": "file:<插件目录>"
  },
  "dsh": { "profile": { "bundles": [
    "...",
    "dsh-netease-float"
  ] } }
}
```

注意 `file:` 后面要写**绝对路径**，Windows 下用正斜杠，例如 `file:D:/plugins/dsh-netease-float`。

然后在这个 profile 目录下跑 `pnpm install`，再重启 DSH。

---

## 用

打开后小窗出现在屏幕上，按钮不多：

| 按钮 | 干什么 |
|---|---|
| `⌕` | 搜索歌曲 |
| `☰` | 播放列表 / 账号歌单 |
| `⚙` | 设置（壁纸、透明度、Cookie） |
| `▶` `⏸` | 播放 / 暂停 |
| `▢` | 收起成一条，只剩歌名 |
| 右下角小三角 | 按住拖动缩放 |

**要登录吗？** 免费歌不用。想听 VIP 曲目才需要配 Cookie：设置面板里点「粘贴 Cookie」，把 `MUSIC_U=...; __csrf=...` 那串粘进去。只想听免费歌的话跳过就行。

---

## 遇到问题

**点了没声音 / 提示"加载不了"**

可能是 Cookie 过期了。设置里重新粘一次 Cookie。如果只想听免费歌，检查一下歌本身带不带 VIP 标记。

**壁纸是黑的**

- 选了场景壁纸但电脑不支持 WebGL2 → 会退回显示预览图，功能还能用
- 视频壁纸文件太大，第一次加载会慢一点

**歌单列表是空的**

说明 Cookie 没配或者失效了。歌单功能必须登录。

---

## 壁纸是怎么渲染的

Wallpaper Engine 的场景壁纸是一个 `.pkg` 文件，里面装着纹理和场景描述，动画效果由场景里的图层、粒子、模型跑出来。

这个插件用 [WebWallGL](https://github.com/oneincase/webwallgl) 把它们**实时渲染**在 canvas 上，而不是抽一张预览图充数。

出于安全考虑，壁纸自带的脚本是**不执行**的（`scripts: false`）——壁纸和 DSH 页面同源，跑陌生脚本风险太大。

---

## 许可

MIT。

壁纸渲染部分用了 [WebWallGL](https://github.com/oneincase/webwallgl)（也是 MIT），`.pkg` 解析的代码改编自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)。第三方声明都在 `lib/vendor/NOTICE.md` 里。
