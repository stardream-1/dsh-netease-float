/**
 * dsh-netease-float — Host 半侧
 * ---------------------------------------------------------------------------
 * 职责（三条，边界清晰）：
 *   1) 同源代理网易云：搜索 / 歌词 / 音频（音频流透传 Range，前端不直连 163）
 *   2) 小窗壁纸：读用户配置的 Wallpaper Engine 目录，解析 project.json，
 *      只放行白名单扩展名的媒体，流式返回（同样支持 Range）
 *   3) 配置读写：~/.dsh/netease-float.json（仅本机）
 *
 * 刻意不做的事：
 *   - 不扫描磁盘找 Wallpaper Engine。目录由用户显式配置，避免全盘 IO。
 *   - 不支持场景壁纸（scene.pkg / scene.json）。遇到时返回明确原因，不静默失败。
 *   - 不碰 DSH 主界面：本插件没有任何 index/主题注入，壁纸只经媒体路由下发。
 *
 * 安全边界：
 *   - 所有路由先过 connection.requestRejection（浏览器信任栅栏）。
 *   - 壁纸路径：realpath 必须落在配置根目录内，且扩展名在白名单里。
 *   - 音频代理：解析出的上游地址 host 必须在网易云域名白名单内（防 SSRF）。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { probeSceneVideoFromPkgFile, extractSceneVideoFromPkgFile } from './vendor/scene-manifest.js'

const NAME = 'dsh-netease-float'
const BASE = '/netease-float'
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'netease-float.json')
/** 场景壁纸提取出的内嵌视频缓存目录（只存本机）。 */
const SCENE_CACHE_DIR = path.join(os.homedir(), '.dsh', 'cache', 'netease-float')
/** 随包分发的 WebWallGL 场景渲染器（浏览器端脚本，客户端按需加载）。 */
const WEBWALLGL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'webwallgl.global.min.js')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * 媒体路由的免栅栏令牌。
 *
 * 为什么需要：桌面端页面 origin 是 `dsh-app://app`，音频/壁纸由浏览器原生发
 * `http://127.0.0.1:<port>/netease-float/api/...` —— 这种请求**不带 DSH 的认证 cookie**，
 * 会被 connection.requestRejection 一律挡成 401，表现为音频加载失败
 * （NotSupportedError，免费歌同理）。媒体路由改用本进程随机令牌校验：
 * 只在本机、进程生命周期内有效，内容本身也不是敏感数据。
 */
const MEDIA_TOKEN = randomBytes(16).toString('hex')

/** 小窗背景允许的媒体类型（场景壁纸 .pkg 走不通，明确拒绝）。 */
const MEDIA_EXT = {
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.png': { kind: 'image', type: 'image/png' },
  '.gif': { kind: 'image', type: 'image/gif' },
}

const DEFAULTS = {
  wallpaperDir: '',
  wallpaperId: '',
  /** 只存本机，不上传、不进日志。 */
  cookie: '',
  /** 遮罩：0..1 暗化强度 */
  overlay: 0.55,
  /** 遮罩模糊强度 px */
  blur: 6,
  /** 动态壁纸 / 静态帧 */
  wallpaperMode: 'video',
  /** 小窗展开时是否显示歌词 */
  lyrics: true,
  /** 音量 0..1 */
  volume: 0.8,
}

function readConfig() {
  try {
    // 同步读：配置很小，apply 与请求路径都要用，避免 async 传染。
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    const out = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k]
    }
    return out
  } catch {
    return { ...DEFAULTS }
  }
}

/** 把配置原子写回（先写临时文件再 rename），避免半截 JSON。 */
async function writeConfig(next) {
  const merged = { ...readConfig() }
  for (const k of Object.keys(DEFAULTS)) {
    if (next && next[k] !== undefined && typeof next[k] === typeof DEFAULTS[k]) merged[k] = next[k]
  }
  // cookie 允许显式置空
  if (next && typeof next.cookie === 'string') merged.cookie = next.cookie
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = CONFIG_FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8')
  await fsp.rename(tmp, CONFIG_FILE)
  return merged
}

/** 掩码：只暴露存在性与尾四位，回给前端也不泄露完整凭据。 */
function maskCookie(cookie) {
  if (!cookie) return null
  const musicU = /MUSIC_U=([^;]+)/.exec(cookie)
  const tail = musicU ? musicU[1].slice(-4) : ''
  return { present: true, hasMusicU: Boolean(musicU), tail }
}

/* ---------------------------------------------------------------- 账号歌单 */

