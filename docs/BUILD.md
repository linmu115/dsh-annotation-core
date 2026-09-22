# 从独立仓库构建

当前运行环境是 **DSH 0.1.5-rc.2 实例 / web profile**。其他 DSH 版本未验收。以下是开发和打包步骤，不会启动实例、修改绑定或向 Vault 写入。

工具链：Node.js **24.7.0**（见 `.node-version`）。安装步骤需要访问 npm registry；仓库内 SDK 已随源码提供，不需要其它作者工作树。使用锁文件安装，日常不要执行升级依赖命令。

```powershell
git clone https://github.com/linmu115/dsh-annotation-core.git
cd dsh-annotation-core
# 使用 pnpm 11.19.0，与 packageManager 声明一致
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm package:release
```

pnpm 由 `packageManager` 固定为 **11.19.0**；如本机未安装，可先执行 `npm install --global pnpm@11.19.0`。`pnpm-lock.yaml` 固定实际依赖版本，`pnpm-workspace.yaml` 只声明仓库内成员及构建脚本许可。

打包结果在 `.artifacts/`；打包脚本移除开发依赖、开发脚本和源码映射，并拒绝运行依赖里残留 `file:` / `link:` / `workspace:`。生成运行包前必须先成功构建。

## 可选宿主源码集成测试

默认测试使用锁定的公开 DSH 包，不读取邻接源码树。`native-context-loop` 测试依赖带原生上下文扩展的宿主实现，单独保留为 `pnpm test:host`：先准备该宿主源码及其依赖，设置 `DSH_HOST_SOURCE` 为其绝对路径，再执行命令。它不是独立 Core 构建的前提，也不能由默认测试通过推定为已验收。
