/**
 * dsh-archive-cleaner —— 让「已归档会话」从 Web 界面里彻底消失。
 *
 * 宿主只有「归档 / 取消归档」：日志文件永远留在磁盘上，而侧栏的「未分组」区域会把
 * 任何不属于工作区的会话继续列出来，所以只取消归档反而是把行换个地方显示。
 * 本插件补上真正缺的那一步 —— 把日志删掉：
 *
 *   - `/purge-archived` 命令：一次清掉全部已归档会话（`list` 只列不删）；
 *   - `POST /archive-cleaner/api/delete`：删单个（侧栏「...」菜单里的「删除会话」走这条）；
 *   - `GET  /archive-cleaner/api/archived`：当前归档 id 列表；
 *   - `GET  /archive-cleaner/api/diagnose`：路径/根目录诊断（排障用）；
 *   - `GET  /archive-cleaner/api/icon.png`：菜单项用的图标。
 *
 * 删除顺序很关键：**先删文件，再动归档集合**。文件删不掉（Windows 上被宿主句柄占用）
 * 就直接报错并原样保留归档状态——绝不出现「取消归档了但文件还在」这种半成品，
 * 那正是把行丢进「未分组」的原因。
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'archive-cleaner'

/** 依赖的宿主服务。 */
export const inject = ['commands', 'workspaceRegistry', 'webServer', 'sessionPersistence']

/** 客户端走的 HTTP 前缀。 */
const API_PREFIX = '/archive-cleaner/api'

const USAGE = '用法：/purge-archived（直接删）或 /purge-archived list（只看不删）'

/** 解析 DSH 数据根：$DSH_HOME 优先，否则 ~/.dsh（与 dsh-home-paths 规则一致）。 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** 会话日志根目录候选：宿主 persistence 自己的 root 最准，其余是兜底。 */
function sessionRoots(ctx) {
  const roots = []
  // cordis 里没 inject 的 service 属性是「抛异常」而不是 undefined，?. 拦不住，必须 try。
  try {
    const persistenceRoot = ctx.sessionPersistence.root
    if (typeof persistenceRoot === 'string' && persistenceRoot.length > 0) roots.push(persistenceRoot)
  } catch {
    /* 没拿到宿主 persistence 就退回默认根 */
  }
  roots.push(join(dshHome(), 'sessions'))
  return [...new Set(roots)]
}

/** 投影缓存文件候选路径。 */
function projectionCachePaths(sessionId) {
  return [join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)]
}

/** 错误码人类可读化。 */
function why(error) {
  return String(error?.code ?? error?.message ?? error)
}

/** 递归找出目录名正好等于 sessionId 的目录：会话目录名就是会话 id。 */
async function findSessionDirs(root, sessionId, found = []) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    if (entry.name === sessionId) {
      found.push(full)
      continue
    }
    await findSessionDirs(full, sessionId, found)
  }
  return found
}

/** 存在性检查（不抛）。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 删除失败就退避重试：Windows 上宿主可能正好开着句柄，稍等就能删。 */
async function removeWithRetry(target, attempts = 6) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt))
    }
  }
  throw lastError
}

/** 删一个会话的全部落盘痕迹。返回 { removed, failures }，不抛。 */
async function purgeFiles(ctx, sessionId) {
  const removed = []
  const failures = []
  const targets = []
  for (const root of sessionRoots(ctx)) targets.push(...(await findSessionDirs(root, sessionId)))
  for (const cache of projectionCachePaths(sessionId)) if (await exists(cache)) targets.push(cache)
  for (const target of targets) {
    try {
      await removeWithRetry(target)
      removed.push(target)
    } catch (error) {
      failures.push(`${target}（${why(error)}）`)
    }
  }
  return { removed, failures }
}

/**
 * 删一个已归档会话：先删文件，成功后才解除归档 / 摘除工作区条目 / 通知界面。
 * 文件删不干净就抛错，且**不碰**归档集合，保证不会把行丢进「未分组」。
 */
async function deleteArchivedSession(ctx, sessionId) {
  const { removed, failures } = await purgeFiles(ctx, sessionId)
  if (failures.length > 0) throw new Error(`日志文件删不掉（多半被宿主占用，稍后重试或重启 dsh 再删）：${failures.join('；')}`)
  const registry = ctx.workspaceRegistry
  if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId)
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
  }
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    /* 界面刷新不是清理的必要条件 */
  }
  return removed
}