/** 登录账号 id 缓存（1 小时），避免每次开面板都打一次账号接口。 */
let nmUidCache = { uid: 0, at: 0, nickname: '' }

async function nmAccount() {
  const cfg = readConfig()
  if (!cfg.cookie) return { error: '需要先配置网易云 Cookie（设置 → 网易云登录态）' }
  if (nmUidCache.uid && Date.now() - nmUidCache.at < 3600 * 1000) {
    return { uid: nmUidCache.uid, nickname: nmUidCache.nickname }
  }
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/', Cookie: cfg.cookie }
  try {
    const r = await fetch('https://music.163.com/api/nuser/account/get', { headers })
    const j = await r.json()
    const uid = j && j.account && j.account.id
    if (!uid) return { error: 'Cookie 已失效或未登录，重新配置一次' }
    const nickname = (j.profile && j.profile.nickname) || ''
    nmUidCache = { uid, at: Date.now(), nickname }
    return { uid, nickname }
  } catch (err) {
    return { error: '读取账号失败：' + ((err && err.message) || err) }
  }
}

/** 把网易云 track 压成前端要的形状（新旧两套字段都兼容）。 */
function songFromTrack(t) {
  if (!t || !t.id) return null
  const ar = (t.ar && t.ar.map((a) => a.name)) || (t.artists && t.artists.map((a) => a.name)) || []
  return {
    id: t.id,
    name: String(t.name || '').slice(0, 120),
    artist: ar.join(' / ').slice(0, 120),
    album: String((t.al && t.al.name) || (t.album && t.album.name) || '').slice(0, 120),
    duration: Number(t.dt || t.duration) || 0,
    fee: Number(t.fee) || 0,
  }
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        resolve('')
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/* ---------------------------------------------------------------- 网易云 */

/** 上游音频域名白名单：只放行网易云自己的媒体机。 */
function isAllowedAudioHost(host) {
  if (!host) return false
  const h = host.toLowerCase()
  return (
    h === 'music.163.com' ||
    h.endsWith('.music.163.com') ||
    h.endsWith('.126.net') ||
    h === '163.com' ||
    h === 'music.126.net'
  )
}

/** 播放地址缓存：拖进度条会连发多次 Range 请求，每次重新解析要多打两次网易云接口。
 *  TTL 取 5 分钟（网易云外链本身带过期时间，太长会拿到失效地址）。 */
const audioUrlCache = new Map()
const AUDIO_URL_TTL = 5 * 60 * 1000
const AUDIO_URL_CACHE_MAX = 60

async function resolveAudioUrl(id) {
  const hit = audioUrlCache.get(id)
  if (hit && Date.now() - hit.at < AUDIO_URL_TTL) return hit.url
  const resolved = await resolveAudioUrlUncached(id)
  if (resolved) {
    audioUrlCache.set(id, { url: resolved, at: Date.now() })
    if (audioUrlCache.size > AUDIO_URL_CACHE_MAX) {
      const oldest = audioUrlCache.keys().next().value
      audioUrlCache.delete(oldest)
    }
  }
  return resolved
}

async function resolveAudioUrlUncached(id) {
  const cfg = readConfig()
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
  if (cfg.cookie) headers.Cookie = cfg.cookie

  // 1) 官方外链：免费曲直接 302 到 mp3；登录态下 VIP 曲也同样有效。
  try {
    const r = await fetch(`https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, {
      headers,
      redirect: 'manual',
    })
    const loc = r.headers.get('location')
    if (loc) {
      const abs = new URL(loc, 'https://music.163.com/')
      if (isAllowedAudioHost(abs.host) && !/\/404(\?|$)/.test(abs.pathname)) return abs.toString()
    }
  } catch {
    /* 回落 */
  }

  // 2) 播放地址接口
  try {
    const r = await fetch(
      `https://music.163.com/api/song/enhance/player/url?ids=[${encodeURIComponent(id)}]&br=320000`,
      { headers },
    )
    const j = await r.json()
    const url = j && j.data && j.data[0] && j.data[0].url
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      const abs = new URL(url)
      if (isAllowedAudioHost(abs.host)) return abs.toString()
      return null
    }
  } catch {
    /* 无解 */
  }
  return null
}

