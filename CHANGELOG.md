# 更新记录

## 1.0.0 — 2026-11-23

Cocos Creator 命令行工具的首个公开版本，命令入口为 `cocos`。

- **项目与编辑器**：从 Creator 3.8.8 模板创建 2D 或 3D 项目，查看版本及安装信息，打开目标项目。
- **Windows 后台打开**：默认把 Loading 和主窗口留在后台，保留现有焦点和 Creator 任务栏入口，并清除任务栏闪烁。
- **离线资源检查**：检查 `.meta`、UUID 和序列化引用，查找资源的引用位置，只读查看或比较 Prefab。
- **原生构建**：使用 Creator 导出的构建配置执行打包，支持日志、超时和 JSON 结果。
- **Funplay MCP 接入**：安装或更新 Funplay 扩展，按项目管理编辑器连接与生命周期，为 11 种 Agent 客户端注册 MCP，并可通过 `--skills` 安装 Funplay Skills。
