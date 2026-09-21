# Annotation Core 独立组件架构升级

对应候选版本：0.3.12-rc2.20。依据用户已确认的 2026-09-20 架构文档与本次「按文档对各个插件进行架构升级」指令。

## 已实现

本地固定引用和会话扩展数据默认可用；通用来源/授权 provider；第三方来源按命名空间注册；受管提供方失联后禁止离线回退。

技术入口：[实现](../../src/public/host-api.ts)。本轮只有源码和候选产物，尚未安装到实际实例；不以单元测试替代真实数据验收。

## 依赖与使用

Core 独立于 Maintenance、Bridge、DAG 和贴纸。DAG → Core；Bridge → Core；普通贴纸 → Core + Bridge；Companion 只对接 Bridge。Maintenance 可选，但已注册实例必须在线启动，失联暂停持久修改，恢复先补齐回执，解除注册须完成收尾。未注册实例独立运行。

普通安装、无 Launcher 启停、连接页及故障处理见 Maintenance 发行包 README；adapter 构建、目录与启停见随包 ADAPTER-AUTHORING.md。不要沿用作者本机 Home、令牌、Vault 绑定或旧构件回执。

## 验证与保留边界

当前检查覆盖合成会话、临时存储和自动交互。整体证据在本次交付目录的 implementation.md 与测试回执；没有写入真实 Home、Vault、Codex 会话或 Launcher。DAG Maintenance adapter 重构、GPT Compat 完善、已弃用 Codex Runtime、跨实例全局绑定按确认范围暂缓。Codex 双向维护当前无已验写 adapter，保持关闭。