/** 把上游响应（含 Range/206）原样转发给浏览器。 */
async function proxyAudio(req, res, url) {
  const cfg = readConfig()
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
  if (cfg.cookie) headers.Cookie = cfg.cookie
  const range = req.headers.range
  if (typeof range === 'string' && range) headers.Range = range

  let upstream
  try {
    upstream = await fetch(url, { headers, redirect: 'follow' })
  } catch (err) {
    sendJson(res, 502, { ok: false, error: 'upstream fetch failed: ' + (err && err.message) })
    return
  }
  const type = upstream.headers.get('content-type') || ''
  if (upstream.status >= 400 || !/^(audio|application\/octet-stream)/i.test(type)) {
    // 网易云对不可播的曲目返回 200 + text/html 的 404 页，这里必须挡掉
    sendJson(res, 404, {
      ok: false,
      error: 'no playable audio for this track (VIP/下架/版权限制)',
      upstreamStatus: upstream.status,
      upstreamType: type,
    })
    return
  }

  const out = {
    'Content-Type': type || 'audio/mpeg',
    /* 这片字节对同一首歌是稳定的，必须允许浏览器缓存：
       之前写 no-store，浏览器拿不到可复用的缓冲，seek 时就当新资源重下，
       表现是"点了跳过去、过一会儿又回到 0:00"。 */
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
    /* 桌面端页面 origin 是 dsh-app://app，走真实 HTTP 播音频属于跨源，放开只读媒体。 */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  }
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h)
    if (v) out[h === 'content-length' ? 'Content-Length' : 'Content-Range'] = v
  }
  res.writeHead(upstream.status, out)
  if (!upstream.body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {}
  })
  req.on('close', () => {
    try {
      stream.destroy()
    } catch {}
  })
  stream.pipe(res)
}

/* ---------------------------------------------------------------- 壁纸 */

/** 场景视频探测结果缓存：键含 mtime+size，壁纸被替换后自动失效。 */
const sceneProbeCache = new Map()

async function probeSceneCached(pkgPath) {
  let st
  try {
    st = await fsp.stat(pkgPath)
  } catch {
    return false
  }
  const key = pkgPath + '|' + st.size + '|' + Math.round(st.mtimeMs)
  if (sceneProbeCache.has(key)) return sceneProbeCache.get(key)
  let ok = false
  try {
    ok = await probeSceneVideoFromPkgFile(pkgPath)
  } catch {
    ok = false
  }
  sceneProbeCache.set(key, ok)
  return ok
}

/** 场景缓存上限：超过就按最旧优先删，避免切壁纸把磁盘吃满。 */
const SCENE_CACHE_MAX_BYTES = 512 * 1024 * 1024

async function pruneSceneCache() {
  const names = await fsp.readdir(SCENE_CACHE_DIR).catch(() => [])
  const files = []
  for (const n of names) {
    if (!n.endsWith('.mp4')) continue
    try {
      const st = await fsp.stat(path.join(SCENE_CACHE_DIR, n))
      files.push({ n, size: st.size, at: st.mtimeMs })
    } catch {}
  }
  let total = files.reduce((s, f) => s + f.size, 0)
  if (total <= SCENE_CACHE_MAX_BYTES) return
  files.sort((a, b) => a.at - b.at)
  for (const f of files) {
    if (total <= SCENE_CACHE_MAX_BYTES) break
    try {
      await fsp.unlink(path.join(SCENE_CACHE_DIR, f.n))
      total -= f.size
    } catch {}
  }
}

/** 校验并定位一个场景壁纸的 scene.pkg（供渲染器与 project.json 路由复用）。 */
async function resolveScenePkg(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const info = await inspectWallpaperDir(root, id)
  if (!info || !info.scene || !info.pkg) return { error: '该壁纸不是场景壁纸', code: 404 }
  const dir = path.join(root, id)
  const pkgPath = path.resolve(dir, info.pkg)
  const rootAbs = path.resolve(root)
  if (!(pkgPath === rootAbs || pkgPath.startsWith(rootAbs + path.sep))) return { error: '路径越界', code: 403 }
  let st
  try {
    st = await fsp.stat(pkgPath)
  } catch {
    return { error: 'scene.pkg 不可读', code: 404 }
  }
  return { file: pkgPath, size: st.size, dir }
}

/** 场景壁纸的预览图（加载占位 / 渲染失败兜底）。 */
async function resolvePreviewFile(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const info = await inspectWallpaperDir(root, id)
  if (!info || !info.preview) return { error: '该壁纸没有预览图', code: 404 }
  const rootAbs = path.resolve(root)
  const full = path.resolve(path.join(root, id), info.preview)
  if (!full.startsWith(rootAbs + path.sep)) return { error: '路径越界', code: 403 }
  const spec = MEDIA_EXT[path.extname(full).toLowerCase()]
  if (!spec) return { error: '预览图格式不在白名单', code: 403 }
  try {
    const st = await fsp.stat(full)
    return { file: full, type: spec.type, size: st.size }
  } catch {
    return { error: '预览图不可读', code: 404 }
  }
}

