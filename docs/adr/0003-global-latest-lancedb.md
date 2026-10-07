---
status: accepted
---

# 用户全局安装最新 LanceDB

用户于 2026-10-07 明确选择 `npm install -g @lancedb/lancedb@latest`，不固定 LanceDB 版本。用户自行安装 Node.js/npm；插件使用外部 Node 子进程，从 `npm root -g` 指定的全局模块目录加载 SDK。设置允许手动填写 Node 和全局模块路径，以支持 Finder 启动、自定义 npm prefix 和版本管理器。

此决策替代 ADR 0001 中捆绑固定原生资源、无需用户安装 Node/npm 的交付约束。保持桌面嵌入式数据库和独立后台进程，不分发 Node、LanceDB 或 Arrow。Arrow 等 peer dependencies 由 npm 安装。`latest` 是用户执行安装/更新命令时的选择；插件不会联网查询版本或自动修改全局安装。

全局版本可随用户操作变化；插件报告实际版本并验证必需 API、原生加载与 ICU 行为，不实施精确版本白名单，也不承诺任意未来版本都兼容。配置或全局依赖改变后应重新检查环境。开发类型依赖使用 `latest`；仓库 lockfile 仅记录开发工具安装快照，不约束用户的全局运行版本。
