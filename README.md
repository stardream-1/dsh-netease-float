# dsh-netease-float

自用的网易云音乐悬浮小窗：**歌单、搜索、歌词、动态壁纸**，塞进 DeepSeek Harness 一个可拖动的小窗里。

> **边界**：壁纸只铺在悬浮小窗**内部**。不注入 `index.html`、不改主题变量、不写 `html/body` 样式，
> DSH 主界面、对话区、侧栏保持原样。卸载后小窗、路由、样式一并消失。

## 功能

**播放**

- 搜索歌曲、播放/暂停、上一首/下一首、进度条拖动 + 缓冲条
- 循环三态：列表循环 / 单曲循环 / 不循环
- 直接读取**账号歌单**（含「我喜欢的音乐」），点一下整单入队并开播
- 窗口空白处显示歌词：当前行高亮 + 前后各一行上下文

**小窗**

- Pointer Events 拖动，位置和尺寸写 `localStorage`，重启恢复
- 右下角手柄拖拽缩放（280×150 ~ 900×720，自动受视口限制）
- 三层结构：壁纸层（`object-fit: cover`、`pointer-events: none`）→ 可调遮罩（暗化 + 模糊）→ UI 层

**壁纸**

- 视频 / 图片：`.mp4` `.webm` `.jpg` `.png` `.gif`，动态与静态帧一键切换（静态即暂停解码，保留当前帧）
- **场景壁纸**：Wallpaper Engine 的 `.pkg` 由内嵌的 [WebWallGL](https://github.com/oneincase/webwallgl)
  实时渲染真实场景（图层 / 粒子 / 效果），不是抽一帧预览图
- 壁纸从 Steam 创意工坊目录扫描（`431960`）

## 装

桌面版的 profile 由 Electron 独占，命令行装不了：

```bash
dsh plugin --profile desktop add <本目录>
# error: profile "desktop" is managed exclusively by the Electron application
```

两条可用路径：

1. **插件面板**：设置 → 插件 → 添加插件，填本地目录路径，装完**完全退出** DSH 再打开
2. **手工**：往 `profiles/desktop/package.json` 的 `dependencies` 加一条
   `"dsh-netease-float": "file:<绝对路径>"`，`dsh.profile.bundles` 追加包名，再 `pnpm install`

装完在 `~/.dsh/netease-float.json` 里配 Cookie（VIP 曲需要），或在小窗设置面板里点「粘贴 Cookie」。
免费曲不配也能放。

## 技术要点

写给想看实现的人。这个插件绕过了 DSH 桌面端三个坑，都在 `lib/index.js` / `lib/client.js` 里。

### 1. 桌面端的媒体请求带不上 cookie

桌面端页面 origin 是 `dsh-app://app`（自定义协议），`<audio>` / `<script>` / `<img>` 由浏览器原生发起
`http://127.0.0.1:<port>/...` 时**不会带 DSH 的认证 cookie**，被 `connection.requestRejection` 一律挡成 401。

表现为音频加载失败、壁纸空白、歌单接口返回空 body。解法是给媒体类路由发一张进程内随机通行证：

```js
const MEDIA_TOKEN = randomBytes(16).toString('hex')
// /api/http-base 把它交给客户端，媒体地址拼上 &mt=<token>
```

`/api/http-base` 同时返回真实 HTTP origin，客户端据此拼绝对地址。

### 2. `dsh-app://` 协议转发会吞掉 `Content-Length`

`app.asar/lib/main.js` 里那段 `forwardWebRequest` 的

```js
const WITHHELD_RESPONSE_HEADERS = ["set-cookie", "content-encoding", "content-length", ...]
```

保留 Range 请求头和 206 状态，**唯独扣掉 `content-length`**。浏览器拿不到音频总长度，`seekable`
范围塌缩成只能拖已缓冲段——表现就是进度条拖了没反应、拖过去一会儿又跳回 0:00。

所以音频走 CDN 直链，不自己转发字节。

### 3. 自动播放被限制时，异步回来的 `play()` 会被拦

点歌单要先 `fetch` 歌曲列表，回调里再 `play()`，那时用户手势已经过期。做法是**打开面板就预取**
歌单歌曲（前 12 个），点的时候全程同步。被策略拦下时还有一层兜底：先静音起播再取消静音。

## 场景壁纸怎么渲染的

`scene.pkg` 是 PKGV 容器 + `.tex` 纹理，真正的动画在场景对象里，抽内嵌视频会漏掉大多数壁纸。
现在的路径是**实时渲染**：

1. Host 经 `/api/webwallgl.js` 暴露随包分发的 WebWallGL（1.1 MB，MIT），首次用到才加载
2. 客户端把 `scene.pkg` 原始字节 + `project.json` 交给 `WebWallGL.mount()`，用 `bytesSource()`
   让它自己解析，渲染到小窗背景的 canvas
3. 挂载参数固定 `scripts: false`（**不执行壁纸自带的 SceneScript** —— 壁纸与 DSH 页面同源）、
   `volume: 0`、`fps: 30`、`renderDpr: 1`，控制小窗里的 GPU 占用
4. 加载期间用 `preview.jpg/gif` 占位；渲染器不可用（无 WebGL2 等）时回退预览图并提示

`lib/vendor/pkg-read.js` + `scene-manifest.js` 只用于探测/抽取内嵌 MP4 作为兜底，不在主路径上。

## 路由

前缀 `/netease-float`。

| 路由 | 说明 | 认证 |
|---|---|---|
| `/api/search` `/api/lyric` `/api/config` `/api/wallpapers` `/api/http-base` | 搜索、歌词、配置、壁纸清单 | cookie 栅栏 |
| `/api/nm/playlists` `/api/nm/playlist?id=` | 账号歌单列表 / 歌单歌曲 | 媒体令牌 |
| `/api/song-url?id=` | 网易云 CDN 直链（升 https） | cookie 栅栏 |
| `/api/audio?id=` | 音频代理（直链失败时的兜底，支持 Range） | 媒体令牌 |
| `/api/wallpaper-media` `/api/scene-video` `/api/wallpaper-preview` `/api/webwallgl.js` | 壁纸媒体与渲染器 | 媒体令牌 |
| `/api/netease-cookie` | 从本机客户端导入登录态 | cookie 栅栏 |

壁纸路径校验过 `path.resolve` 前缀，不接受 `../` 穿越。

## 许可

MIT（见 `LICENSE`）。

壁纸渲染依赖 [WebWallGL](https://github.com/oneincase/webwallgl)（MIT，随包分发）；
`pkg-read.js` 与 `scene-manifest.js` 改自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）。
第三方声明见 `lib/vendor/NOTICE.md`。