/** 取场景壁纸内嵌的 MP4：首次提取写缓存文件，之后直接复用（支持 Range）。 */
async function resolveSceneVideo(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const info = await inspectWallpaperDir(root, id)
  if (!info || !info.scene || !info.pkg) return { error: '该壁纸不是可提取视频的场景壁纸', code: 404 }

  const dir = path.join(root, id)
  const pkgPath = path.resolve(dir, info.pkg)
  const rootAbs = path.resolve(root)
  if (!(pkgPath === rootAbs || pkgPath.startsWith(rootAbs + path.sep))) return { error: '路径越界', code: 403 }

  let st
  try {
    st = await fsp.stat(pkgPath)
  } catch {
    return { error: 'scene.pkg 不存在或不可读', code: 404 }
  }
  const key = 'scene-' + id + '-' + st.size + '-' + Math.round(st.mtimeMs) + '.mp4'
  const cached = path.join(SCENE_CACHE_DIR, key)
  if (existsSync(cached)) return { file: cached }

  try {
    await fsp.mkdir(SCENE_CACHE_DIR, { recursive: true })
  } catch {}
  let buf
  try {
    buf = await extractSceneVideoFromPkgFile(pkgPath)
  } catch (err) {
    return { error: '提取内嵌视频失败：' + (err && err.message), code: 500 }
  }
  if (!buf || !buf.byteLength) return { error: '场景包内没有可提取的内嵌视频', code: 404 }
  const tmp = cached + '.tmp'
  try {
    await fsp.writeFile(tmp, buf)
    await fsp.rename(tmp, cached)
  } catch (err) {
    return { error: '写入缓存失败：' + (err && err.message), code: 500 }
  }
  await pruneSceneCache().catch(() => {})
  return { file: cached, extracted: true }
}

/** 读一个壁纸目录，返回 { entry } 或 { unsupported, reason }。 */
async function inspectWallpaperDir(root, dirName) {
  const dir = path.join(root, dirName)
  let st
  try {
    st = await fsp.stat(dir)
  } catch {
    return null
  }
  if (!st.isDirectory()) return null

  let meta = {}
  const pj = path.join(dir, 'project.json')
  if (existsSync(pj)) {
    try {
      meta = JSON.parse(await fsp.readFile(pj, 'utf8')) || {}
    } catch {
      meta = {}
    }
  }
  const declared = typeof meta.file === 'string' ? meta.file : ''
  const kind = typeof meta.type === 'string' ? meta.type.toLowerCase() : ''
  const preview = typeof meta.preview === 'string' ? meta.preview : ''
  const title = typeof meta.title === 'string' && meta.title ? meta.title : dirName

  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    names = []
  }
  names.sort()
  const isPreviewName = (n) => /^preview\.(jpg|jpeg|png|gif)$/i.test(n)
  const hasPkg = names.some((n) => /\.pkg$/i.test(n))
  const hasSceneJson = names.some((n) => n.toLowerCase() === 'scene.json')
  const isScene = kind === 'scene' || hasPkg || hasSceneJson || /^scene\.(json|pkg)$/i.test(declared)

  /* 场景壁纸：只要有 scene.pkg 就交给 WebWallGL 渲染真实场景（图层/粒子/效果）。
     hasVideo 只作为「渲染器不可用时抽内嵌 MP4 兜底」的提示，不再是唯一出路。 */
  if (isScene) {
    const pkgName = names.find((n) => /\.pkg$/i.test(n))
    if (pkgName) {
      const hasVideo = await probeSceneCached(path.join(dir, pkgName))
      return {
        id: dirName,
        title,
        kind: 'scene',
        scene: true,
        pkg: pkgName,
        hasVideo,
        file: '',
        type: 'application/octet-stream',
        size: 0,
        preview: preview && MEDIA_EXT[path.extname(preview).toLowerCase()] ? preview : '',
        degraded: false,
        reason: hasVideo ? '' : '场景由 WebWallGL 实时渲染；渲染不可用时回退预览图',
      }
    }
  }

  /* 候选顺序：project.json 声明的文件 → 目录里的正经媒体 → 最后才轮到预览图。
     预览图只做「场景壁纸的降级静态帧」，不能顶替真正的视频壁纸。 */
  const candidates = []
  if (declared && !/\.pkg$/i.test(declared) && !/scene\.json$/i.test(declared) && !isPreviewName(path.basename(declared))) {
    candidates.push(declared)
  }
  for (const n of names) if (!isPreviewName(n)) candidates.push(n)
  if (!isScene) for (const n of names) if (isPreviewName(n)) candidates.push(n)
  if (isScene) {
    if (preview && names.includes(preview)) candidates.push(preview)
    for (const n of names) if (isPreviewName(n)) candidates.push(n)
  }

  for (const c of candidates) {
    const ext = path.extname(c).toLowerCase()
    const spec = MEDIA_EXT[ext]
    if (!spec) continue
    const full = path.join(dir, c)
    try {
      const s = await fsp.stat(full)
      if (!s.isFile() || s.size <= 0) continue
      const usedPreview = isPreviewName(c)
      return {
        id: dirName,
        title,
        kind: spec.kind,
        file: c,
        type: spec.type,
        size: s.size,
        preview: preview && MEDIA_EXT[path.extname(preview).toLowerCase()] ? preview : '',
        /* 场景壁纸：只拿得到预览图，动态场景本体（.pkg）解析不了。 */
        degraded: Boolean(isScene && usedPreview),
        reason: isScene && usedPreview ? '场景壁纸（scene.pkg）暂不支持，这里只播放预览图' : '',
      }
    } catch {
      continue
    }
  }

  if (isScene) {
    return { id: dirName, title, unsupported: true, reason: '场景壁纸（scene.pkg / scene.json）暂不支持，且目录内没有可用的预览图' }
  }
  return { id: dirName, title, unsupported: true, reason: '目录内没有 .mp4/.webm/.jpg/.png/.gif 媒体文件' }
}