/** 执行一次「清空归档」命令。 */
async function purgeArchived(ctx, invocation) {
  const archived = [...ctx.workspaceRegistry.archivedSessionIds]
  const argument = invocation.rawInput.trim()

  if (archived.length === 0) return { kind: 'success', text: '没有已归档的会话，无需清理。' }

  if (argument === 'list') {
    return {
      kind: 'success',
      text: `已归档会话 ${archived.length} 个：\n${archived.map((id) => `- ${id}`).join('\n')}\n\n执行 /purge-archived 即永久删除它们。`,
    }
  }
  if (argument.length > 0) return { kind: 'error', text: USAGE }

  const lines = []
  let deleted = 0
  for (const sessionId of archived) {
    if (invocation.signal.aborted) {
      return { kind: 'error', text: `已中止。已删除 ${deleted} 个，剩余 ${archived.length - deleted} 个仍保留。` }
    }
    try {
      const removed = await deleteArchivedSession(ctx, sessionId)
      deleted += 1
      lines.push(`✓ ${sessionId}（删除 ${removed.length} 个路径）`)
    } catch (error) {
      lines.push(`✗ ${sessionId}：${String(error?.message ?? error)}`)
    }
  }
  const leftover = [...ctx.workspaceRegistry.archivedSessionIds]
  const tail = leftover.length > 0 ? `\n未删掉的仍在归档区（保持隐藏）：${leftover.join(', ')}` : ''
  return {
    kind: lines.some((line) => line.startsWith('✗')) ? 'error' : 'success',
    text: `已删除 ${deleted} / ${archived.length} 个已归档会话：\n${lines.join('\n')}${tail}`,
  }
}

/** 读一个 JSON 请求体，超过上限直接失败。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 菜单图标（宿主半边持有文件，客户端只引用 URL）。 */
async function serveIcon(res) {
  try {
    const bytes = await readFile(new URL('./icon.png', import.meta.url))
    // 绝不缓存：图标是随时会被换掉的本地文件，浏览器缓存过一次就永远看不到新的。
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      expires: '0',
    })
    res.end(bytes)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `icon unavailable: ${why(error)}` })
  }
}

/** `/archive-cleaner/api` 前缀路由。 */
async function handleApi(ctx, req, res) {
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  try {
    if (pathname === `${API_PREFIX}/icon.png`) return await serveIcon(res)

    if (pathname === `${API_PREFIX}/archived`) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return sendJson(res, 200, { ok: true, sessionIds: [...ctx.workspaceRegistry.archivedSessionIds] })
    }

    if (pathname === `${API_PREFIX}/delete`) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: 'sessionId is required' })
      if (!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
        return sendJson(res, 409, { ok: false, error: '该会话不在归档区（可能已经被删或被取消归档）' })
      }
      const removed = await deleteArchivedSession(ctx, sessionId)
      return sendJson(res, 200, { ok: true, sessionId, removed })
    }

    if (pathname === `${API_PREFIX}/diagnose`) {
      const readRoot = async (dir) => {
        try {
          return (await readdir(dir, { withFileTypes: true })).map((entry) => entry.name)
        } catch (error) {
          return `ERROR ${why(error)}`
        }
      }
      let persistenceKeys = []
      let stringFields = {}
      try {
        const persistence = ctx.sessionPersistence
        persistenceKeys = Object.keys(persistence)
        for (const [key, value] of Object.entries(persistence)) if (typeof value === 'string') stringFields[key] = value
      } catch (error) {
        stringFields = { error: why(error) }
      }
      const found = {}
      for (const id of [...ctx.workspaceRegistry.archivedSessionIds]) {
        found[id] = []
        for (const root of sessionRoots(ctx)) found[id].push(...(await findSessionDirs(root, id)))
      }
      const modules = typeof ctx.get === "function" ? ctx.get("clientModules") : undefined
      const clientModule = modules !== undefined && modules !== null && modules.table instanceof Map
        ? modules.table.has("dsh-archive-cleaner")
        : "clientModules service unavailable"
      return sendJson(res, 200, {
        ok: true,
        clientModuleRegistered: clientModule,
        envDshHome: process.env.DSH_HOME ?? null,
        homedir: homedir(),
        resolvedHome: dshHome(),
        sessionRoots: sessionRoots(ctx),
        rootsListing: Object.fromEntries(await Promise.all(sessionRoots(ctx).map(async (root) => [root, await readRoot(root)]))),
        persistenceKeys,
        persistenceStringFields: stringFields,
        archived: [...ctx.workspaceRegistry.archivedSessionIds],
        foundDirs: found,
      })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown archive-cleaner API path' })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * 注册 `/purge-archived` 命令与客户端调用用的 HTTP 路由。
 * @param ctx - 携带 commands、workspaceRegistry、webServer 的宿主上下文。
 */
export function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'purge-archived',
      description: '永久删除所有已归档会话（删日志文件，让它们从侧栏彻底消失）',
      input: { hint: 'list = 只列出，不删除' },
      handler: (invocation) => purgeArchived(ctx, invocation),
    })
  }, 'archive-cleaner command')

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => handleApi(ctx, req, res),
      })
    } catch (error) {
      ctx.logger?.warn?.(`archive-cleaner: HTTP route registration failed: ${why(error)}`)
      return undefined
    }
  }, 'archive-cleaner HTTP route')
}
