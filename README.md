# dsh-archive-cleaner

DeepSeek Harness doesn't have a delete feature yet — this plugin gives you one, so you can permanently remove the archived sessions you no longer need.

> 官方目前没有「删除会话」的功能：只能归档，而归档只是把它藏起来，日志文件永远留在磁盘上。
> 本插件补上这个删除——把不需要的已归档会话彻底移除，侧栏和磁盘一起干净。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。宿主自带的能力只到「归档 / 取消归档」；
侧栏还会把任何**不属于工作区**的会话继续列进「未分组」，所以单纯取消归档不是删除，只是把那行换了个地方显示。

---

## 它做什么

| 入口 | 说明 |
| --- | --- |
| 侧栏会话行 →「...」菜单 → **删除会话**（红字 `#EA322F` + 图标，排在「取消归档」之后） | 只对已归档的行出现；**二次确认**（第一次点变「再点一次确认删除」）后真删 |
| 命令 **`/purge-archived`** | 一次删掉所有已归档会话 |
| 命令 **`/purge-archived list`** | 只列出，不删 |

删一个已归档会话 = 按顺序做四件事：

1. 删除会话日志目录 `$DSH_HOME/sessions/**/<sessionId>/`；
2. 删除投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`；
3. 从宿主的归档集合里摘掉，并从它所属工作区的 `sessionIds` 里摘除；
4. 广播 `api-session/removed`，已经打开的界面立刻掉行。

**顺序是有意为之：先删文件，删成功才动归档登记。** 如果文件删不掉（Windows 上宿主可能正开着句柄），
插件会报错并**原样保留归档状态**——绝不会留下「归档已取消、文件还在」的半成品，
那正是会话掉进「未分组」的原因。

只处理归档集合里的会话，**不碰任何活跃会话**。

## 安装

需要 dsh `0.2.x`（`0.2.0-rc.1` 起），profile 为 Web（依赖 `webServer` 与客户端 UI）。

```bash
# 从 npm 装
dsh plugin --profile web add dsh-archive-cleaner

# 或直接从 GitHub 装
dsh plugin --profile web add github:freshfish5446/dsh-archive-cleaner
```

装完**重启 dsh**（关掉窗口，重新用启动脚本拉起），然后 **Ctrl+F5** 刷新页面。

手动安装（不走包管理器）也行，见下面的「本地开发」。

## 使用

1. 在侧栏把不想要的会话「归档」掉（归档会话默认不在正常列表里显示）。
2. 打开它的「...」菜单 → **删除会话** → 再点一次确认。
   或者在任何会话里输入 `/purge-archived` 一次清空整个归档区。
3. 日志文件被删除，行也从侧栏消失。**不可恢复，没有回收站。**

## 兼容性

| 项目 | 要求 |
| --- | --- |
| dsh | `^0.2.0-rc.1`（`0.2.0` 正式版包含在内） |
| profile | `web`（用到宿主的 `commands`、`workspaceRegistry`、`webServer` 服务） |
| Node | `>=22` |

`peerDependencies` 已按上表声明，插件管理器会据此做适配检查。

## 已知限制

- **删除不可撤销**：直接删日志文件，不经回收站。
- **文件被占用**：Windows 上如果宿主正持有该会话的句柄，删除会失败并重试 6 次（退避 120ms×n）；
  仍然失败就把原因显示在菜单行里（文字变成「删除失败，再点重试 — …」）。这种情况重启 dsh 后再删一次即可。
- 只删日志与投影缓存，不动附件、spill、任务板等其它存储。
- 只对**已归档**的会话生效；活跃会话无论如何都不会被删。

## 工作方式（给想改代码的人）

```
index.js   宿主半边：/purge-archived 命令 + HTTP 路由（delete / archived / diagnose / icon.png）
client.js  客户端半边：往 sidebar.workspaces.session.menu.item 槽注册 order 500 的菜单行
icon.png   菜单图标（128×128）
cordis.patch.yml  bundle 补丁：把宿主插件 insert 进组合树
```

HTTP 接口（仅监听本机，供页面内的客户端调用）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/archive-cleaner/api/delete` | body `{ "sessionId": "..." }`，删除单个已归档会话 |
| `GET` | `/archive-cleaner/api/archived` | 当前归档 id 列表 |
| `GET` | `/archive-cleaner/api/diagnose` | 路径解析 / 客户端模块是否注册成功的诊断信息 |
| `GET` | `/archive-cleaner/api/icon.png` | 菜单图标（`no-store`，换图不会被浏览器缓存坑） |

`client.js` 用的是第三方 `dsh.client` bundle 格式（`window.__ModuleLoader__.load({ id, factory })`），
注册 id 必须等于 loader entry 名（= 包名），否则宿主会报 `loaded without registering ...`。
菜单行刻意**不用 `window.confirm` / `alert`**：这类原生对话框在 Web GUI 环境里可能被吞掉，
点了等于没点，所以改成菜单内二次确认 + 行内报错。

## 本地开发

```bash
node --test          # 用假 ctx + 临时 DSH_HOME 跑完整删除链路，不依赖真实 harness
```

装进本机 profile 调试（不经过 pnpm）：

1. 把整个目录拷到 `$DSH_HOME/profiles/web/node_modules/dsh-archive-cleaner/`；
2. 在 `profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里各加一条
   `"dsh-archive-cleaner"`（**注意别给这个 JSON 写 BOM**，否则 `JSON.parse` 直接崩）；
3. `node <launcher>/lib/bin.js --profile web --dump-config` 退出码必须是 0；
4. 重启 dsh，然后 Ctrl+F5。

## English quickstart

DeepSeek Harness has no delete feature yet — this installable plugin adds it. It really **deletes archived sessions** — log directory, projection cache,
archive entry and workspace accounting — with a red **Delete session** row in the sidebar's session
"..." menu (two-click confirm) and a `/purge-archived` slash command.

```bash
dsh plugin --profile web add dsh-archive-cleaner
# restart dsh, then hard-refresh the page
```

Requires dsh `^0.2.0-rc.1` and the `web` profile. Deletion is permanent — there is no trash.

## License

MIT