async function listWallpapers() {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root) return { root: '', items: [], error: '尚未配置壁纸目录' }
  if (!existsSync(root)) return { root, items: [], error: '壁纸目录不存在：' + root }
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    return { root, items: [], error: '无法读取目录：' + (err && err.message) }
  }
  const items = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const info = await inspectWallpaperDir(root, e.name)
    if (info) items.push(info)
  }
  items.sort((a, b) => Number(Boolean(a.unsupported)) - Number(Boolean(b.unsupported)) || a.title.localeCompare(b.title))
  return { root, items }
}

/** 解析一次媒体请求：id 只能是 root 内的直接子目录，扩展名必须在白名单。 */
async function resolveMediaFile(id) {
  const cfg = readConfig()
  const root = cfg.wallpaperDir
  if (!root || !existsSync(root)) return { error: '壁纸目录未配置或不存在', code: 404 }
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { error: '非法的壁纸 id', code: 400 }
  }
  const dir = path.join(root, id)
  const info = await inspectWallpaperDir(root, id)
  if (!info || info.unsupported) return { error: info ? info.reason : '壁纸不存在', code: 404 }

  const full = path.resolve(dir, info.file)
  // 穿越防护：resolve 之后必须仍在 root 内，且中间段不能有 ..
  const rootAbs = path.resolve(root)
  if (!(full === rootAbs || full.startsWith(rootAbs + path.sep))) {
    return { error: '路径越界', code: 403 }
  }
  const ext = path.extname(full).toLowerCase()
  if (!MEDIA_EXT[ext]) return { error: '扩展名不在白名单', code: 403 }
  try {
    const real = await fsp.realpath(full)
    const realRoot = await fsp.realpath(rootAbs)
    if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return { error: '符号链接越界', code: 403 }
    return { file: real, type: MEDIA_EXT[ext].type, kind: MEDIA_EXT[ext].kind, size: statSync(real).size }
  } catch (err) {
    return { error: '文件不可读：' + (err && err.message), code: 404 }
  }
}

/** 本地文件流式响应，支持 HTTP Range（视频循环/拖动必需）。 */
function sendFileRange(req, res, file, type, size) {
  const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': String(size) })
    if (req.method === 'HEAD') return res.end()
    const s = createReadStream(file)
    s.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    return s.pipe(res)
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  let start = m[1] === '' ? NaN : Number(m[1])
  let end = m[2] === '' ? size - 1 : Number(m[2])
  if (m[1] === '') {
    // 后缀范围：bytes=-N
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  end = Math.min(end, size - 1)
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(end - start + 1),
  })
  if (req.method === 'HEAD') return res.end()
  const s = createReadStream(file, { start, end })
  s.on('error', () => {
    try {
      res.destroy()
    } catch {}
  })
  s.pipe(res)
}

/* ------------------------------------------------- 本机网易云登录态（可选） */

const NETease_COOKIES = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Netease',
  'CloudMusic',
  'webapp91x64',
  'Cookies',
)

