# M0 全局安装与宿主验证

日期：2026-10-07。用户已确认 `npm install -g @lancedb/lancedb@latest`，取消固定版本和原生资源随包交付。**本机的全局依赖加载、实际 Obsidian 原生查询、崩溃隔离和停用清理检查通过。** M1–M4 搜索功能尚未实现。

本报告保留 M0 完成时的状态。当前 M0–M2 已按个人自用范围完成，后续进展与验收范围以 [PLAN](PLAN.md) 和 [M2 验证报告](M2-VALIDATION.md) 为准。

此前发现的 Electron `runAsNode=0` 不再阻塞当前方案：插件现在执行用户安装的外部 Node.js，不使用宿主 Node 模式。完整决策见 [ADR 0003](adr/0003-global-latest-lancedb.md)。

## 实测环境

| 项目 | 实测值 |
| --- | --- |
| 系统 | macOS 15.7.3，build 24G419，arm64 |
| Obsidian | 1.13.7，独立临时 profile 和路径含中文/空格的测试 vault |
| 宿主实时版本 | Electron 43.3.0，Node 24.18.1，modules 148，napi 10 |
| 搜索子进程 | 用户安装的 Node 24.20.0，modules 137，napi 10 |
| 安装命令 | `npm install --global @lancedb/lancedb@latest` |
| 本次 latest 解析结果 | LanceDB 0.39.0；这是本次记录，不是运行时版本约束 |
| 全局目录 | `npm root -g` 返回自定义 prefix 下的 `~/.npm-packages/lib/node_modules` |
| 实际 SDK 入口 | 该全局目录内的 `@lancedb/lancedb/dist/index.js` |

宿主版本通过实际 Obsidian 的 `process.versions` 采集，子进程版本通过 IPC 报告采集。两者 Node 和模块 ABI 不同，说明搜索使用了独立外部运行时。没有修改 Electron fuse，没有在渲染进程中加载数据库原生库。

## 交付变化

插件包只含 `main.js`、`search-host.cjs`、`manifest.json`、`styles.css`、`resources.json`、`LICENSE`。两个 JavaScript 入口合计 11,749 bytes，当前 ZIP 为 7,098 bytes；不包含 LanceDB、Arrow、Node、第三方原生资源或开发 `node_modules`。打包脚本检查构建输入，防止把开发依赖意外打入插件。

Node 与 npm 由用户安装。LanceDB 及其 peer/native dependencies 由全局 npm 安装负责；插件显式读取并加载所选全局目录，资源清单仅校验插件自身文件。不会联网检查 latest、自动更新全局安装、精确限制 SDK 版本或回退到开发副本。

新增 **Node.js executable** 和 **Global modules directory** 设置，默认自动发现，允许按 `command -v node` / `npm root -g` 的结果覆盖。环境检测只执行 Node 版本检查和 npm 全局目录查询；原生库仅在用户选择 **Check native search** 后于子进程加载。

## 独立验证

```sh
npm install -g @lancedb/lancedb@latest
npm run package:darwin-arm64
npm run check:runtime
npm run verify:m0
npm run lint
```

| 检查 | 结果 |
| --- | --- |
| TypeScript 和双入口构建 | 通过 |
| ESLint | 无错误；保留一条关于 Obsidian 1.13 设置搜索 API 的建议，当前设置 UI 兼容声明的 1.11.4 API 下限 |
| Node/PATH 自动发现，自定义 npm 全局 prefix | 通过；忽略 PATH 中名为 `node` 的目录 |
| 手动 Node 与全局目录设置；相对路径/依赖缺失拒绝 | 通过 |
| 不实施 SDK 精确版本白名单 | 通过；未来版本号按实际元数据报告，缺少可用 API 的安装在加载阶段失败 |
| 解压包不含 native、runtime、node_modules | 通过 |
| 空子进程 PATH，中文和空格安装路径 | 通过 |
| 缺少全局 SDK 时不加载开发副本 | 通过 |
| 插件版本与 SHA-256 校验；篡改后台文件拒绝 | 通过 |
| 原生 ICU FTS、中文、英文小写、保留停用词、关闭 stemming | 通过 |
| 关闭重开数据库，带词位的短语查询 | 通过 |
| 原生加载后强制结束子进程、断开 IPC、后续新进程 | 通过 |
| 正常运行后的临时数据库清理 | 通过 |

`verify:m0` 使用临时目录解压完整包，并通过显式全局 SDK 路径运行。开发 lockfile 的解析快照不会决定被加载的 SDK。开发依赖声明为 `latest`；用户全局安装独立于该 lockfile。

## 实际 Obsidian 验证

使用 `/Applications/Obsidian.app`，指定独立临时 `--user-data-dir` 和只用于验收的本地 DevTools 端口。测试 vault 仅包含人工创建的 `Welcome.md` 和打包后的插件。首次信任确认仅作用于这个自建测试 vault；没有打开或改动用户已有 vault。

1. 插件成功加载，诊断命令注册，Node 与自定义全局目录自动发现成功。诊断弹窗在 Obsidian 独立设置窗口中正常显示。
2. 选择 **Check native search**，收到外部 Node 24.20.0 和全局 SDK 路径报告；ICU 创建、中文/英文查询、停用词/词干控制、数据库重开和短语查询全部通过。
3. 在搜索子进程报告原生 SDK 加载完成后，对该子进程发送 `SIGKILL`。插件显示检查失败；Obsidian 编辑器继续编辑并保存测试 Markdown。检查结束时 `cache/m0/` 为空。
4. 在另一次原生加载完成后停用插件。子进程退出，检查原 PID 已不存在，`cache/m0/` 为空。重新启用后命令恢复；最终包再次启动测试通过，停用时诊断弹窗也从 DOM 移除。
5. 保存显式 Node 和全局目录配置，停用再启用插件，配置保持一致。

这些检查验证本机当前全局安装和宿主的运行链路，不代表所有未来 latest 版本均可用，也不代表其他 macOS/Obsidian 版本已验证。

## 尚未覆盖的产品验收

- 其他设备、Node 版本管理器和 macOS/Obsidian 组合，以及用户未来更新后的全局 SDK，需要重新检查环境。
- 安装流程已实测 npm 全局下载和原生加载；未进行跨设备发布、升级/回退数据库兼容性测试。
- 此阶段尚未验证 Obsidian Sync 和其他同步工具的排除行为；目录名称不能代替同步排除。
- 当前只有内置样本文本，不包含实际 Markdown 索引、关键词 UI、语义队列或相关笔记。未测得 1 万篇、100 MiB、p95 ≤100 ms 或保存后 ≤2 秒等 M1–M4 指标。
- GitHub workflow 已改用全局 `@latest` 安装，但远端 CI 本次未运行。
