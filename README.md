# dsh-netease-float

DeepSeek Harness 的网易云音乐悬浮小窗。可拖动、可缩放，背景可放视频或 Wallpaper Engine 场景壁纸。

壁纸只铺在小窗内部，不改 DSH 主界面。

## 功能

- 搜索、播放/暂停、上一首/下一首、进度条拖动
- 循环三态：列表 / 单曲 / 不循环
- 读取账号歌单（含「我喜欢的音乐」），点击整单入队
- 歌词显示：当前行高亮 + 前后各一行
- 壁纸支持 `.mp4` `.webm` `.jpg` `.png` `.gif`，以及 Wallpaper Engine 场景壁纸（实时渲染）
- 位置、尺寸自动保存

## 安装

桌面版 profile 由 Electron 独占，命令行装不了。

**插件面板**

1. 克隆仓库到本机任意位置
2. 设置 → 插件 → 添加插件，填该目录
3. 完全退出 DSH 后重新打开

**手动**

`~/.dsh/profiles/desktop/package.json`：

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

`file:` 用绝对路径，Windows 下写成 `file:D:/plugins/dsh-netease-float`。改完在该目录执行 `pnpm install`，重启 DSH。

## 使用

| 按钮 | 功能 |
|---|---|
| `⌕` | 搜索 |
| `☰` | 播放列表 / 账号歌单 |
| `⚙` | 设置 |
| `▶` `⏸` | 播放 / 暂停 |
| `▢` | 收起 |
| 右下角三角 | 拖动缩放 |

免费曲目不需要登录。VIP 曲目需在设置面板粘贴 Cookie（`MUSIC_U=...; __csrf=...`）。

## 常见问题

**没声音**：Cookie 失效，重新粘贴。

**壁纸黑屏**：显卡不支持 WebGL2 时场景壁纸会退回预览图。

**进度条拖不动**：1.0.9 之前的问题，已修复。

**歌单为空**：未配置或 Cookie 失效。

## 技术说明

DSH 桌面端页面跑在 `dsh-app://` 自定义协议下，带来三个问题：

**媒体请求不带 Cookie**。浏览器原生发出的音频、壁纸请求打到 `127.0.0.1` 时不带认证信息，被 `connection.requestRejection` 挡成 401。解法是给媒体路由发放进程内随机令牌 `MEDIA_TOKEN`，经 `/api/http-base` 交给客户端。

**协议转发丢弃 `Content-Length`**。`forwardWebRequest` 的 `WITHHELD_RESPONSE_HEADERS` 会删掉该头，浏览器无法得知音频总长度，`seekable` 范围塌缩，进度条失效。解法是音频改走网易云 CDN 直链。

**异步播放被自动播放策略拦截**。点歌单后需先请求歌曲列表，回调时用户手势已过期。解法是打开面板时预取歌单内容，点击时同步播放。

场景壁纸通过 [WebWallGL](https://github.com/oneincase/webwallgl) 实时渲染 `.pkg` 中的图层、粒子与效果，挂载参数固定 `scripts: false`（不执行壁纸自带脚本）。

## 许可

MIT。壁纸渲染使用 [WebWallGL](https://github.com/oneincase/webwallgl)（MIT），`.pkg` 解析代码改编自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)。第三方声明见 `lib/vendor/NOTICE.md`。
