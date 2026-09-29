/**
 * dsh-archive-cleaner 自测：不依赖真实 harness —— 用假 ctx + 临时 DSH_HOME 跑完整删除链路。
 *
 * 运行：node --test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../index.js')

const ID = 'session-11111111-2222-3333-4444-555555555555'
const NAMESPACE = '--D-Example--'
const LOG = 'session.v4.jsonl.zstd'

/** 造一个临时 DSH_HOME：一条会话日志 + 它的投影缓存。 */
async function makeHome({ files = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-archive-cleaner-'))
  const root = join(home, 'sessions')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  if (files) {
    await mkdir(join(root, NAMESPACE, ID), { recursive: true })
    await writeFile(join(root, NAMESPACE, ID, LOG), 'log-bytes')
    await writeFile(join(cacheDir, `${ID}.json`), '{}')
  } else {
    await mkdir(root, { recursive: true })
  }
  return { home, root, cachePath: join(cacheDir, `${ID}.json`), sessionDir: join(root, NAMESPACE, ID) }
}

/**
 * 假 ctx 也必须像 cordis 一样较真：**没 inject 的 service 属性一旦被读就抛异常**。
 * 这里曾经太宽松（任意属性都能读），漏掉了真 bug —— 插件读 ctx.sessionPersistence 却没把它
 * 写进 inject，运行时直接 500，界面上只显示「删除失败」。加了这层 Proxy 后同类错误跑测试就会红。
 */
function strictCtx(raw) {
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        throw new Error('cannot get property "' + property + '" without inject')
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

/** 假宿主上下文：只实现插件真正用到的那几个面。 */
function makeCtx(root, { archived = [ID], accounted = [ID] } = {}) {
  const state = { archived: [...archived] }
  const workspaces = [{ path: 'D:\\Example', sessionIds: [...accounted] }]
  const registered = {}
  const ctx = {
    effect: (fn) => {
      const produced = fn()
      if (produced !== undefined && produced !== null && typeof produced.next === 'function') {
        let step = produced.next()
        while (!step.done) step = produced.next()
      }
    },
    emit: () => {},
    logger: { warn: () => {} },
    get: () => undefined,
    sessionPersistence: { root },
    commands: {
      register: (definition) => {
        registered.command = definition
        return () => {}
      },
    },
    webServer: {
      register: (route) => {
        registered.route = route
        return () => {}
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return state.archived
      },
      unarchiveSession: async (id) => {
        state.archived = state.archived.filter((value) => value !== id)
      },
      list: () =>
        workspaces.map((workspace) => ({
          sessionIds: workspace.sessionIds,
          detachSession: async (id) => {
            workspace.sessionIds = workspace.sessionIds.filter((value) => value !== id)
          },
        })),
    },
  }
  return { ctx: strictCtx(ctx), registered, state, workspaces }
}

function signal() {
  return new AbortController().signal
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
    },
  }
}

function fakeRequest(method, url, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 在临时 DSH_HOME 下跑一段逻辑，结束后还原环境变量并清理。 */
async function withHome(home, run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    // 只读属性会让 Windows 的 rm 报 EPERM，清理失败不该再把测试搞红。
    await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

test('导出与注入的服务', () => {
  assert.equal(plugin.name, 'archive-cleaner')
  assert.deepEqual(plugin.inject, ['commands', 'workspaceRegistry', 'webServer', 'sessionPersistence'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 会注册 /purge-archived 命令与 HTTP 路由', async () => {
  const { home, root } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    assert.equal(registered.command.name, 'purge-archived')
    assert.equal(typeof registered.command.handler, 'function')
    assert.equal(typeof registered.route.handler, 'function')
    assert.equal(registered.route.kind, 'prefix')
  })
})

test('命令：删掉日志与投影缓存，并清空归档集合与工作区条目', async () => {
  const { home, root, cachePath, sessionDir } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const result = await registered.command.handler({ rawInput: '', signal: signal(), agent: {} })
    assert.equal(result.kind, 'success')
    assert.equal(await exists(sessionDir), false, '会话日志目录已删除')
    assert.equal(await exists(cachePath), false, '投影缓存已删除')
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [], '归档集合已清空')
    assert.deepEqual(ctx.workspaceRegistry.list()[0].sessionIds, [], '工作区条目已摘除')
    assert.match(result.text, /已删除 1 \/ 1/)
  })
})

