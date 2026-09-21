# Annotation Core

**0.3.12-rc2.23 · DSH 0.1.5-rc.2**

Core 提供原生会话选文动作注册、统一引用气泡、注解、发送状态及上下文接入，并向扩展提供会话数据和引用端口。不依赖 DAG、Bridge、贴纸、Maintenance 或 Launcher。

气泡显示在输入区；用户检查引用后自行发送。已发送注释可在消息下重新查看。来源准备、发送、撤销和回执遵循同一引用状态流程，失败时保留草稿，不自动重复发送。

图、笔记定位等业务分别由各插件负责。Core 默认使用本地会话能力；可选受管接入通过通用服务提供，不把 Maintenance 当作基础运行前提。历史原生上下文管理工具需要相应能力，不能因安装 Core 就宣称全部高级功能可用。

开发接口：`dsh-annotation-core/client-api`、`host-api`、`protocol`、`typert`、`remote`。选文动作以 `registerSelectionAction` 注册；会话扩展数据使用带命名空间和修订的公共端口，不直接改其它插件存储文件。完整类型随包提供。

## 安装、配置与使用

[完整命令行与手动安装教程](docs/INSTALL.md) · [下载本版本附件](https://github.com/linmu115/dsh-annotation-core/releases/tag/v0.3.12-rc2.23)

本批为预发布，安装顺序、数据保留、更新卸载和故障定位均在教程中。无需用户的 LLM 才能完成基础配置。当前能力和未完成验收见 [发布验证记录](docs/RELEASE-20260920.md)。
