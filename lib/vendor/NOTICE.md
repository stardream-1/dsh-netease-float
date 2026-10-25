# vendor/ 第三方代码说明

## webwallgl.global.min.js

复制自 [webwallgl](https://github.com/oneincase/webwallgl) v3.0.0
（MIT License，见同目录 `webwallgl.LICENSE`），上游文件 `webwallgl.global.min.js`。

用途：浏览器端 Wallpaper Engine **场景壁纸**渲染器（WebGL2）。本插件把它作为
`/netease-float/api/webwallgl.js` 路由暴露，客户端按需 `<script>` 加载，拿到全局
`WebWallGL` 后调用 `mount()` + `bytesSource()` 渲染 `scene.pkg` 里的真实场景
（图层、粒子、效果），而非只抽内嵌 MP4。

本插件未修改其内容。挂载时固定传入 `scripts: false`（不执行壁纸自带 SceneScript，
因为壁纸与 DSH 页面同源）、`volume: 0`、`fps: 30`、`renderDpr: 1` 控制资源占用。

## pkg-read.js 与 scene-manifest.js

`pkg-read.js` 与 `scene-manifest.js` 复制自
[elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)
（MIT License, Copyright (c) 2026 elysia395），原路径 `lib/pkg-read.js`、`lib/scene-manifest.js`。

用途：解析 Wallpaper Engine 的 `scene.pkg`（PKGV 容器 + TEX 纹理），
探测并提取场景壁纸内部内嵌的 MP4，供 `dsh-netease-float` 的
`/netease-float/api/scene-video` 路由使用。

本插件只做了复制，未修改其逻辑；两文件均为纯 Node 实现，无第三方运行时依赖。
上游许可证见项目根 `LICENSE`（MIT）。