test('命令：list 只列出，不动文件', async () => {
  const { home, root, cachePath, sessionDir } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const result = await registered.command.handler({ rawInput: 'list', signal: signal(), agent: {} })
    assert.equal(result.kind, 'success')
    assert.match(result.text, new RegExp(ID))
    assert.equal(await exists(sessionDir), true)
    assert.equal(await exists(cachePath), true)
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [ID])
  })
})

test('命令：没有归档会话时直接返回', async () => {
  const { home, root } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root, { archived: [], accounted: [] })
    plugin.apply(ctx)
    const result = await registered.command.handler({ rawInput: '', signal: signal(), agent: {} })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /没有已归档的会话/)
  })
})

test('命令：日志已经不在（幽灵条目）时照样清干净登记信息', async () => {
  const { home, root } = await makeHome({ files: false })
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const result = await registered.command.handler({ rawInput: '', signal: signal(), agent: {} })
    assert.equal(result.kind, 'success')
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
    assert.deepEqual(ctx.workspaceRegistry.list()[0].sessionIds, [])
  })
})

test('命令：文件删不掉时保留归档态，不产生「取消归档但文件还在」的半成品', async (t) => {
  const { home, root, sessionDir } = await makeHome()
  await withHome(home, async () => {
    // Windows 上给文件加只读属性会让 rm 报 EPERM；其他平台若照样删得掉就跳过这条断言。
    await chmod(join(sessionDir, LOG), 0o444)
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const result = await registered.command.handler({ rawInput: '', signal: signal(), agent: {} })
    if (!(await exists(sessionDir))) {
      t.diagnostic('该平台上只读文件仍可删除，跳过失败分支断言')
      return
    }
    assert.equal(result.kind, 'error')
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [ID], '归档态原样保留')
    assert.deepEqual(ctx.workspaceRegistry.list()[0].sessionIds, [ID], '工作区条目原样保留')
    // 恢复属性，让临时目录能被清掉。
    await chmod(join(sessionDir, LOG), 0o644).catch(() => {})
  })
})

test('HTTP：POST /archive-cleaner/api/delete 删掉指定会话', async () => {
  const { home, root, cachePath, sessionDir } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const res = fakeResponse()
    await registered.route.handler(fakeRequest('POST', '/archive-cleaner/api/delete', { sessionId: ID }), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(await exists(sessionDir), false)
    assert.equal(await exists(cachePath), false)
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
  })
})

test('HTTP：未归档的 id 返回 409，缺 sessionId 返回 400，未知路径 404', async () => {
  const { home, root } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root, { archived: [], accounted: [] })
    plugin.apply(ctx)

    const conflict = fakeResponse()
    await registered.route.handler(fakeRequest('POST', '/archive-cleaner/api/delete', { sessionId: ID }), conflict)
    assert.equal(conflict.status, 409)

    const bad = fakeResponse()
    await registered.route.handler(fakeRequest('POST', '/archive-cleaner/api/delete', {}), bad)
    assert.equal(bad.status, 400)

    const missing = fakeResponse()
    await registered.route.handler(fakeRequest('GET', '/archive-cleaner/api/nope'), missing)
    assert.equal(missing.status, 404)
  })
})

test('HTTP：GET /archive-cleaner/api/archived 回归档 id', async () => {
  const { home, root } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const res = fakeResponse()
    await registered.route.handler(fakeRequest('GET', '/archive-cleaner/api/archived'), res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).sessionIds, [ID])
  })
})

test('HTTP：图标路由返回 PNG 且禁缓存', async () => {
  const { home, root } = await makeHome()
  await withHome(home, async () => {
    const { ctx, registered } = makeCtx(root)
    plugin.apply(ctx)
    const res = fakeResponse()
    await registered.route.handler(fakeRequest('GET', '/archive-cleaner/api/icon.png'), res)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'image/png')
    assert.match(String(res.headers['cache-control']), /no-store/)
  })
})
