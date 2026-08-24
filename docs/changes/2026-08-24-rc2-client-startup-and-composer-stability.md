# rc.2 Client 启动与输入绑定稳定性修复记录

日期：2026-08-24 至 2026-08-25  
适配目标：DeepSeek Harness `0.1.1-rc.2` 官方 `web` profile

## 现象

- 官方 rc.2 加载 Client 插件时不会把 Host bundle 配置原样传给浏览器 `apply()`，直接读取 `config.profileId` 会导致插件启动失败。
- 输入框挂载后 React 报错 `#185`；原因是 `useSyncExternalStore` 每次读取都收到新的对象，触发无穷更新。
- 注释详情虽然可见，但它位于原生会话和 better-sidebar 的堆叠上下文之下，关闭按钮会被侧栏截获点击。

## 修复

- 将浏览器配置正规化：缺省或空配置使用官方 `web` profile，未来显式 profile 值仍原样保留。
- `ComposerBinding` 缓存身份稳定的快照，只在可观察字段真正变化时生成新对象并通知订阅者。
- 注释详情通过 React portal 挂载到 `document.body`，并使用高于侧栏的全局层级；弹层不再受输入框局部堆叠上下文限制。
- 将 `react-dom` 声明为运行时 peer 和官方浏览器模块表外部依赖，避免把第二套 React DOM 打进插件包。

## 主要改动位置

- `src/client/config.ts`、`src/client.tsx`：rc.2 Client 配置正规化。
- `src/client/composer-binding.tsx`：身份稳定的外部存储快照。
- `src/client/reference-dialog.tsx`、`src/client/styles.css`：全局 portal 弹层与层级。
- `tsdown.config.ts`、`package.json`：`react-dom` peer/externals 边界。
- `tests/client-config.test.ts`、`tests/composer-binding.test.tsx`：回归测试。

## 验收

- `pnpm typecheck`：通过。
- `pnpm test`：21 个测试文件、79 项测试通过。
- `pnpm build`、`pnpm pack`：通过；Client bundle 不再内嵌 `react-dom`。
- sidechat 一次性官方 rc.2 profile 验收：6 项 Playwright 测试全部通过，包括主输入框气泡、详情编辑/关闭、删除顺延和真实侧边子会话气泡。

## 边界

- 未修改正式 `web` profile、用户会话或 Obsidian Vault。
- 未发布 npm、未推送远端、未创建 Generation。
