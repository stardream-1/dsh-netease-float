/**
 * dsh-netease-float — 浏览器半侧
 * ---------------------------------------------------------------------------
 * 手写的 dsh.client bundle（无需构建）：在 `shell.overlay` 槽位注册一个
 * 悬浮小窗，自带三层结构：
 *   1) 壁纸层   <video>/<img>，object-fit:cover，pointer-events:none
 *   2) 遮罩层   渐变 + blur，可调；只为小窗内部可读性，不影响主界面
 *   3) UI 层    拖拽手柄 / 歌名 / 播放控制 / 进度 / 搜索 / 歌词 / 设置
 *
 * 边界：所有样式都挂在 `.nf-root` 之下，不写 html/body，不改主题变量。
 * 卸载即随 React 根一起消失，不留全屏层。
 *
 * 拖拽只用 Pointer Events + setPointerCapture；按钮/输入框/进度条带
 * [data-nf-nodrag]，在这些元素上按下不会开始拖动。
 */
window.__ModuleLoader__.load({
  id: 'dsh-netease-float',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /* module 加载器给的是 CJS 互操作包装：真正的 React 可能直接挂在模块上，
       也可能在 `default` 上（取决于打包形式）。两种都认，且只解析一次，
       保证 hooks 与 createElement 来自同一个对象——否则会触发 Invalid hook call。 */
    var ReactMod = require('react')
    var React =
      ReactMod && typeof ReactMod.createElement === 'function'
        ? ReactMod
        : ReactMod && ReactMod.default && typeof ReactMod.default.createElement === 'function'
          ? ReactMod.default
          : ReactMod
    var h = React.createElement
    if (typeof h !== 'function') {
      throw new Error('[dsh-netease-float] react module has no createElement: ' + Object.keys(ReactMod || {}).join(','))
    }
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    var BASE = '/netease-float'
    var STORE_KEY = 'dsh-netease-float:v1'

    var W_DEFAULT = 360
    var H_DEFAULT = 220
    var MIN_W = 280
    var MIN_H = 150
    var MAX_W = 900
    var MAX_H = 720
    var H_COLLAPSED = 60
    var HEAD_VISIBLE = 132 /* 至少留这么多宽度可见，防拖丢 */

    /* ---------------------------------------------------------------- CSS */

    var CSS = [
      '.nf-root{position:fixed;left:0;top:0;z-index:120;border-radius:16px;overflow:hidden;',
      'box-shadow:0 18px 48px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.4);',
      'border:1px solid rgba(255,255,255,.14);background:#141418;color:#fff;',
      'font-family:var(--dsw-font-family-ui,system-ui,-apple-system,"Segoe UI",sans-serif);',
      'will-change:transform;transition:box-shadow .18s ease,height .22s ease,width .22s ease;}',
      '.nf-root *{box-sizing:border-box;}',
      '.nf-root.nf-dragging{box-shadow:0 26px 64px rgba(0,0,0,.62);transition:none;}',

      /* 1) 壁纸层 */
      '.nf-bg{position:absolute;inset:0;pointer-events:none;overflow:hidden;background:radial-gradient(120% 120% at 20% 0%,#3a2b46 0%,#141418 68%);}',
      '.nf-bg video,.nf-bg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}',
      '.nf-bg video{background:#000;}',
      /* 场景壁纸：WebWallGL 自建 canvas，铺满小窗 */
      '.nf-scene-host{position:absolute;inset:0;pointer-events:none;overflow:hidden;}',
      '.nf-scene-host canvas{display:block!important;width:100%!important;height:100%!important;}',
      '.nf-scene-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',

      /* 2) 遮罩层：可读性 */
      '.nf-scrim{position:absolute;inset:0;pointer-events:none;',
      'background:linear-gradient(180deg,rgba(8,8,12,.28) 0%,rgba(8,8,12,.52) 42%,rgba(8,8,12,.84) 100%);}',

      /* 3) UI 层 */
      '.nf-ui{position:absolute;inset:0;display:flex;flex-direction:column;}',
      '.nf-head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;touch-action:none;user-select:none;}',
      '.nf-head:active{cursor:grabbing;}',
      '.nf-head.nf-grabbing{cursor:grabbing;}',
      '.nf-dot{width:8px;height:8px;border-radius:50%;background:#ff2b4e;box-shadow:0 0 8px #ff2b4e;flex:0 0 auto;}',
      '.nf-title{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;line-height:1.2;}',
      '.nf-song{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nf-artist{font-size:11px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nf-ico{width:26px;height:26px;border-radius:8px;border:0;background:rgba(255,255,255,.1);color:#fff;',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;line-height:1;',
      'padding:0;flex:0 0 auto;transition:background .15s ease;}',
      '.nf-ico:hover{background:rgba(255,255,255,.22);}',
      '.nf-ico-on{background:rgba(255,43,78,.30);color:#ffd7de;}',
      '.nf-ico-on:hover{background:rgba(255,43,78,.45);}',
      '.nf-ico:disabled{opacity:.4;cursor:default;}',

      /* 歌词 */
      '.nf-lyric{flex:1 1 auto;min-height:0;overflow:hidden;padding:2px 14px;display:flex;',
      'flex-direction:column;justify-content:center;align-items:center;gap:3px;text-align:center;}',
      '.nf-lyric-line{font-size:12px;opacity:.42;line-height:1.35;max-width:100%;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;transition:opacity .18s ease,font-size .18s ease;}',
      '.nf-lyric-line.on{font-size:14px;font-weight:600;opacity:1;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.85);}',
      '.nf-lyric-empty{font-size:12px;opacity:.62;}',
      /* 右下角缩放手柄 */
      '.nf-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;z-index:4;cursor:nwse-resize;',
      'touch-action:none;opacity:.55;transition:opacity .15s ease;background:linear-gradient(135deg,transparent 40%,',
      'rgba(255,255,255,.55) 40%,rgba(255,255,255,.55) 50%,transparent 50%,transparent 62%,',
      'rgba(255,255,255,.55) 62%,rgba(255,255,255,.55) 72%,transparent 72%);border-bottom-right-radius:14px;}',
      '.nf-resize:hover{opacity:1;}',
      '.nf-root:hover .nf-resize{opacity:.8;}',

      /* 控制区 */
      '.nf-controls{padding:8px 26px 12px 12px;display:flex;flex-direction:column;gap:7px;}',
      '.nf-progress{height:14px;display:flex;align-items:center;cursor:pointer;touch-action:none;}',
      '.nf-progress-track{position:relative;height:4px;width:100%;border-radius:2px;background:rgba(255,255,255,.22);overflow:hidden;transition:height .12s ease;}',
      '.nf-progress:hover .nf-progress-track{height:6px;}',
      '.nf-progress-buf{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.32);}',
      '.nf-progress-fill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#ff2b4e,#ff7a5c);border-radius:2px;}',
      '.nf-row{display:flex;align-items:center;gap:6px;}',
      '.nf-time{font-size:10px;opacity:.66;font-variant-numeric:tabular-nums;min-width:34px;text-align:center;}',
      '.nf-spacer{flex:1 1 auto;}',

      /* 搜索 / 设置面板 */
      '.nf-panel{position:absolute;left:0;right:0;bottom:0;top:52px;background:rgba(12,12,16,.94);',
      'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);display:flex;flex-direction:column;',
      'border-top:1px solid rgba(255,255,255,.1);}',
      '.nf-panel-head{display:flex;align-items:center;gap:6px;padding:8px 10px;}',
      '.nf-input{flex:1 1 auto;min-width:0;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.18);',
      'background:rgba(255,255,255,.08);color:#fff;padding:0 9px;font-size:12px;outline:none;}',
      '.nf-input:focus{border-color:rgba(255,120,140,.6);}',
      '.nf-input::placeholder{color:rgba(255,255,255,.45);}',
      '.nf-list{flex:1 1 auto;overflow:auto;padding:0 8px 8px;}',
      '.nf-item{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:8px;cursor:pointer;}',
      '.nf-tab{border:0;background:transparent;color:#fff;opacity:.5;font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;}',
      '.nf-tab.on{opacity:1;background:rgba(255,255,255,.14);}',
      '.nf-hint{font-size:10px;opacity:.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px;}',
      '.nf-item:hover{background:rgba(255,255,255,.1);}',
      '.nf-item.on{background:rgba(255,43,78,.22);}',
      '.nf-item-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nf-item-sub{font-size:10px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nf-vip{display:inline-block;font-size:9px;line-height:1.5;padding:0 3px;border-radius:3px;',
      'background:rgba(255,43,78,.24);color:#ff9aa8;margin-left:5px;vertical-align:middle;font-weight:600;}',
      '.nf-empty{font-size:11px;opacity:.6;padding:10px;line-height:1.5;}',

      /* 设置 */
      '.nf-set{flex:1 1 auto;overflow:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:10px;}',
      '.nf-field{display:flex;flex-direction:column;gap:4px;}',
      '.nf-label{font-size:10px;letter-spacing:.04em;text-transform:uppercase;opacity:.62;}',
      '.nf-hint{font-size:10px;opacity:.55;line-height:1.45;}',
      '.nf-slider{width:100%;accent-color:#ff2b4e;}',
      '.nf-select{height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;font-size:11px;padding:0 6px;}',
      '.nf-select option{background:#1b1b21;color:#fff;}',
      '.nf-btn{height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);',
      'color:#fff;font-size:11px;padding:0 9px;cursor:pointer;}',
      '.nf-btn:hover{background:rgba(255,255,255,.16);}',
      '.nf-btn:disabled{opacity:.45;cursor:default;}',
      '.nf-toast{position:absolute;left:8px;right:8px;bottom:8px;background:rgba(20,20,26,.96);',
      'border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:7px 9px;font-size:11px;line-height:1.45;pointer-events:none;}',
      '.nf-kbd{font-family:ui-monospace,Consolas,monospace;font-size:10px;opacity:.7;}',
    ].join('')

    /* ------------------------------------------------------------- helpers */

    function apiUrl(p) {
      return BASE + p
    }

    /**
     * 媒体上下文：桌面端页面 origin 是 dsh-app://app，audio/video/img/script 由浏览器原生发起，
     * 请求 http://127.0.0.1 时不带 DSH 的认证 cookie，会被信任栅栏挡成 401。
     * 所以媒体地址 = 真实 HTTP origin + 路径 + 本进程媒体令牌 mt。
     */
    var MEDIA = { base: '', token: '' }
    function mediaUrl(p) {
      var sep = p.indexOf('?') >= 0 ? '&' : '?'
      var tok = MEDIA.token ? sep + 'mt=' + encodeURIComponent(MEDIA.token) : ''
      return (MEDIA.base || '') + BASE + p + tok
    }

    /* 媒体令牌通道上的 JSON 请求：桌面端页面拿不到 DSH 的 cookie，
       这些路由靠 mt 放行，因此走绝对地址且不带 credentials。 */
    function mediaJson(path) {
      return fetch(mediaUrl(path)).then(function (r) {
        return r.text().then(function (txt) {
          var j = null
          if (txt) {
            try {
              j = JSON.parse(txt)
            } catch (e) {
              throw new Error('响应不是 JSON（HTTP ' + r.status + '）')
            }
          }
          if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || 'HTTP ' + r.status)
          if (!j) throw new Error('空响应（HTTP ' + r.status + '）')
          return j
        })
      })
    }

    /* WebWallGL 渲染器按需加载：只有真的选了场景壁纸才拉这 1.1MB。 */
    var wwgLoading = null
    function loadWebWallGL() {
      if (typeof window !== 'undefined' && window.WebWallGL) return Promise.resolve(window.WebWallGL)
      if (wwgLoading) return wwgLoading
      wwgLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script')
        s.src = mediaUrl('/api/webwallgl.js')
        s.async = true
        s.onload = function () {
          if (window.WebWallGL) resolve(window.WebWallGL)
          else reject(new Error('WebWallGL 未挂到 window'))
        }
        s.onerror = function () {
          wwgLoading = null
          reject(new Error('渲染器脚本加载失败'))
        }
        document.head.appendChild(s)
      })
      return wwgLoading
    }

    function loadStore() {
      try {
        var raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
        return raw && typeof raw === 'object' ? raw : {}
      } catch (e) {
        return {}
      }
    }

    function saveStore(patch) {
      try {
        var cur = loadStore()
        var next = Object.assign({}, cur, patch)
        localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch (e) {
        /* 隐私模式下写入失败：位置不持久化，但不影响播放 */
      }
    }

    function getJson(path, init) {
      return fetch(apiUrl(path), Object.assign({ credentials: 'same-origin' }, init || {})).then(function (r) {
        /* 先把 body 读成文本再解析：信任栅栏/超时这类失败会给出空 body，
           直接 r.json() 只会抛 "Unexpected end of JSON input"，看不出真正原因。 */
        return r.text().then(function (txt) {
          var j = null
          if (txt) {
            try {
              j = JSON.parse(txt)
            } catch (e) {
              var bad = new Error('响应不是 JSON（HTTP ' + r.status + '）')
              bad.payload = null
              throw bad
            }
          }
          if (!r.ok || (j && j.ok === false)) {
            var err = new Error((j && j.error) || 'HTTP ' + r.status + (r.status === 403 ? '（请求被拦）' : ''))
            err.payload = j
            throw err
          }
          if (!j) {
            var empty = new Error('空响应（HTTP ' + r.status + '）')
            empty.payload = null
            throw empty
          }
          return j
        })
      })
    }

    function fmtTime(sec) {
      var s = Math.max(0, Math.floor(Number(sec) || 0))
      var m = Math.floor(s / 60)
      var r = s % 60
      return m + ':' + (r < 10 ? '0' + r : String(r))
    }

    function parseLrc(text) {
      var out = []
      var lines = String(text || '').split(/\r?\n/)
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim()
        var m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\](.*)$/.exec(line)
        if (!m) continue
        var t = Number(m[1]) * 60 + Number(String(m[2]).replace(':', '.'))
        var txt = m[3].trim()
        if (txt) out.push({ t: t, text: txt })
      }
      out.sort(function (a, b) {
        return a.t - b.t
      })
      return out
    }

    function clampPos(x, y, w, h) {
      var vw = window.innerWidth || 1280
      var vh = window.innerHeight || 800
      /* 手柄必须始终在视口内（y 顶部不越界），同时至少留出一块可点的内容区：
         x 侧留 160px 宽、y 侧留 88px 高，避免窗口被拖到只剩一条边。 */
      var minX = -(w - HEAD_VISIBLE)
      var maxX = vw - Math.min(160, w)
      var minY = 0
      var maxY = vh - Math.min(88, h)
      if (maxX < minX) maxX = minX
      if (maxY < minY) maxY = minY
      return { x: Math.min(Math.max(x, minX), maxX), y: Math.min(Math.max(y, minY), maxY) }
    }

    function defaultPos(w, h) {
      var vw = window.innerWidth || 1280
      var vh = window.innerHeight || 800
      return clampPos(Math.max(16, vw - w - 24), Math.max(16, vh - h - 28), w, h)
    }

    /* ------------------------------------------------------------ component */

    function FloatPlayer() {
      var stored = useRef(loadStore())
      var init = stored.current

      var _useState = useState(init.collapsed === true)
      var collapsed = _useState[0]
      var setCollapsed = _useState[1]

      var _useSize = useState(function () {
        var s = init.size
        var w = s && typeof s.w === 'number' ? Math.min(Math.max(s.w, MIN_W), MAX_W) : W_DEFAULT
        var hh = s && typeof s.h === 'number' ? Math.min(Math.max(s.h, MIN_H), MAX_H) : H_DEFAULT
        return { w: w, h: hh }
      })
      var size = _useSize[0]
      var setSize = _useSize[1]

      var boxW = size.w
      var boxH = collapsed ? H_COLLAPSED : Math.max(size.h, MIN_H)

      var _usePos = useState(function () {
        var base = typeof init.x === 'number' && typeof init.y === 'number' ? { x: init.x, y: init.y } : defaultPos(W_DEFAULT, H_DEFAULT)
        return clampPos(base.x, base.y, W_DEFAULT, H_DEFAULT)
      })
      var pos = _usePos[0]
      var setPos = _usePos[1]

      var _useSong = useState(null)
      var current = _useSong[0]
      var setCurrent = _useSong[1]

      var _usePlaying = useState(false)
      var playing = _usePlaying[0]
      var setPlaying = _usePlaying[1]

      var _useProg = useState(0)
      var progress = _useProg[0]
      var setProgress = _useProg[1]

      /* 已缓冲到哪儿：进度条上多画一段浅色，用户能看出哪里能直接拖 */
      var _useBuf = useState(0)
      var bufferedEnd = _useBuf[0]
      var setBufferedEnd = _useBuf[1]

      var _useDur = useState(0)
      var duration = _useDur[0]
      var setDuration = _useDur[1]

      var _usePanel = useState('none')
      var panel = _usePanel[0]
      var setPanel = _usePanel[1]

      var _useQuery = useState('')
      var query = _useQuery[0]
      var setQuery = _useQuery[1]

      var _useResults = useState([])
      var results = _useResults[0]
      var setResults = _useResults[1]

      /* 账号歌单（需要 cookie；uid 由 Host 缓存） */
      var _useNm = useState({ uid: 0, nickname: '', items: [], error: '', loading: false })
      var nm = _useNm[0]
      var setNm = _useNm[1]
      var _useListTab = useState('queue')
      var listTab = _useListTab[0]
      var setListTab = _useListTab[1]
      /* 歌单详情预取缓存：点歌单时必须同步拿到歌，否则 async 回来手势已过期，play() 会被拦 */
      var nmDetailsRef = useRef({})

      var _useSearching = useState(false)
      var searching = _useSearching[0]
      var setSearching = _useSearching[1]

      var _useNotice = useState('')
      var notice = _useNotice[0]
      var setNotice = _useNotice[1]

      var _useLyric = useState([])
      var lyric = _useLyric[0]
      var setLyric = _useLyric[1]

      var _useCfg = useState({ overlay: 0.55, blur: 6, wallpaperMode: 'video', wallpaperId: '', lyrics: true, volume: 0.8 })
      var cfg = _useCfg[0]
      var setCfg = _useCfg[1]

      var _useWalls = useState({ root: '', items: [], error: '' })
      var walls = _useWalls[0]
      var setWalls = _useWalls[1]

      var _useCk = useState(null)
      var cookieState = _useCk[0]
      var setCookieState = _useCk[1]

      /* null = 不在粘贴态；字符串 = 正在输入的 Cookie（Electron 里 window.prompt 返回 null） */
      var _useCookieInput = useState(null)
      var cookieInput = _useCookieInput[0]
      var setCookieInput = _useCookieInput[1]

      /* 循环模式：list（列表循环，默认）/ one（单曲循环）/ off（播完即停） */
      var _useLoop = useState(
        init.loopMode === 'one' || init.loopMode === 'off' ? init.loopMode : 'list',
      )
      var loopMode = _useLoop[0]
      var setLoopMode = _useLoop[1]

      /* 场景壁纸渲染状态：idle | loading | ready | failed */
      var _useScene = useState('idle')
      var sceneState = _useScene[0]
      var setSceneState = _useScene[1]
      var sceneHostRef = useRef(null)
      var sceneInstRef = useRef(null)

      var audioRef = useRef(null)
      var videoRef = useRef(null)
      var dragRef = useRef(null)
      var resizeRef = useRef(null)
      var seekingRef = useRef(false)
      var seekTargetRef = useRef(null)
      var seekTimerRef = useRef(0)
      /* 真实 HTTP 基址（桌面端 dsh-app:// 协议会吞掉 content-length，音频必须绕开） */
      var httpBaseRef = useRef('')
      /* 媒体免栅栏令牌：桌面端原生请求带不上 DSH 的 cookie，媒体路由靠它放行 */
      var mediaTokenRef = useRef('')
      /* token 到位后 +1，触发一次重渲染，让壁纸/封面的 src 重新拼上 mt */
      var _useMediaReady = useState(0)
      var mediaReady = _useMediaReady[0]
      var setMediaReady = _useMediaReady[1]
      var sizeRef = useRef({ w: boxW, h: boxH })
      var posRef = useRef(pos)
      var currentRef = useRef(current)
      var lyricRef = useRef(lyric)
      var noticeTimer = useRef(0)
      var pendingPlay = useRef(false)
      var loopRef = useRef(loopMode)

      sizeRef.current = { w: boxW, h: size.h }
      posRef.current = pos
      currentRef.current = current
      loopRef.current = loopMode
      lyricRef.current = lyric

      var pushNotice = useCallback(function (text) {
        setNotice(text)
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(function () {
          setNotice('')
        }, 4200)
      }, [])

      /* ---- 音频：单实例，src 变化走 playSong ---- */
      useEffect(function () {
        var a = new Audio()
        a.preload = 'auto'
        /* 不要设 crossOrigin：桌面端页面在 dsh-app://app，音频改走真实 http://127.0.0.1，
           那是跨源；设了 anonymous 反而强制服务端给 CORS 才能播，去掉最稳。 */
        audioRef.current = a
        try {
          window.__nfAudio = a
        } catch (e) {}
        var onTime = function () {
          var target = seekTargetRef.current
          var ct = Number(a.currentTime) || 0
          /* 拖动中由手指决定显示；松手后若 seek 还没落地（|差|>2s），
             也不要回显旧位置 —— 否则就是"点完跳回原处"的观感。 */
          var pendingSeek = target !== null && Math.abs(ct - target) > 2
          if (!seekingRef.current && !pendingSeek) setProgress(ct)
          try {
            var b = a.buffered
            if (b && b.length) {
              var end = 0
              for (var bi = 0; bi < b.length; bi++) {
                if (b.start(bi) <= a.currentTime + 0.5 && b.end(bi) >= a.currentTime) {
                  end = b.end(bi)
                  break
                }
              }
              if (!end) end = b.end(b.length - 1)
              setBufferedEnd(end)
            }
          } catch (e) {}
        }
        var onMeta = function () {
          setDuration(Number.isFinite(a.duration) ? a.duration : 0)
        }
        var onPlay = function () {
          setPlaying(true)
        }
        var onPause = function () {
          setPlaying(false)
        }
        /* seek 完成后校准：浏览器在未缓冲区间偶尔会丢掉这次 seek，
           落到目标附近才算成功，否则补发一次，避免 UI 与真实位置长期分叉。 */
        var onSeeked = function () {
          var target = seekTargetRef.current
          if (target === null) {
            if (!seekingRef.current) setProgress(a.currentTime || 0)
            return
          }
          var actual = Number(a.currentTime) || 0
          if (Math.abs(actual - target) > 2) {
            try {
              a.currentTime = target
            } catch (err) {}
            return
          }
          seekTargetRef.current = null
          if (!seekingRef.current) setProgress(actual)
        }
        var onEnded = function () {
          setPlaying(false)
          var mode = loopRef.current
          /* 单曲循环：原地重播，不走列表 */
          if (mode === 'one') {
            try {
              a.currentTime = 0
              var pr = a.play()
              if (pr && pr.catch) pr.catch(function () {})
            } catch (err) {}
            return
          }
          /* 不循环：停在末尾 */
          if (mode === 'off') return
          nextRef.current && nextRef.current()
        }
        var onError = function () {
          setPlaying(false)
          pushNotice('音频加载失败：可能是版权限制，试试导入网易云 Cookie')
        }
        a.addEventListener('timeupdate', onTime)
        a.addEventListener('loadedmetadata', onMeta)
        a.addEventListener('play', onPlay)
        a.addEventListener('pause', onPause)
        a.addEventListener('seeked', onSeeked)
        a.addEventListener('ended', onEnded)
        a.addEventListener('error', onError)
        return function () {
          a.removeEventListener('timeupdate', onTime)
          a.removeEventListener('loadedmetadata', onMeta)
          a.removeEventListener('play', onPlay)
          a.removeEventListener('pause', onPause)
          a.removeEventListener('seeked', onSeeked)
          a.removeEventListener('ended', onEnded)
          a.removeEventListener('error', onError)
          try {
            a.pause()
            a.src = ''
          } catch (e) {}
          audioRef.current = null
        }
      }, [])

      /* ---- 配置 + 壁纸列表 ---- */
      var loadConfig = useCallback(function () {
        return getJson('/api/config')
          .then(function (j) {
            if (j && j.config) {
              setCfg({
                overlay: typeof j.config.overlay === 'number' ? j.config.overlay : 0.55,
                blur: typeof j.config.blur === 'number' ? j.config.blur : 6,
                wallpaperMode: j.config.wallpaperMode === 'static' ? 'static' : 'video',
                wallpaperId: j.config.wallpaperId || '',
                lyrics: j.config.lyrics !== false,
                volume: typeof j.config.volume === 'number' ? j.config.volume : 0.8,
                wallpaperDir: j.config.wallpaperDir || '',
              })
            }
            if (j && j.cookie) setCookieState(j.cookie)
            if (audioRef.current && j && j.config && typeof j.config.volume === 'number') {
              audioRef.current.volume = j.config.volume
            }
          })
          .catch(function (e) {
            pushNotice('读取配置失败：' + e.message)
          })
      }, [pushNotice])

      var loadWalls = useCallback(function () {
        return getJson('/api/wallpapers')
          .then(function (j) {
            setWalls({ root: j.root || '', items: j.items || [], error: j.error || '' })
          })
          .catch(function (e) {
            setWalls({ root: '', items: [], error: '读取壁纸列表失败：' + e.message })
          })
      }, [])

      useEffect(function () {
        loadConfig().then(loadWalls)
        /* 取真实 HTTP 基址：桌面端页面在 dsh-app://app 下，它的协议转发会扣掉
           content-length，音频拿不到总长度就 seek 不动。拿到 origin 后音频改走它。 */
        fetch(apiUrl('/api/http-base'), { credentials: 'same-origin' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            var got = false
            if (j && typeof j.origin === 'string' && /^https?:\/\//.test(j.origin)) {
              httpBaseRef.current = j.origin
              MEDIA.base = j.origin
              got = true
            }
            if (j && typeof j.mediaToken === 'string' && j.mediaToken) {
              mediaTokenRef.current = j.mediaToken
              MEDIA.token = j.mediaToken
              got = true
            }
            /* 壁纸/封面的 <video>/<img> src 是渲染时算出来的字符串，token 到位后
               必须重渲染一次才会带上 mt，否则会被 403 挡成"壁纸不显示"。 */
            if (got) setMediaReady(function (n) {
              return n + 1
            })
          })
          .catch(function () {})
        return function () {
          if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
        }
      }, [loadConfig, loadWalls])

      /* ---- 歌词 ---- */
      var loadLyric = useCallback(function (id) {
        setLyric([])
        getJson('/api/lyric?id=' + encodeURIComponent(id))
          .then(function (j) {
            setLyric(parseLrc(j.lrc))
          })
          .catch(function () {
            setLyric([])
          })
      }, [])

      /* ---- 播放 ---- */
      /* 统一起播：被自动播放策略拦下时先静音起播（muted 通常放行）再取消静音。
         顺带把错误分类 —— 以前不管什么错都报"浏览器拦截"，资源 404 也会被误报。 */
      var startPlayback = function () {
        var a = audioRef.current
        if (!a) return
        var p
        try {
          p = a.play()
        } catch (err) {
          pushNotice('播放失败：' + ((err && err.message) || '播放器异常'))
          return
        }
        if (!p || !p.catch) return
        p.catch(function (err) {
          var name = (err && err.name) || ''
          if (name === 'NotAllowedError') {
            try {
              a.muted = true
            } catch (e) {}
            var p2 = a.play()
            if (p2 && p2.then) {
              p2
                .then(function () {
                  try {
                    a.muted = false
                  } catch (e) {}
                  pendingPlay.current = false
                })
                .catch(function () {
                  try {
                    a.muted = false
                  } catch (e) {}
                  pendingPlay.current = true
                  pushNotice('浏览器要求先交互一次才能出声，点小窗任意处继续')
                })
              return
            }
            pendingPlay.current = true
            pushNotice('浏览器要求先交互一次才能出声，点小窗任意处继续')
            return
          }
          if (name === 'NotSupportedError') {
            pushNotice('这首歌加载不了（版权限制，或 Cookie 已失效）')
            return
          }
          pushNotice('播放失败：' + ((err && err.message) || name || '未知错误'))
        })
      }

      var playSong = useCallback(
        function (song) {
          var a = audioRef.current
          if (!a) return
          setCurrent(song)
          setProgress(0)
          setDuration(0)
          setBufferedEnd(0)
          seekingRef.current = false
          setPanel('none')
          a.volume = cfg.volume
          /* 先取 CDN 直链：跨域 <audio> 不需要认证，绕开 DSH 的信任栅栏。
             取不到再退回自家代理（同源 + 媒体令牌）。 */
          getJson('/api/song-url?id=' + encodeURIComponent(song.id))
            .then(function (j) {
              if (j && j.url) {
                a.src = j.url
                startPlayback()
                return
              }
              throw new Error('no url')
            })
            .catch(function () {
              a.src = mediaUrl('/api/audio?id=' + encodeURIComponent(song.id))
              startPlayback()
            })
          loadLyric(song.id)
          saveStore({ lastSong: song })
        },
        [cfg.volume, loadLyric, pushNotice],
      )

      var nextRef = useRef(null)
      var playNext = useCallback(
        function (dir) {
          var list = results.length ? results : []
          var cur = currentRef.current
          if (!cur || !list.length) return
          var idx = -1
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === cur.id) {
              idx = i
              break
            }
          }
          if (idx < 0) idx = 0
          var n = (idx + (dir || 1) + list.length) % list.length
          playSong(list[n])
        },
        [results, playSong],
      )
      nextRef.current = function () {
        playNext(1)
      }

      /* ---- 账号歌单 ---- */
      var applyPlaylist = useCallback(
        function (pl, songs, name) {
          if (!songs || !songs.length) {
            pushNotice('这个歌单里没有可播放的曲目')
            return
          }
          setResults(songs)
          setPanel('none')
          playSong(songs[0])
          pushNotice('已加载「' + (name || pl.name) + '」' + songs.length + ' 首')
        },
        [playSong, pushNotice],
      )

      var loadNmPlaylists = useCallback(function () {
        /* 令牌还没就绪时请求会被 403，等一下再发（通常几百毫秒内就到了） */
        if (!MEDIA.token) {
          setNm(function (o) {
            return Object.assign({}, o, { loading: true, error: '' })
          })
          window.setTimeout(function () {
            loadNmPlaylists()
          }, 300)
          return
        }
        setNm(function (o) {
          return Object.assign({}, o, { loading: true, error: '' })
        })
        mediaJson('/api/nm/playlists')
          .then(function (j) {
            var items = j.items || []
            setNm({ uid: j.uid || 0, nickname: j.nickname || '', items: items, error: '', loading: false })
            /* 后台预取前 12 个歌单的歌曲：点一下就能同步开播，保住用户手势 */
            nmDetailsRef.current = {}
            items.slice(0, 12).forEach(function (p) {
              mediaJson('/api/nm/playlist?id=' + encodeURIComponent(p.id))
                .then(function (d) {
                  nmDetailsRef.current[p.id] = Array.isArray(d.songs) ? d.songs : []
                })
                .catch(function () {})
            })
          })
          .catch(function (e) {
            setNm(function (o) {
              return Object.assign({}, o, { loading: false, error: e.message })
            })
          })
      }, [])

      var loadNmPlaylist = useCallback(
        function (pl) {
          var cached = nmDetailsRef.current[pl.id]
          if (cached && cached.length) {
            applyPlaylist(pl, cached, pl.name)
            return
          }
          pushNotice('正在加载「' + pl.name + '」…')
          mediaJson('/api/nm/playlist?id=' + encodeURIComponent(pl.id))
            .then(function (j) {
              nmDetailsRef.current[pl.id] = j.songs || []
              applyPlaylist(pl, j.songs || [], j.name)
            })
            .catch(function (e) {
              pushNotice('加载失败：' + e.message)
            })
        },
        [applyPlaylist, pushNotice],
      )

      /* ---- 搜索 ---- */
      var doSearch = useCallback(
        function () {
          var q = String(query || '').trim()
          if (!q) return
          setSearching(true)
          getJson('/api/search?q=' + encodeURIComponent(q) + '&limit=20')
            .then(function (j) {
              setResults(j.songs || [])
            })
            .catch(function (e) {
              pushNotice('搜索失败：' + e.message)
              setResults([])
            })
            .then(function () {
              setSearching(false)
            })
        },
        [query, pushNotice],
      )

      /* ---- 拖拽 ---- */
      var onHeadPointerDown = function (e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        var t = e.target
        if (t && t.closest && t.closest('[data-nf-nodrag]')) return
        var el = e.currentTarget
        try {
          el.setPointerCapture(e.pointerId)
        } catch (err) {}
        dragRef.current = {
          id: e.pointerId,
          sx: e.clientX,
          sy: e.clientY,
          ox: posRef.current.x,
          oy: posRef.current.y,
          moved: false,
        }
        el.classList.add('nf-grabbing')
        var root = el.closest('.nf-root')
        if (root) root.classList.add('nf-dragging')
      }

      var onHeadPointerMove = function (e) {
        var d = dragRef.current
        if (!d || d.id !== e.pointerId) return
        var dx = e.clientX - d.sx
        var dy = e.clientY - d.sy
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
        var s = sizeRef.current
        setPos(clampPos(d.ox + dx, d.oy + dy, s.w, s.h))
      }

      var endDrag = function (e) {
        var d = dragRef.current
        if (!d || d.id !== e.pointerId) return
        dragRef.current = null
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch (err) {}
        var el = e.currentTarget
        if (el && el.classList) el.classList.remove('nf-grabbing')
        var root = el && el.closest ? el.closest('.nf-root') : null
        if (root) root.classList.remove('nf-dragging')
        saveStore({ x: posRef.current.x, y: posRef.current.y })
      }

      /* ---- 缩放：右下角手柄，Pointer Events + 捕获 ---- */
      var onResizeDown = function (e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        e.preventDefault()
        e.stopPropagation()
        var el = e.currentTarget
        try {
          el.setPointerCapture(e.pointerId)
        } catch (err) {}
        resizeRef.current = {
          id: e.pointerId,
          sx: e.clientX,
          sy: e.clientY,
          ow: sizeRef.current.w,
          oh: sizeRef.current.h,
        }
        var root = el.closest('.nf-root')
        if (root) root.classList.add('nf-dragging')
      }

      var onResizeMove = function (e) {
        var r = resizeRef.current
        if (!r || r.id !== e.pointerId) return
        var vw = window.innerWidth || 1280
        var vh = window.innerHeight || 800
        var maxW = Math.max(MIN_W, Math.min(MAX_W, vw - posRef.current.x - 8))
        var maxH = Math.max(MIN_H, Math.min(MAX_H, vh - posRef.current.y - 8))
        var nw = Math.min(Math.max(r.ow + (e.clientX - r.sx), MIN_W), maxW)
        var nh = Math.min(Math.max(r.oh + (e.clientY - r.sy), MIN_H), maxH)
        setSize({ w: Math.round(nw), h: Math.round(nh) })
      }

      var onResizeUp = function (e) {
        var r = resizeRef.current
        if (!r || r.id !== e.pointerId) return
        resizeRef.current = null
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch (err) {}
        var el = e.currentTarget
        var root = el && el.closest ? el.closest('.nf-root') : null
        if (root) root.classList.remove('nf-dragging')
        saveStore({ size: { w: sizeRef.current.w, h: sizeRef.current.h } })
      }

      /* ---- 位置/尺寸持久化与视口校正 ---- */
      useEffect(function () {
        function onResize() {
          var s = sizeRef.current
          setPos(function (p) {
            var c = clampPos(p.x, p.y, s.w, s.h)
            return c.x === p.x && c.y === p.y ? p : c
          })
        }
        window.addEventListener('resize', onResize)
        return function () {
          window.removeEventListener('resize', onResize)
        }
      }, [])

      useEffect(function () {
        saveStore({ x: pos.x, y: pos.y, collapsed: collapsed, size: size, loopMode: loopMode })
      }, [pos.x, pos.y, collapsed, size.w, size.h, loopMode])

      /* ---- 首次点击解除自动播放限制 ---- */
      var onRootPointerDownCapture = function () {
        if (pendingPlay.current && audioRef.current) {
          pendingPlay.current = false
          startPlayback()
        }
      }

      /* ---- 遮罩参数写进 CSS 变量 ---- */
      var rootStyle = {
        width: boxW + 'px',
        height: boxH + 'px',
        transform: 'translate(' + Math.round(pos.x) + 'px,' + Math.round(pos.y) + 'px)',
      }
      var scrimStyle = {
        opacity: String(Math.min(Math.max(cfg.overlay, 0), 1)),
        backdropFilter: cfg.blur > 0 ? 'blur(' + cfg.blur + 'px)' : 'none',
        WebkitBackdropFilter: cfg.blur > 0 ? 'blur(' + cfg.blur + 'px)' : 'none',
      }

      /* ---- 壁纸 ---- */
      var wall = null
      for (var i = 0; i < walls.items.length; i++) {
        if (walls.items[i].id === cfg.wallpaperId) {
          wall = walls.items[i]
          break
        }
      }
      var sceneWall = wall && wall.kind === 'scene' ? wall : null
      /* 媒体 token 没就绪前先别拼壁纸地址：那样会发出没有 mt 的请求被 403。
         token 到位会 setMediaReady 触发重渲染，这里自然就接上了。 */
      var wallUrl =
        mediaReady >= 0 && MEDIA.token && wall && !wall.unsupported && wall.kind !== 'scene'
          ? mediaUrl('/api/wallpaper-media?id=' + encodeURIComponent(wall.id))
          : ''
      var isVideoWall = wall && wall.kind === 'video'
      /* 视频壁纸在「静态帧」模式下**保留 video 元素只是暂停**：
         换成 <img src="*.mp4"> 什么也显示不出来，而且会丢掉当前帧。 */
      var showVideo = Boolean(wallUrl) && isVideoWall
      var showImage = Boolean(wallUrl) && !isVideoWall

      var sceneWallRef = useRef(null)
      sceneWallRef.current = sceneWall

      /* 场景壁纸：交给 WebWallGL 实时渲染（图层/粒子/效果），失败则回退预览图。 */
      useEffect(
        function () {
          var wallNow = sceneWallRef.current
          var host = sceneHostRef.current
          if (!host || !wallNow) {
            if (sceneInstRef.current) {
              try {
                sceneInstRef.current.destroy({ releasePkgCache: true })
              } catch (e) {}
              sceneInstRef.current = null
            }
            setSceneState('idle')
            return
          }
          var cancelled = false
          /* 渲染器脚本要带媒体令牌才不会被 403；token 到位会触发重渲染重跑本 effect */
          if (!MEDIA.token) return
          setSceneState('loading')
          loadWebWallGL()
            .then(function (WWG) {
              if (cancelled) return null
              return fetch(apiUrl('/api/scene-pkg?id=' + encodeURIComponent(wallNow.id)), {
                credentials: 'same-origin',
              })
                .then(function (r) {
                  if (!r.ok) throw new Error('scene.pkg HTTP ' + r.status)
                  return r.arrayBuffer()
                })
                .then(function (buf) {
                  if (cancelled) return null
                  return fetch(apiUrl('/api/project-json?id=' + encodeURIComponent(wallNow.id)), {
                    credentials: 'same-origin',
                  })
                    .then(function (r) {
                      return r.ok ? r.json() : null
                    })
                    .catch(function () {
                      return null
                    })
                    .then(function (project) {
                      if (cancelled) return null
                      /* scripts:false —— 壁纸与 DSH 页面同源，不执行壁纸自带的 SceneScript */
                      return WWG.mount(host, {
                        source: WWG.bytesSource(buf, project, wallNow.id),
                        fit: 'cover',
                        fps: 30,
                        volume: 0,
                        autoplay: true,
                        scripts: false,
                        renderDpr: 1,
                      })
                    })
                })
            })
            .then(function (inst) {
              if (!inst) return
              if (cancelled) {
                try {
                  inst.destroy({ releasePkgCache: true })
                } catch (e) {}
                return
              }
              sceneInstRef.current = inst
              setSceneState('ready')
            })
            .catch(function (err) {
              if (cancelled) return
              setSceneState('failed')
              pushNotice('场景渲染失败，已回退预览图：' + ((err && err.message) || err))
            })
          return function () {
            cancelled = true
            var inst = sceneInstRef.current
            sceneInstRef.current = null
            if (inst) {
              try {
                inst.destroy({ releasePkgCache: true })
              } catch (e) {}
            }
          }
        },
        [sceneWall ? sceneWall.id : '', walls.items.length, mediaReady],
      )

      /* 场景壁纸只有预览图时，明确告知一次（不是静默降级）。 */
      var degradedNoticed = useRef('')
      useEffect(
        function () {
          if (!wall || !wall.degraded) return
          if (degradedNoticed.current === wall.id) return
          degradedNoticed.current = wall.id
          pushNotice(wall.reason || '场景壁纸暂不支持，当前显示预览图')
        },
        [wall ? wall.id : '', wall ? Boolean(wall.degraded) : false, pushNotice],
      )

      var videoRefCb = useCallback(
        function (el) {
          videoRef.current = el
          if (!el) return
          el.muted = true
          el.loop = true
          el.playsInline = true
          var p = el.play()
          if (p && p.catch) {
            p.catch(function () {
              /* 被策略拦截：保持静音循环，等用户交互后再试 */
            })
          }
        },
        [],
      )

      useEffect(
        function () {
          var inst = sceneInstRef.current
          if (inst) {
            try {
              if (cfg.wallpaperMode === 'static') inst.pause()
              else inst.resume()
            } catch (e) {}
          }
          var v = videoRef.current
          if (!v) return
          if (cfg.wallpaperMode === 'static') {
            try {
              v.pause()
            } catch (e) {}
          } else {
            var p = v.play()
            if (p && p.catch)
              p.catch(function () {
                /* ignore */
              })
          }
        },
        [cfg.wallpaperMode, wallUrl, sceneState],
      )

      /* ---- 当前歌词行 ---- */
      var activeLyric = ''
      var nextLyric = ''
      var lyricIndex = -1
      if (cfg.lyrics && lyric.length) {
        for (var k = 0; k < lyric.length; k++) {
          if (lyric[k].t <= progress + 0.25) lyricIndex = k
          else break
        }
        activeLyric = lyricIndex >= 0 ? lyric[lyricIndex].text : lyric[0] ? lyric[0].text : ''
        nextLyric = lyric[lyricIndex + 1] ? lyric[lyricIndex + 1].text : ''
      }
      /* 空白区（head 与控制条之间）展示歌词：当前行高亮，前后各一行做上下文。 */
      var lyricLines = []
      if (cfg.lyrics && lyric.length) {
        var from = Math.max(0, lyricIndex - 1)
        var to = Math.min(lyric.length - 1, lyricIndex + 1)
        for (var q = from; q <= to; q++) lyricLines.push({ text: lyric[q].text, on: q === lyricIndex })
      }

      /* ---- seek ---- */
      var onSeekDown = function (e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        var el = e.currentTarget
        /* 以轨道本身量宽度：进度条容器带 14px 命中高度，padding 或主题改动都可能让它
           比轨道宽，按容器算会把指针位置算偏，最坏直接落到 0。 */
        var track = el.querySelector('.nf-progress-track') || el
        var rect = track.getBoundingClientRect()
        if (!rect.width || rect.width <= 0) rect = el.getBoundingClientRect()
        function seekTo(clientX) {
          if (!(rect.width > 0)) return
          var a = audioRef.current
          if (!a) return
          /* duration 优先用 audio 的真实值（切歌后 state 可能还是上一首的），
             但流式/未就绪时 a.duration 常是 Infinity 或 NaN —— 那种情况必须
             退回 state，绝不能因为取不到就整个吞掉 seek（上一版就是这么坏的）。 */
          var d = Number(a.duration)
          if (!Number.isFinite(d) || d <= 0) d = Number(duration)
          if (!Number.isFinite(d) || d <= 0) {
            /* 最后一道：搜索结果自带时长（毫秒），够用来算 seek 目标 */
            var cd = currentRef.current && Number(currentRef.current.duration)
            if (Number.isFinite(cd) && cd > 0) d = cd / 1000
          }
          if (!Number.isFinite(d) || d <= 0) return
          var pct = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
          var target = pct * d
          seekTargetRef.current = target
          /* 兜底：seeked 迟迟不来（源不可 seek 等）也要把 target 放掉，
             否则 pendingSeek 会一直挡住进度更新。
             顺带复查一次：浏览器在弱网下偶发把播放位置甩回 0，这里补拉回去。 */
          if (seekTimerRef.current) window.clearTimeout(seekTimerRef.current)
          seekTimerRef.current = window.setTimeout(function () {
            var t2 = seekTargetRef.current
            seekTargetRef.current = null
            seekTimerRef.current = 0
            var cur = audioRef.current
            if (!cur || t2 === null) return
            if (Math.abs((Number(cur.currentTime) || 0) - t2) > 3) {
              try {
                cur.currentTime = t2
              } catch (err) {}
              setProgress(t2)
              /* 仍然对不上时把可跳范围摆出来，定位问题不用再猜 */
              try {
                var sk = cur.seekable
                var skEnd = sk && sk.length ? sk.end(sk.length - 1) : 0
                if (skEnd + 1 < t2) {
                  pushNotice('无法跳转：只能跳到 ' + fmtTime(skEnd) + '，目标 ' + fmtTime(t2))
                }
              } catch (err2) {}
            }
          }, 2500)
          try {
            a.currentTime = target
          } catch (err) {}
          /* 关键：直接回显目标位置，不读 a.currentTime —— 赋值是异步生效的，
             立刻读会拿到旧值（常见是 0），再被 seeking 标记挡住 timeupdate，
             画面上看起来就是"一点就回到最开始"。 */
          setProgress(target)
        }
        seekTo(e.clientX)
        seekingRef.current = true
        try {
          el.setPointerCapture(e.pointerId)
        } catch (err) {}
        function move(ev) {
          seekTo(ev.clientX)
        }
        function up() {
          seekingRef.current = false
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }

      /* ---- 保存设置 ---- */
      var patchConfig = useCallback(
        function (patch) {
          return getJson('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch || {}),
          })
            .then(function (j) {
              if (j && j.config) {
                setCfg(function (old) {
                  return Object.assign({}, old, {
                    overlay: typeof j.config.overlay === 'number' ? j.config.overlay : old.overlay,
                    blur: typeof j.config.blur === 'number' ? j.config.blur : old.blur,
                    wallpaperMode: j.config.wallpaperMode === 'static' ? 'static' : 'video',
                    wallpaperId: j.config.wallpaperId || '',
                    lyrics: j.config.lyrics !== false,
                    volume: typeof j.config.volume === 'number' ? j.config.volume : old.volume,
                    wallpaperDir: j.config.wallpaperDir || old.wallpaperDir || '',
                  })
                })
              }
              if (j && j.cookie) setCookieState(j.cookie)
              return j
            })
            .catch(function (e) {
              pushNotice('保存失败：' + e.message)
            })
        },
        [pushNotice],
      )

      /* ---------------------------------------------------------- render */

      var head = h(
        'div',
        {
          className: 'nf-head',
          onPointerDown: onHeadPointerDown,
          onPointerMove: onHeadPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          title: '拖动移动小窗',
        },
        h('span', { className: 'nf-dot' }),
        h(
          'div',
          { className: 'nf-title' },
          h('div', { className: 'nf-song' }, current ? current.name : '网易云悬浮播放器'),
          h('div', { className: 'nf-artist' }, current ? current.artist || '未知歌手' : '拖动我 · 点搜索选歌'),
        ),
        h(
          'button',
          {
            className: 'nf-ico',
            'data-nf-nodrag': '1',
            title: panel === 'search' ? '关闭搜索' : '搜索歌曲',
            onClick: function () {
              setPanel(panel === 'search' ? 'none' : 'search')
            },
          },
          '⌕',
        ),
        h(
          'button',
          {
            className: 'nf-ico',
            'data-nf-nodrag': '1',
            title: panel === 'list' ? '关闭列表' : '播放列表与歌单',
            onClick: function () {
              setPanel(panel === 'list' ? 'none' : 'list')
            },
          },
          '☰',
        ),
        h(
          'button',
          {
            className: 'nf-ico',
            'data-nf-nodrag': '1',
            title: panel === 'settings' ? '关闭设置' : '设置',
            onClick: function () {
              setPanel(panel === 'settings' ? 'none' : 'settings')
            },
          },
          '⚙',
        ),
        h(
          'button',
          {
            className: 'nf-ico',
            'data-nf-nodrag': '1',
            title: collapsed ? '展开播放器' : '收起播放器',
            onClick: function () {
              setCollapsed(!collapsed)
              setPanel('none')
            },
          },
          collapsed ? '▢' : '—',
        ),
      )

      var lyricBlock = collapsed
        ? null
        : h(
            'div',
            { className: 'nf-lyric' },
            lyricLines.length
              ? lyricLines.map(function (line, li) {
                  return h(
                    'div',
                    { key: li, className: 'nf-lyric-line' + (line.on ? ' on' : '') },
                    line.text,
                  )
                })
              : h(
                  'div',
                  { className: 'nf-lyric-empty' },
                  current ? (cfg.lyrics ? '暂无歌词' : '歌词已关闭') : '点搜索选歌',
                ),
          )

      var pct = duration > 0 ? Math.min(Math.max(progress / duration, 0), 1) : 0
      var bufPct = duration > 0 && bufferedEnd > 0 ? Math.min(Math.max(bufferedEnd / duration, 0), 1) : 0

      var controls = h(
        'div',
        { className: 'nf-controls' },
        h(
          'div',
          { className: 'nf-progress', 'data-nf-nodrag': '1', onPointerDown: onSeekDown, title: '拖动跳转' },
          h(
            'div',
            { className: 'nf-progress-track' },
            h('div', { className: 'nf-progress-buf', style: { width: bufPct * 100 + '%' } }),
            h('div', { className: 'nf-progress-fill', style: { width: pct * 100 + '%' } }),
          ),
        ),
        h(
          'div',
          { className: 'nf-row' },
          h('span', { className: 'nf-time' }, fmtTime(progress)),
          h(
            'button',
            {
              className: 'nf-ico',
              'data-nf-nodrag': '1',
              title: '上一首',
              onClick: function () {
                playNext(-1)
              },
            },
            '⏮',
          ),
          h(
            'button',
            {
              className: 'nf-ico',
              'data-nf-nodrag': '1',
              title: playing ? '暂停' : '播放',
              onClick: function () {
                var a = audioRef.current
                if (!a) return
                if (!a.src) {
                  if (results.length) playSong(results[0])
                  else setPanel('search')
                  return
                }
                if (a.paused) {
                  startPlayback()
                } else {
                  a.pause()
                }
              },
            },
            playing ? '⏸' : '▶',
          ),
          h(
            'button',
            {
              className: 'nf-ico',
              'data-nf-nodrag': '1',
              title: '下一首',
              onClick: function () {
                playNext(1)
              },
            },
            '⏭',
          ),
          h(
            'button',
            {
              className: 'nf-ico' + (loopMode !== 'off' ? ' nf-ico-on' : ''),
              'data-nf-nodrag': '1',
              title:
                loopMode === 'list' ? '列表循环（点击切单曲）' : loopMode === 'one' ? '单曲循环（点击关闭）' : '不循环（点击开列表）',
              onClick: function () {
                var next = loopMode === 'list' ? 'one' : loopMode === 'one' ? 'off' : 'list'
                setLoopMode(next)
              },
            },
            loopMode === 'list' ? '↻' : loopMode === 'one' ? '↻¹' : '⇥',
          ),
          h('span', { className: 'nf-time' }, fmtTime(duration)),
          h('div', { className: 'nf-spacer' }),
          h(
            'button',
            {
              className: 'nf-ico',
              'data-nf-nodrag': '1',
              title: cfg.wallpaperMode === 'video' ? '切换为静态帧' : '切换为动态壁纸',
              onClick: function () {
                patchConfig({ wallpaperMode: cfg.wallpaperMode === 'video' ? 'static' : 'video' })
              },
            },
            cfg.wallpaperMode === 'video' ? '⏵' : '☰',
          ),
        ),
      )

      var searchPanel =
        panel === 'search'
          ? h(
              'div',
              { className: 'nf-panel' },
              h(
                'div',
                { className: 'nf-panel-head' },
                h('input', {
                  className: 'nf-input',
                  'data-nf-nodrag': '1',
                  placeholder: '搜索歌曲 / 歌手…',
                  value: query,
                  onChange: function (e) {
                    setQuery(e.target.value)
                  },
                  onKeyDown: function (e) {
                    if (e.key === 'Enter') doSearch()
                  },
                }),
                h(
                  'button',
                  {
                    className: 'nf-btn',
                    'data-nf-nodrag': '1',
                    disabled: searching,
                    onClick: doSearch,
                  },
                  searching ? '…' : '搜索',
                ),
              ),
              h(
                'div',
                { className: 'nf-list' },
                results.length === 0
                  ? h('div', { className: 'nf-empty' }, searching ? '搜索中…' : '输入关键词后回车。播放不了多半是版权曲，可在设置里导入网易云登录态。')
                  : results.map(function (s) {
                      return h(
                        'div',
                        {
                          key: String(s.id),
                          className: 'nf-item' + (current && current.id === s.id ? ' on' : ''),
                          'data-nf-nodrag': '1',
                          onClick: function () {
                            playSong(s)
                          },
                        },
                        h('div', { className: 'nf-item-name' }, s.name, (s.fee === 1 || s.fee === 4)
                          ? h('span', { className: 'nf-vip' }, 'VIP')
                          : null),
                        h('div', { className: 'nf-item-sub' }, (s.artist || '') + (s.album ? ' · ' + s.album : '')),
                      )
                    }),
              ),
            )
          : null

      var wallOptions = walls.items.map(function (it) {
        var label = it.title
        if (it.unsupported) label += '（不支持）'
        else if (it.degraded) label += '（场景壁纸·仅预览图）'
        return h('option', { key: it.id, value: it.id, disabled: Boolean(it.unsupported) }, label)
      })

      var listPanel =
        panel === 'list'
          ? h(
              'div',
              { className: 'nf-panel' },
              h(
                'div',
                { className: 'nf-panel-head' },
                h(
                  'button',
                  {
                    className: 'nf-tab' + (listTab === 'queue' ? ' on' : ''),
                    'data-nf-nodrag': '1',
                    onClick: function () {
                      setListTab('queue')
                    },
                  },
                  '队列 ' + results.length,
                ),
                h(
                  'button',
                  {
                    className: 'nf-tab' + (listTab === 'nm' ? ' on' : ''),
                    'data-nf-nodrag': '1',
                    onClick: function () {
                      setListTab('nm')
                      if (!nm.items.length && !nm.loading) loadNmPlaylists()
                    },
                  },
                  '账号歌单 ' + (nm.items.length || ''),
                ),
                h('div', { className: 'nf-spacer' }),
                nm.nickname ? h('span', { className: 'nf-hint' }, nm.nickname) : null,
              ),
              h(
                'div',
                { className: 'nf-list' },
                listTab === 'queue'
                  ? results.length
                    ? results.map(function (s) {
                        return h(
                          'div',
                          {
                            key: String(s.id),
                            className: 'nf-item' + (current && String(current.id) === String(s.id) ? ' on' : ''),
                            'data-nf-nodrag': '1',
                            onClick: function () {
                              playSong(s)
                            },
                          },
                          h('div', { className: 'nf-item-name' }, s.name),
                          h('div', { className: 'nf-item-sub' }, s.artist || ''),
                        )
                      })
                    : h(
                        'div',
                        { className: 'nf-empty' },
                        '队列是空的。搜索出来的歌会自动进队列；加载歌单会替换队列。',
                      )
                  : nm.loading
                    ? h('div', { className: 'nf-empty' }, '正在读取账号歌单…')
                    : nm.error
                      ? h('div', { className: 'nf-empty' }, nm.error)
                      : nm.items.length
                        ? nm.items.map(function (p) {
                            return h(
                              'div',
                              {
                                key: String(p.id),
                                className: 'nf-item',
                                'data-nf-nodrag': '1',
                                onClick: function () {
                                  loadNmPlaylist(p)
                                },
                              },
                              h('div', { className: 'nf-item-name' }, p.name),
                              h(
                                'div',
                                { className: 'nf-item-sub' },
                                (p.special ? '我喜欢的音乐 · ' : '') +
                                  p.trackCount +
                                  ' 首' +
                                  (p.creator ? ' · ' + p.creator : ''),
                              ),
                            )
                          })
                        : h('div', { className: 'nf-empty' }, '账号里还没有歌单。'),
              ),
            )
          : null

      var settingsPanel =
        panel === 'settings'
          ? h(
              'div',
              { className: 'nf-panel' },
              h(
                'div',
                { className: 'nf-panel-head' },
                h('strong', { style: { fontSize: '12px' } }, '小窗设置'),
                h('div', { className: 'nf-spacer' }),
                h(
                  'button',
                  { className: 'nf-btn', 'data-nf-nodrag': '1', onClick: function () { setPanel('none') } },
                  '关闭',
                ),
              ),
              h(
                'div',
                { className: 'nf-set' },
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '壁纸目录（Steam workshop/content/431960）'),
                  h('input', {
                    className: 'nf-input',
                    'data-nf-nodrag': '1',
                    placeholder: '例如 D:\\SteamLibrary\\steamapps\\workshop\\content\\431960',
                    defaultValue: cfg.wallpaperDir || '',
                    onBlur: function (e) {
                      patchConfig({ wallpaperDir: e.target.value.trim() }).then(loadWalls)
                    },
                    onKeyDown: function (e) {
                      if (e.key === 'Enter') {
                        patchConfig({ wallpaperDir: e.target.value.trim() }).then(loadWalls)
                      }
                    },
                  }),
                  h(
                    'span',
                    { className: 'nf-hint' },
                    walls.error ? walls.error : '扫描到 ' + walls.items.length + ' 个壁纸条目',
                  ),
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '小窗背景壁纸'),
                  h(
                    'select',
                    {
                      className: 'nf-select',
                      'data-nf-nodrag': '1',
                      value: cfg.wallpaperId || '',
                      onChange: function (e) {
                        patchConfig({ wallpaperId: e.target.value })
                      },
                    },
                    h('option', { value: '' }, '无（默认渐变）'),
                    wallOptions,
                  ),
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '壁纸模式'),
                  h(
                    'select',
                    {
                      className: 'nf-select',
                      'data-nf-nodrag': '1',
                      value: cfg.wallpaperMode,
                      onChange: function (e) {
                        patchConfig({ wallpaperMode: e.target.value })
                      },
                    },
                    h('option', { value: 'video' }, '动态（视频循环）'),
                    h('option', { value: 'static' }, '静态帧（停止解码）'),
                  ),
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '遮罩不透明度 ' + Math.round(cfg.overlay * 100) + '%'),
                  h('input', {
                    className: 'nf-slider',
                    'data-nf-nodrag': '1',
                    type: 'range',
                    min: '0',
                    max: '1',
                    step: '0.05',
                    value: cfg.overlay,
                    onChange: function (e) {
                      setCfg(function (o) {
                        return Object.assign({}, o, { overlay: Number(e.target.value) })
                      })
                    },
                    onPointerUp: function (e) {
                      patchConfig({ overlay: Number(e.target.value) })
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '遮罩模糊 ' + cfg.blur + 'px'),
                  h('input', {
                    className: 'nf-slider',
                    'data-nf-nodrag': '1',
                    type: 'range',
                    min: '0',
                    max: '20',
                    step: '1',
                    value: cfg.blur,
                    onChange: function (e) {
                      setCfg(function (o) {
                        return Object.assign({}, o, { blur: Number(e.target.value) })
                      })
                    },
                    onPointerUp: function (e) {
                      patchConfig({ blur: Number(e.target.value) })
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '音量 ' + Math.round(cfg.volume * 100) + '%'),
                  h('input', {
                    className: 'nf-slider',
                    'data-nf-nodrag': '1',
                    type: 'range',
                    min: '0',
                    max: '1',
                    step: '0.05',
                    value: cfg.volume,
                    onChange: function (e) {
                      var v = Number(e.target.value)
                      if (audioRef.current) audioRef.current.volume = v
                      setCfg(function (o) {
                        return Object.assign({}, o, { volume: v })
                      })
                    },
                    onPointerUp: function (e) {
                      patchConfig({ volume: Number(e.target.value) })
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h('span', { className: 'nf-label' }, '网易云登录态（可选）'),
                  h(
                    'span',
                    { className: 'nf-hint' },
                    cookieState && cookieState.present
                      ? '已配置 MUSIC_U（…' + (cookieState.tail || '') + '），仅存本机。'
                      : '未配置。VIP/版权曲需要登录态；可从本机网易云客户端导入，或先在设置里粘贴 Cookie。',
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '6px' } },
                    h(
                      'button',
                      {
                        className: 'nf-btn',
                        'data-nf-nodrag': '1',
                        onClick: function () {
                          getJson('/api/netease-cookie', { method: 'POST' })
                            .then(function (j) {
                              setCookieState({ present: true, hasMusicU: true, tail: j.tail || '' })
                              pushNotice('已从本机网易云客户端导入登录态（只存本机）')
                            })
                            .catch(function (e) {
                              pushNotice(e.message || '导入失败')
                            })
                        },
                      },
                      '从客户端导入',
                    ),
                    h(
                      'button',
                      {
                        className: 'nf-btn',
                        'data-nf-nodrag': '1',
                        onClick: function () {
                          /* Electron 里 window.prompt 恒返回 null，改用面板内联输入 */
                          setCookieInput(cookieInput === null ? '' : null)
                        },
                      },
                      cookieInput === null ? '粘贴 Cookie' : '取消',
                    ),
                  ),
                  cookieInput !== null
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                        h('textarea', {
                          className: 'nf-input',
                          'data-nf-nodrag': '1',
                          value: cookieInput,
                          placeholder: 'MUSIC_U=...; __csrf=...',
                          style: { height: '56px', padding: '6px 8px', resize: 'none', width: '100%' },
                          onChange: function (ev) {
                            setCookieInput(ev.target.value)
                          },
                        }),
                        h(
                          'button',
                          {
                            className: 'nf-btn',
                            'data-nf-nodrag': '1',
                            onClick: function () {
                              var v = String(cookieInput || '').trim()
                              if (!v) {
                                pushNotice('Cookie 是空的')
                                return
                              }
                              patchConfig({ cookie: v })
                                .then(function () {
                                  setCookieInput(null)
                                  pushNotice('已保存 Cookie（仅本机）')
                                })
                                .catch(function () {})
                            },
                          },
                          '保存',
                        ),
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'nf-field' },
                  h(
                    'span',
                    { className: 'nf-hint' },
                    '提示：小窗背景与 DSH 主界面完全隔离；卸载插件后小窗与路由一起消失。',
                  ),
                ),
              ),
            )
          : null

      return h(
        'div',
        {
          className: 'nf-root' + (collapsed ? ' nf-is-collapsed' : ''),
          style: rootStyle,
          onPointerDownCapture: onRootPointerDownCapture,
        },
        h(
          'div',
          { className: 'nf-bg' },
          sceneWall
            ? h('div', {
                ref: sceneHostRef,
                className: 'nf-scene-host' + (sceneState === 'ready' ? ' is-ready' : ''),
              })
            : showVideo
              ? h('video', {
                  key: wallUrl,
                  ref: videoRefCb,
                  src: wallUrl,
                  muted: true,
                  loop: true,
                  playsInline: true,
                  autoPlay: true,
                  preload: 'auto',
                })
              : showImage
                ? h('img', { key: wallUrl, src: wallUrl, alt: '' })
                : null,
          /* 渲染器加载期间/失败时用预览图兜底，画面不至于空着 */
          sceneWall && sceneState !== 'ready' && sceneWall.preview
            ? h('img', {
                className: 'nf-scene-poster',
                src: mediaUrl('/api/wallpaper-preview?id=' + encodeURIComponent(sceneWall.id)),
                alt: '',
              })
            : null,
        ),
        h('div', { className: 'nf-scrim', style: scrimStyle }),
        h('div', { className: 'nf-ui' }, head, lyricBlock, collapsed ? null : controls),
        searchPanel,
        listPanel,
        settingsPanel,
        collapsed
          ? null
          : h('div', {
              className: 'nf-resize',
              'data-nf-nodrag': '1',
              title: '拖动缩放小窗',
              onPointerDown: onResizeDown,
              onPointerMove: onResizeMove,
              onPointerUp: onResizeUp,
              onPointerCancel: onResizeUp,
            }),
        notice ? h('div', { className: 'nf-toast' }, notice) : null,
      )
    }

    /* --------------------------------------------------------------- apply */

    var inject = ['slots']

    function apply(ctx) {
      var diag = {
        applyCalled: true,
        hasSlots: !!(ctx && ctx.slots),
        injectFn: ctx && ctx.slots ? typeof ctx.slots.inject : 'n/a',
        registerFn: ctx && ctx.slots ? typeof ctx.slots.register : 'n/a',
        slotCbCalled: false,
        registerReturnType: null,
        error: null,
      }
      try {
        window.__NF_DIAG__ = diag
      } catch (e) {}
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
        diag.error = 'no slots service'
        return
      }
      var disposers = []
      try {
        var d = ctx.slots.inject('shell.overlay', function () {
          diag.slotCbCalled = true
          try {
            var reg = ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-netease-float', order: 120 },
              FloatPlayer,
            )
            diag.registerReturnType = typeof reg
            return reg
          } catch (err) {
            diag.error = String((err && err.message) || err)
            throw err
          }
        })
        diag.injectReturnType = typeof d
        if (d) disposers.push(d)
      } catch (err) {
        diag.error = 'inject failed: ' + String((err && err.message) || err)
        try {
          console.warn('[dsh-netease-float] slot inject failed:', err)
        } catch (e) {}
      }

      var styleEl = null
      try {
        styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-netease-float', '1')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
      } catch (e) {}

      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) {
            try {
              disposers[i]()
            } catch (e) {}
          }
          disposers = []
          if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