/** DPAPI 解 Chromium v10 cookie（当前用户上下文，不弹 UAC）。 */
function dpapiDecrypt(b64) {
  return new Promise((resolve) => {
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security | Out-Null',
      `$b=[Convert]::FromBase64String('${b64}')`,
      "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
      '[Convert]::ToBase64String($p)',
    ].join('; ')
    const child = spawn(
      process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const s = out.trim()
      if (!s) return resolve(null)
      try {
        resolve(Buffer.from(s, 'base64'))
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * 从本机网易云客户端读 MUSIC_U。
 * 只在用户显式点「导入」时调用；结果写进本机配置，不回传完整值。
 */
async function importNeteaseCookie() {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows 本机网易云客户端' }
  if (!existsSync(NETease_COOKIES)) return { ok: false, error: '未找到网易云客户端 Cookie 文件：' + NETease_COOKIES }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return { ok: false, error: '当前 Node 不支持 node:sqlite，无法自动读取；请手动粘贴 Cookie' }
  }
  // 客户端运行时该库被占用：复制一份只读副本
  const tmp = path.join(os.tmpdir(), 'dsh-nf-cookies-' + process.pid + '.db')
  try {
    await fsp.copyFile(NETease_COOKIES, tmp)
  } catch (err) {
    return { ok: false, error: '复制 Cookie 库失败：' + (err && err.message) }
  }
  try {
    const db = new DatabaseSync(tmp, { readOnly: true })
    const rows = db.prepare("SELECT name, encrypted_value FROM cookies WHERE name='MUSIC_U' ORDER BY expires_utc DESC").all()
    db.close()
    if (!rows.length) return { ok: false, error: 'Cookie 库中没有 MUSIC_U（网易云客户端未登录）' }
    for (const row of rows) {
      const buf = Buffer.from(row.encrypted_value)
      if (buf.length <= 3) continue
      const prefix = buf.subarray(0, 3).toString('latin1')
      if (prefix !== 'v10' && prefix !== 'v11') continue
      const plain = await dpapiDecrypt(buf.subarray(3).toString('base64'))
      if (!plain) continue
      const value = plain.toString('utf8')
      if (!value) continue
      const cookie = `MUSIC_U=${value}`
      await writeConfig({ cookie })
      return { ok: true, hasMusicU: true, tail: value.slice(-4) }
    }
    return { ok: false, error: 'MUSIC_U 存在但解密失败（v20 加密或权限不足）；请手动粘贴 Cookie' }
  } catch (err) {
    return { ok: false, error: '读取 Cookie 库失败：' + (err && err.message) }
  } finally {
    fsp.unlink(tmp).catch(() => {})
  }
}

/* ---------------------------------------------------------------- 插件 */

function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (viaGet) return viaGet
  } catch {}
  return ctx.webServer
}

function apply(ctx) {
  const disposers = []
  const webServer = resolveWebServer(ctx)

  if (!webServer || typeof webServer.register !== 'function') {
    try {
      ctx.logger?.warn?.('[' + NAME + '] 当前 profile 没有 webServer，Host 半侧跳过；小窗无法加载媒体')
    } catch {}
    return
  }

  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  /**
   * 注册路由。媒体类路径（音频/壁纸/渲染器脚本）由浏览器原生发起，
   * 带不上 DSH 的 cookie，因此用 MEDIA_TOKEN 校验而不是走 cookie 信任栅栏。
   */
  const MEDIA_PATH_RE = /^\/(api\/audio|api\/wallpaper-media|api\/scene-video|api\/wallpaper-preview|api\/webwallgl\.js|api\/nm\/playlists|api\/nm\/playlist)$/
  function route(p, handler) {
    const media = MEDIA_PATH_RE.test(p)
    const d = webServer.register({
      kind: 'exact',
      path: BASE + p,
      handler: async (req, res) => {
        if (media) {
          let mt = ''
          try {
            mt = new URL(req.url, 'http://127.0.0.1').searchParams.get('mt') || ''
          } catch {}
          if (mt !== MEDIA_TOKEN) {
            sendJson(res, 403, { ok: false, error: 'media token required' })
            return
          }
        } else if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          else {
            try {
              res.destroy()
            } catch {}
          }
        }
      },
    })
    disposers.push(d)
  }

  /* 真实 HTTP 基址：桌面端页面跑在 dsh-app://app 下，那层协议转发会扣掉
     content-length，音频因此拿不到总长度、seekable 塌缩成"只能拖已缓冲段"。
     客户端拿到这个 origin 后改用绝对 http:// 地址播音频，绕开转发。 */
  route('/api/http-base', async (req, res) => {
    let origin = ''
    try {
      if (typeof webServer.getOrigin === 'function') origin = webServer.getOrigin()
    } catch {}
    if (!origin) {
      const host = String(req.headers.host || '')
      if (/^[A-Za-z0-9.\-:[\]]+$/.test(host)) origin = 'http://' + host
    }
    sendJson(res, 200, { ok: true, origin, mediaToken: MEDIA_TOKEN })
  })

  route('/api/config', async (req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    if (method === 'GET') {
      const cfg = readConfig()
      return sendJson(res, 200, {
        ok: true,
        config: { ...cfg, cookie: '' },
        cookie: maskCookie(cfg.cookie),
        file: CONFIG_FILE,
      })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const text = await readBody(req)
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' })
    }
    try {
      const saved = await writeConfig(payload && typeof payload === 'object' ? payload : {})
      return sendJson(res, 200, {
        ok: true,
        config: { ...saved, cookie: '' },
        cookie: maskCookie(saved.cookie),
      })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
    }
  })

  route('/api/search', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const q = (u.searchParams.get('q') || '').trim()
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 20, 1), 50)
    const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0)
    if (!q) return sendJson(res, 400, { ok: false, error: 'q required' })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    const target =
      'https://music.163.com/api/cloudsearch/pc?type=1&s=' +
      encodeURIComponent(q) +
      '&limit=' +
      limit +
      '&offset=' +
      offset
    try {
      const r = await fetch(target, { headers })
      const j = await r.json()
      const songs = ((j && j.result && j.result.songs) || []).map((s) => ({
        id: s.id,
        name: s.name,
        artist: ((s.ar || []).map((a) => a.name).join(' / ')) || '',
        album: (s.al && s.al.name) || '',
        duration: s.dt || 0,
        fee: s.fee,
      }))
      sendJson(res, 200, { ok: true, songs, count: (j.result && j.result.songCount) || songs.length })
    } catch (err) {
      sendJson(res, 502, { ok: false, error: 'search failed: ' + (err && err.message) })
    }
  })

  route('/api/lyric', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    try {
      const r = await fetch(
        `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`,
        { headers },
      )
      const j = await r.json()
      sendJson(res, 200, {
        ok: true,
        lrc: (j && j.lrc && j.lrc.lyric) || '',
        tlyric: (j && j.tlyric && j.tlyric.lyric) || '',
      })
    } catch (err) {
      sendJson(res, 502, { ok: false, error: 'lyric failed: ' + (err && err.message) })
    }
  })

  /* 账号里的歌单列表（含「我喜欢的音乐」，specialType=5）。
     走媒体令牌通道：桌面端这层请求不带不上的 cookie 会被栅栏挡成空 body。 */
  route('/api/nm/playlists', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const acc = await nmAccount()
    if (acc.error) return sendJson(res, 400, { ok: false, error: acc.error })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    try {
      const r = await fetch(
        'https://music.163.com/api/user/playlist?uid=' + acc.uid + '&limit=100&offset=0',
        { headers },
      )
      const j = await r.json()
      const items = (j.playlist || [])
        .filter((p) => p && p.id)
        .map((p) => ({
          id: p.id,
          name: String(p.name || '').slice(0, 80),
          trackCount: Number(p.trackCount) || 0,
          creator: (p.creator && p.creator.nickname) || '',
          special: p.specialType === 5,
        }))
      return sendJson(res, 200, { ok: true, uid: acc.uid, nickname: acc.nickname, items })
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: '读取歌单失败：' + ((err && err.message) || err) })
    }
  })

  /* 某个歌单的全部歌曲。`/api/playlist/detail` 的 tracks 就是全量，不用 weapi 加密。 */
  route('/api/nm/playlist', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = String(u.searchParams.get('id') || '').trim()
    if (!/^\d{1,20}$/.test(id)) return sendJson(res, 400, { ok: false, error: '歌单 id 无效' })
    const cfg = readConfig()
    const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    if (cfg.cookie) headers.Cookie = cfg.cookie
    try {
      const r = await fetch('https://music.163.com/api/playlist/detail?id=' + id, { headers })
      const j = await r.json()
      const p = (j && (j.playlist || j.result)) || null
      if (!p) return sendJson(res, 404, { ok: false, error: '歌单不存在或无权访问' })
      const songs = (p.tracks || []).map(songFromTrack).filter(Boolean)
      return sendJson(res, 200, {
        ok: true,
        id: Number(id),
        name: String(p.name || '').slice(0, 80),
        total: Number(p.trackCount) || songs.length,
        songs,
      })
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: '读取歌单歌曲失败：' + ((err && err.message) || err) })
    }
  })

  /* 播放地址：直接给客户端网易云 CDN 的 https 直链。
     `<audio>` 跨域播放不需要认证/CORS，比走自家代理稳（代理会被 DSH 信任栅栏拦成 401）。
     这也是 ncm-player 的做法：拿到 url 就交给 audio 元素，不再自己转发字节。 */
  route('/api/song-url', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
    const url = await resolveAudioUrl(id)
    if (!url) {
      return sendJson(res, 404, {
        ok: false,
        error: '取不到播放地址（版权受限或需要登录）。可在设置里配置网易云 Cookie 后重试。',
      })
    }
    /* 页面是 secure context，http 媒体会被当混合内容拦掉，统一升 https */
    const httpsUrl = url.replace(/^http:\/\//i, 'https://')
    sendJson(res, 200, { ok: true, url: httpsUrl })
  })

  route('/api/audio', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
    const url = await resolveAudioUrl(id)
    if (!url) {
      return sendJson(res, 404, {
        ok: false,
        error: '无法获取播放地址（可能版权受限/需要登录）。可在设置里导入网易云 Cookie 后重试。',
      })
    }
    // 同源代理：浏览器只与本机 /api/audio 打交道，不直连 163，避免 CORS 与凭据外泄
    await proxyAudio(req, res, url)
  })

  route('/api/wallpapers', async (req, res) => {
    const out = await listWallpapers()
    sendJson(res, 200, { ok: true, ...out })
  })

  route('/api/wallpaper-media', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const id = u.searchParams.get('id') || ''
    const m = await resolveMediaFile(id)
    if (m.error) return sendJson(res, m.code, { ok: false, error: m.error })
    sendFileRange(req, res, m.file, m.type, m.size)
  })

  /* 场景壁纸：第一次请求时从 scene.pkg 抽出内嵌 MP4 并写缓存，之后按 Range 正常出流。 */
  route('/api/scene-video', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const r = await resolveSceneVideo(u.searchParams.get('id') || '')
    if (r.error) return sendJson(res, r.code, { ok: false, error: r.error })
    let st
    try {
      st = statSync(r.file)
    } catch {
      return sendJson(res, 404, { ok: false, error: '缓存文件不可读' })
    }
    sendFileRange(req, res, r.file, 'video/mp4', st.size)
  })

  /* WebWallGL 场景渲染器脚本：随包分发，客户端首次用到场景壁纸时才拉。 */
  route('/api/webwallgl.js', async (req, res) => {
    let st
    try {
      st = statSync(WEBWALLGL_FILE)
    } catch {
      return sendJson(res, 404, { ok: false, error: 'webwallgl 未随包分发' })
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': String(st.size),
      'Cache-Control': 'public, max-age=86400',
    })
    if (req.method === 'HEAD') return res.end()
    const s = createReadStream(WEBWALLGL_FILE)
    s.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    s.pipe(res)
  })

  /* 场景壁纸的原始 scene.pkg：渲染器自己解析，一次拉全量。 */
  route('/api/scene-pkg', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const info = await resolveScenePkg(u.searchParams.get('id') || '')
    if (info.error) return sendJson(res, info.code, { ok: false, error: info.error })
    sendFileRange(req, res, info.file, 'application/octet-stream', info.size)
  })

  /* 场景壁纸的 project.json（缺失时返回 null，渲染器自行回退）。 */
  route('/api/project-json', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const info = await resolveScenePkg(u.searchParams.get('id') || '')
    if (info.error) return sendJson(res, info.code, { ok: false, error: info.error })
    let raw = 'null'
    try {
      raw = await fsp.readFile(path.join(info.dir, 'project.json'), 'utf8')
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(raw)
  })

  /* 场景壁纸预览图：渲染器加载期间的占位，渲染失败时兜底。 */
  route('/api/wallpaper-preview', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const m = await resolvePreviewFile(u.searchParams.get('id') || '')
    if (m.error) return sendJson(res, m.code, { ok: false, error: m.error })
    sendFileRange(req, res, m.file, m.type, m.size)
  })

  route('/api/netease-cookie', async (req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    if (method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        clientCookieFile: NETease_COOKIES,
        clientCookieFound: existsSync(NETease_COOKIES),
        configured: maskCookie(readConfig().cookie),
      })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const result = await importNeteaseCookie()
    sendJson(res, result.ok ? 200 : 400, result)
  })

  try {
    ctx.logger?.info?.('[' + NAME + '] routes ready: ' + BASE + '/api/{config,search,lyric,audio,wallpapers,wallpaper-media,netease-cookie}')
  } catch {}

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
  })
}

const inject = ['webServer', 'connection']

export { apply, inject, NAME as name }
