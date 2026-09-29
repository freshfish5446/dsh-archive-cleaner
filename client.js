/**
 * dsh-archive-cleaner —— 客户端半边。
 *
 * 在侧栏工作区会话行的「三个点」菜单里插一行「删除会话」，排在宿主的
 * pin(100)/重命名(200)/分叉(300)/取消归档(400) 之后（order 500），只在已归档的行上出现。
 *
 * 刻意不用 window.confirm / window.alert：这套 Web GUI 里原生对话框可能被环境吞掉，
 * 那样点了等于没点。改成「菜单内二次确认」：第一次点变「再点一次确认删除」，
 * 第二次才真删；失败就把原因直接写在菜单行里，同时打 console。
 *
 * 这是第三方 dsh.client bundle 格式（与 dsh-meme 同款 __ModuleLoader__ 工厂）：
 * 注册 id 必须等于 loader entry 名 = 包名 dsh-archive-cleaner。
 */
window.__ModuleLoader__.load({
  id: 'dsh-archive-cleaner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // 菜单行尽量贴合宿主样式；拿不到 ui-primitives 就退回朴素按钮。
    let MenuItemButton
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives && typeof primitives.MenuItemButton === 'function') MenuItemButton = primitives.MenuItemButton
    } catch {
      MenuItemButton = undefined
    }

    const IDLE_LABEL = '删除会话'
    const CONFIRM_LABEL = '再点一次确认删除'
    const WORKING_LABEL = '正在删除…'
    const FAILED_LABEL = '删除失败，再点重试'
    const DELETE_URL = '/archive-cleaner/api/delete'
    // 带版本参数：换图标时把 v 往上加一位，浏览器缓存就绕开了。
    const ICON_URL = '/archive-cleaner/api/icon.png?v=3'
    const LABEL_COLOR = '#EA322F'
    const ICON_SIZE = 18

    /** 菜单项图标。 */
    function icon() {
      return React.createElement('img', {
        src: ICON_URL,
        width: ICON_SIZE,
        height: ICON_SIZE,
        alt: '',
        style: { display: 'block', objectFit: 'contain' },
      })
    }

    /** 文案统一染成 #EA322F（与图标同色）。 */
    function colorLabel(text) {
      return React.createElement('span', { style: { color: LABEL_COLOR } }, text)
    }

    /** 三个点菜单里的一行，仅对已归档会话显示；二次确认后删掉它。 */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, useWorkspaces } = props
      const [, setMenuOpen] = useMenuOpenState()
      const archived = typeof useWorkspaces === 'function'
        ? useWorkspaces((state) => Array.isArray(state && state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId))
        : false
      const [phase, setPhase] = React.useState('idle')
      const [detail, setDetail] = React.useState('')

      if (!archived) return null

      const onSelect = () => {
        if (phase === 'working') return
        if (phase === 'idle') {
          setPhase('confirm')
          return
        }
        if (phase === 'confirm') {
          setPhase('working')
          const title = displayTitle && displayTitle.length > 0 ? displayTitle : sessionId
          fetch(DELETE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
            .then(async (response) => {
              let payload = null
              try {
                payload = await response.json()
              } catch {
                payload = null
              }
              if (!response.ok || payload === null || payload.ok !== true) {
                const reason = payload && payload.error ? payload.error : 'HTTP ' + response.status
                throw new Error(reason)
              }
              console.info('[archive-cleaner] 已删除会话', title, payload.removed)
              setMenuOpen(false)
            })
            .catch((error) => {
              const reason = String((error && error.message) || error)
              console.error('[archive-cleaner] 删除会话失败:', reason)
              setDetail(reason)
              setPhase('failed')
            })
          return
        }
        // 上次失败：再来一轮确认。
        setDetail('')
        setPhase('confirm')
      }

      const label = phase === 'confirm' ? CONFIRM_LABEL : phase === 'working' ? WORKING_LABEL : phase === 'failed' ? FAILED_LABEL : IDLE_LABEL
      const text = phase === 'failed' && detail.length > 0 ? label + ' — ' + detail : label

      if (typeof MenuItemButton === 'function') {
        return React.createElement(MenuItemButton, { icon: icon(), onSelect }, colorLabel(text))
      }
      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick: onSelect,
          onMouseEnter: (event) => { event.currentTarget.style.background = 'rgba(128,128,128,0.15)' },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          },
        },
        icon(),
        colorLabel(text),
      )
    }

    /** 注册菜单行。 */
    function apply(ctx) {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots
      if (slots === undefined || slots === null) {
        console.warn('dsh-archive-cleaner: slots 服务不可用，删除会话菜单项未注册')
        return
      }
      console.info('[archive-cleaner] 客户端已加载，注册「删除会话」菜单项')
      slots.inject('sidebar.workspaces.session.menu.item', () =>
        slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'archive-cleaner-delete', order: 500 },
          DeleteSessionMenuItem,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
