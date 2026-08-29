# dsh-annotation-core

为 DSH 插件提供统一的 Codex 风格注释气泡、可靠发送和历史注释详情。

[English](README_EN.md) · 中文

## 适用版本

- DeepSeek Harness（当前客户端基线为官方版 `0.1.2-alpha.1`，安装不限制版本）
- 官方 `web` profile
- 不依赖 EAC 或其他桌面壳

这是一个基础插件，没有单独的侧栏入口或看板。安装它之后，需要再安装使用这些能力的功能插件，界面才会出现。

## 安装

按下面的顺序安装：

1. 安装本插件：

   ```bash
   dsh plugin --profile web add dsh-annotation-core
   ```

2. 根据需要安装一个或两个功能插件：

   - `dsh-sidechat`：划选 DSH 对话内容并添加到主聊天或侧边聊天。
   - `dsh-session-sticker-board`：贴纸、Obsidian 笔记引用和双向链接。

3. 完整重启 `dsh web`，然后刷新浏览器页面。

如果由 DSH Maintenance Engine 安装 sidechat 或 sticker-board，维护引擎会自动检查并安装匹配版本的 core，不需要重复安装。

## 使用

功能插件添加引用后：

- 引用显示在输入框上方的注释气泡中，不会把 `@`、引用块或内部格式写进正文；
- 点击气泡可查看完整选段、编辑补充注解或删除引用；
- 删除后，尚未发送的注释编号会自动顺延；
- 删除 Obsidian 待发送引用时，DSH 气泡会立即消失；对应 Obsidian 记录在后台级联清理，离线时自动重试，不阻塞笔记编辑；
- 发送后，用户消息下方显示“`N 条注释`”，可随时重新打开；
- 模型回答中的“注释 N”链接会打开对应的注释详情；
- 发送失败时，正文、图片和待发送注释都会保留。

## 常见问题

### 安装后为什么看不到入口？

这是正常的。core 只提供共享能力，请继续安装 `dsh-sidechat` 或 `dsh-session-sticker-board`。

### 可以同时安装 sidechat 和 sticker-board 吗？

可以。两者共享同一个 core 实例，不会各自复制一套注释状态。

### 可以用于其他 DSH 版本吗？

当前客户端测试证据来自官方 `0.1.2-alpha.1`，但包元数据不阻止其他 DSH 版本安装。升级后以运行时接口和回归测试结果判断兼容性，并建议先通过 Maintenance Engine 建立可回退点。

## License

MIT
