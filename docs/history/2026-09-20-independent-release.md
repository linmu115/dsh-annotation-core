# 独立插件交付记录（未索引过程草稿）

来源：用户要求修复 DAG 名称显示，并将已完成插件整理 README、重新打包、提交推送 GitHub。本记录没有绑定宿主事件索引，不伪造可展开回执。

核查 rc.2 官方代码发现 listSessions 只返回 header/live/persisted，不包含 title。DAG 改用 readTitle/readTitleSnapshots，在读取图时更新显示名称，不写入布局或增加修订。旧空图与所属卡片修复一并交付。

五组件 README 重写为独立运行教程，旧 README 保存在 docs/history；配套 peer 版本对齐。发布构件从源码构建输出收集，不读取用户数据，不附带 Maintenance 引擎，剥离开发链接和构建路径并生成摘要。源码部分本地 SDK 依赖仍明确保留为构建限制。

自动测试与实际验证范围见 docs/RELEASE-20260920.md；图名称实际可见，新增浏览器验证页的加载/控制超时已登记，不将它误报为全套冷启动通过。测试数据、Home、Vault 绑定和维护历史没有进入发布构件。
