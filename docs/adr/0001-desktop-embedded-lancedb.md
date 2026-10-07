---
status: accepted
---

# 采用桌面嵌入式 LanceDB

搜索后端采用桌面嵌入式 LanceDB，服务中英混合关键词搜索，并为后续语义搜索和关联推荐预留扩展空间。用户选择承担原生资源交付成本，以避免要求用户单独管理数据库服务；无需保留 OmniSearch 兼容性。

交付与运行时部分已由 [ADR 0003](0003-global-latest-lancedb.md) 调整为用户全局安装 latest；以下保留原始决策背景。桌面嵌入式和独立后台进程的选择仍然有效。

## 原始交付约束

首版仅支持 macOS Apple Silicon，以手动安装的平台包交付插件与固定版本原生资源。用户不需要 npm、编译工具或独立维护的数据库服务；官方社区目录一键安装不作为首版交付要求。

实施时需将插件声明为桌面专用，并调整 AGENTS.md 中所有运行时依赖必须打入 main.js 的约束，允许随插件版本交付的原生资源。LanceDB 由插件管理的后台子进程持有，关键词索引为每台设备独立维护、可重建的缓存。先验证复用宿主运行时，不满足时再评估随平台包交付固定运行时。

升级在 Obsidian 完全退出后手动替换完整平台包，保留设置；索引格式不兼容时允许重建。向量缓存重建还涉及远程请求和费用，不能由关键词缓存失效自动触发全量发送。

标准社区安装仅下载 main.js、manifest.json 和可选 styles.css；额外原生库不能依赖此流程自动安装。首版由用户手动替换版本匹配的平台包，插件不自行下载或更新可执行依赖。[官方发布说明](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)
