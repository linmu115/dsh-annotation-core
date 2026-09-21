# Annotation Core

**0.3.12-rc2.23 · DSH 0.1.5-rc.2**

Core 提供原生会话选文动作注册、统一引用气泡、注解、发送状态及上下文接入，并向扩展提供会话数据和引用端口。不依赖 DAG、Bridge、贴纸、Maintenance 或 Launcher。

气泡显示在输入区；用户检查引用后自行发送。已发送注释可在消息下重新查看。来源准备、发送、撤销和回执遵循同一引用状态流程，失败时保留草稿，不自动重复发送。

图、笔记定位等业务分别由各插件负责。Core 默认使用本地会话能力；可选受管接入通过通用服务提供，不把 Maintenance 当作基础运行前提。历史原生上下文管理工具需要相应能力，不能因安装 Core 就宣称全部高级功能可用。

开发接口：`dsh-annotation-core/client-api`、`host-api`、`protocol`、`typert`、`remote`。选文动作以 `registerSelectionAction` 注册；会话扩展数据使用带命名空间和修订的公共端口，不直接改其它插件存储文件。完整类型随包提供。

## 部署方法

**环境要求**：Node.js 24，可正常启动的 DSH `0.1.5-rc.2` / `web` profile。Core 不依赖 Maintenance、Launcher、Codex 或 Obsidian。

从 [Release v0.3.12-rc2.23](https://github.com/linmu115/dsh-annotation-core/releases/tag/v0.3.12-rc2.23) 下载 `dsh-annotation-core-0.3.12-rc2.23.tgz`，然后：

```powershell
$env:DSH_HOME = '<你的 DSH_HOME>'
dsh plugin --profile web add ./dsh-annotation-core-0.3.12-rc2.23.tgz
```

安装命令会把包写进 profile 并在 `dsh.profile.bundles` 注册，**不要**再手工向 profile 插入同名插件节点。随后正常重启 DSH 使新版本加载。

核对安装结果：

```powershell
(Get-Content "$env:DSH_HOME\profiles\web\node_modules\dsh-annotation-core\package.json" -Raw | ConvertFrom-Json).version
```

**用法**：在原生会话中选中文字，用注册的引用/注释入口；待发送气泡显示在输入区，检查后自行发送。

**更新**：正常停止 DSH，备份 DSH_HOME，用同样的 `plugin add` 装新 tgz，重启并刷新页面。
**卸载**：`dsh plugin --profile web remove dsh-annotation-core`。卸载代码不等于删除业务数据，保留 DSH_HOME 才能保留恢复条件。

完整说明（安装顺序、Vault 绑定、更新卸载、故障定位）：[INSTALL.md](docs/INSTALL.md)。本批为预发布，当前能力和未完成验收见 [发布验证记录](docs/RELEASE-20260920.md)。
