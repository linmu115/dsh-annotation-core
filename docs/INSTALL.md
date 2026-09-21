# 独立插件安装与使用（DSH 0.1.5-rc.2）

本批为 RC 预发布。基础使用不需要 Session Maintenance、Launcher、Codex 或 LLM 帮忙配置。Maintenance 的受管实例和同步流程不在本批发布范围。已经注册为受管实例的用户，不能只关引擎绕过管理约束；应先按 Maintenance 的正式解除注册流程处理，再使用独立模式。

## 下载与环境

使用 Node.js 24、已经可正常启动的 DSH 0.1.5-rc.2 / web profile，以及桌面版 Obsidian（仅笔记连接需要）。先完成 DSH 自身的模型配置并确认普通聊天可用。

从以下版本的 GitHub Release 下载附件；不要使用 npm @latest、上游 ThoughtDAG 桌面包或旧 Suite 代替：

| 插件 | 本批版本 | 必要依赖 |
|---|---|---|
| [Annotation Core](https://github.com/linmu115/dsh-annotation-core/releases/tag/v0.3.12-rc2.24) | 0.3.12-rc2.24 | DSH 宿主 |
| [ThoughtDAG](https://github.com/linmu115/thoughtdag/releases/tag/dsh-v0.4.14-rc2.20) | 0.4.14-rc2.20 | Core |
| [DSH Obsidian Bridge](https://github.com/linmu115/dsh-obsidian-bridge/releases/tag/v0.4.1-rc2.8) | 0.4.1-rc2.8 | 本套引用功能需要 Core |
| [普通贴纸](https://github.com/linmu115/dsh-session-sticker-board/releases/tag/v0.7.4-rc2.7) | 0.7.4-rc2.7 | Core + DSH Bridge；Better Sidebar 可选 |
| [Obsidian Companion](https://github.com/linmu115/obsidian-deepharness-bridge/releases/tag/v0.7.0-rc2.6) | 0.7.0-rc2.6 | 对接本批 DSH Bridge |

附件是已经构建的运行包；使用方无需检出作者开发工作树或安装本地 contracts/protocol 源码。SHA256SUMS.txt 用于核对附件。可选 Obsidian CLI 不存在时，基础桥与引用仍可使用，CLI 操作不可用。

## 安装 DSH 侧插件

先正常停止目标 DSH，使用它原来的 DSH_HOME 和 profile。以下为 PowerShell 示例，请换成自己的绝对路径；不要复制作者的实例 ID、令牌、Vault ID 或配置备份。所有命令在下载附件目录执行。

```powershell
$env:DSH_HOME = 'C:\DSH\my-home'
dsh plugin --profile web add ./dsh-annotation-core-0.3.12-rc2.24.tgz
dsh plugin --profile web add ./dsh-thoughtdag-0.4.14-rc2.20.tgz
dsh plugin --profile web add ./dsh-obsidian-bridge-0.4.1-rc2.8.tgz
dsh plugin --profile web add ./dsh-session-sticker-board-0.7.4-rc2.7.tgz
dsh --profile web --no-open
```

只需要图功能时，安装前两个即可。使用安装在项目内的 DSH 时，用该项目原有的 dsh 命令入口，保持同一工作目录和 DSH_HOME。打开终端打印的本机 Web 地址，不公开其中的登录令牌。

四个 DSH 包都包含官方 bundle patch，安装命令负责注册。不要再向 profile 手工插入相同插件节点。web 为本批配套 profile；使用自定义 profile 时，需让 Core 与 Bridge 的 profileId 一致，并按宿主规则配置。

## 手动安装 Obsidian 侧

1. 下载 Companion Release 中的 main.js、manifest.json、styles.css，或包含同样文件的 zip。
2. 关闭目标 Vault 的该插件。首次安装则创建 `<Vault>/.obsidian/plugins/obsidian-deepharness-bridge/`。
3. 把三个文件放到这个目录，不要多套一层 zip 文件夹。更新前备份原目录，保留 data.json。
4. 在 Obsidian 设置 → 第三方插件启用 DeepHarness Bridge；必要时重新加载 Obsidian。按 Obsidian 自身提示确认本地插件。
5. 在 DSH WebUI 的设置 → Obsidian 连接，发现并选择已打开的 Vault，然后连接。也可在 Companion 设置中核验并绑定目标 DSH。

DSH 侧可以连接多个 Vault；每个 Vault 同时只绑定一个 DSH 实例/profile。端口仅是通信地址，不是实例身份。自动发现不可用时使用两端设置提供的手动地址/文件夹选择入口核验目标；不能复制其他 Vault 的 data.json 冒充绑定。

断开只停止通信，保留笔记、历史引用与双链；重连会核验目标。无需进入 Maintenance 面板完成绑定。

## 开始使用

- Core：在原生会话选中文字，使用注册的引用/注释入口；待发送气泡显示在输入区，检查后自行发送。
- DAG：打开已有会话，点“思维图”。首次显示所属会话卡片；在会话页改名后，图和会话卡片在重新打开/刷新时显示新名称。图的布局和修订不因读标题而重写。连线表示上下文引用操作，不是随意装饰线；仅放入卡片不等于授予上下文读取。
- 笔记引用：先从 Companion 打开内嵌 DSH 页面并选择目标会话，再在笔记选段“引用到 DSH”。等待目标页面接收，检查引用气泡，再自行发送。独立浏览器窗口不会抢走指定 Viewer 的新引用。
- 普通贴纸：从主会话划选菜单创建贴纸；插件提供普通贴纸及笔记关联。DAG 的“会话贴纸”是另一项功能，不应混称。

## 更新、卸载与数据

更新：正常停止 DSH，备份自己的 DSH_HOME，以同样的 plugin add 命令安装新 tgz，重启并刷新所有内嵌/独立页面。Companion 更新三个运行文件、保留 data.json 后重新加载。核对实际加载版本，不只看下载文件名。

移除：正常停止 DSH，按依赖逆序移除不再需要的包：

```powershell
dsh plugin --profile web remove dsh-session-sticker-board
dsh plugin --profile web remove dsh-obsidian-bridge
dsh plugin --profile web remove dsh-thoughtdag
dsh plugin --profile web remove dsh-annotation-core
```

只有要全部卸载时才执行全部四条。卸载代码不等于删除业务数据；保留 DSH_HOME、Vault 笔记和 Companion data.json 才能保留恢复条件。不要删除数据目录来“修复”版本问题。Companion 可先在设置中停用；需要移除代码时先备份目录，再通过 Obsidian 插件管理卸载。

## 故障定位与验收边界

| 现象 | 检查 |
|---|---|
| 插件等待服务 | 按依赖顺序安装同批包，核对同一 Home/profile，检查启动日志；无需启动 Maintenance |
| 笔记有引用，DSH 没气泡 | 核对 Vault 绑定和目标内嵌页面；更新后刷新 Obsidian 内的 DSH 页面，再查看待处理引用状态 |
| 图缺少名称 | 核对 DAG .19、DSH rc.2 和宿主 sessionQuery 标题接口；标题不可用时保留已存标签/ID，不清空图 |
| 模型报 credential 或网络错误 | 检查 DSH 模型/代理配置；引用插件不提供模型密钥 |
| 没有 CLI | 只影响 CLI 增强操作，不能因此阻断基础桥 |

本批真实实例已验证：引擎关闭下的桥连接/断开/重连、笔记引用气泡及用户发送测试、DAG 所属卡片及重开保持。各发布说明补充本轮名称修复与自动测试结果。全部贴纸编辑/删除/回链、所有 DAG 上下文操作、多 Vault 组合和 Maintenance 同步不能由这些结果推定为已完成真实验收。

## 从源码开发

运行包安装不需要下面这些开发依赖。当前部分源码仍使用本地 contracts/Core/Protocol SDK 路径，直接对单仓库执行 install 不代表已具备完整构建工作区。维护者应按 package.json 明示路径准备对应 SDK 和工具链；这属于源码构建限制，不是运行时必须安装 Maintenance 引擎。发布附件已去除开发路径，并对运行文件做本机路径和未打包依赖检查。
