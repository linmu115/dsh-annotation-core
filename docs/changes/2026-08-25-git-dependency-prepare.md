# Git 依赖缺少构建产物

日期：2026-08-25

## 现象

`dsh-sidechat` 在 Maintenance 的临时干净工作树中安装 `dsh-annotation-core` 时，Git 仓库不包含被忽略的 `lib/`，后续类型检查无法解析 Core 的公开入口。

## 原因

Core 的发布包会包含构建产物，但直接通过 GitHub 精确提交安装时只取得 Git 跟踪文件。项目此前没有 Git 依赖安装阶段的构建钩子，本地残留的 `lib/` 掩盖了这个边界。

## 修复

增加标准 `prepare` 脚本，在 Core 作为 Git 依赖安装时执行现有 `pnpm build`。npm/tgz 形式的正式 DSH 部署仍使用 Maintenance 已测试的内容寻址产物，不改变运行时依赖关系。

## 验证

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- 从 GitHub 精确提交安装 Core 后，消费插件可以解析 `dsh-annotation-core/protocol` 与公开类型入口
