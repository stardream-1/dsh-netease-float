# dsh-netease-float

DeepSeek Harness 的网易云音乐悬浮小窗。可拖动、可缩放，背景调 Wallpaper Engine 壁纸。

壁纸只铺在小窗内部。

## 功能

- 搜索、播放/暂停、上一首/下一首、进度条拖动
- 循环三态：列表 / 单曲 / 不循环
- 读取账号歌单（含「我喜欢的音乐」），点击整单入队
- 歌词显示：当前行高亮 + 前后各一行
- 壁纸支持 `.mp4` `.webm` `.jpg` `.png` `.gif`，以及`.pkg`壁纸
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

**进度条拖不动**：已修复。

**歌单为空**：未配置或 Cookie 失效。

## 说明

场景壁纸通过 [WebWallGL](https://github.com/oneincase/webwallgl) 实时渲染 `.pkg` 中的图层、粒子与效果，挂载参数固定 `scripts: false`（不执行壁纸自带脚本）。

## 许可

MIT。壁纸渲染使用 [WebWallGL](https://github.com/oneincase/webwallgl)（MIT），`.pkg` 解析代码改编自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)。第三方声明见 `lib/vendor/NOTICE.md`。
