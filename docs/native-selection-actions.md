# 原生划选动作合同

版本能力：`native-selection-actions-v1`，由 Annotation Core 0.3.12-rc2.19 提供。

Core 原生安装唯一的主会话选区捕获和纵向菜单，内置「添加到当前会话」。此能力不要求 Sidechat 或 Better Sidebar。选文完整传递，Core 决定引用预算；流式、跨消息、空选区、侧栏与 inert 区域不接收。

消费者在 Cordis 注入 `annotationCore` 后检查能力，调用 `registerSelectionAction({ id, label, order, iconPath?, available?, run })`，并在自己的 effect 清理时调用返回的注销函数。id 必须唯一；卸载后动作消失，Core 不持有消费者的 DOM。

`run` 收到 `DshMessageCapture`：sourceSessionId、anchorId、可选 messageId、selectedText、role、occurrence。消费者不另装主会话 selectionchange 监听。失败通过 Promise 报错，菜单显示错误；动作不得隐式发送模型消息。

Sidechat 注册在侧聊中询问；ThoughtDAG 注册跨会话引用和会话贴纸；Sticker Board 注册普通贴纸，没有 Core 时使用自己的普通贴纸备用入口。Core 旧 openCrossSessionReference 方法暂保留供旧消费者兼容，新入口不再使用其目标选择器。
