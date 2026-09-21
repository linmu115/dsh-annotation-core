# 被引用文段末尾的引用角标（0.3.12-rc2.28 起）

对应需求：在**被引用的文段末尾**加一个引用小角标（与「添加贴纸」的角标同类），点击**直接弹出引用卡片**，位置用**默认弹出位置**（复用既有弹窗逻辑），不必再去左下角引用栏里翻找。贴纸与 Core **各自独立实现**，Core 在自己的 UI 内用同样的方法做，不引入跨插件契约。

## 已实现

新增 `src/client/reference-badges.tsx`，在 `service.tsx` 的 `renderGlobalDialog()` 里与 `<ReferenceHighlights/>` 并排挂载，数据源就是现成的 `this.highlights`：

- `collectReferenceBadges(store, sessionId)` 合并 pending 集合与**已预取的 sent 集合**，去重口径与高亮完全一致（`anchorId + selectedText + occurrence` 的 JSON 串），且只处理 `locator.sessionId === 当前会话` 的 `dsh-message` 条目。整条 `set` 随角标一起传下去，对话框因此还能用同一集合的其它条目做标签页。
- 角标按钮 `.dshAnnotationReferenceBadge`：`position:fixed`、`pointer-events:auto`、`user-select:none`，19px 圆钮（与 `.dshAnnotationCount` 同族），挂在 body 下的**独立 host** `div[data-dsh-annotation-badges]` 里。host 本身 `pointer-events:none`，只有按钮是命中区。
- **绝不插进 `[data-chat-anchor-key]` 内部、绝不改写消息 DOM**：既有设计是 CSS Highlight 只读渲染；把节点插进消息里还会污染 `referenceRange` 的 occurrence 匹配。
- 定位复用既有实现，没有另写一套：`service.resolveDshAnchor`（durable anchorId → 本次渲染 key）+ `referenceRange`（`reference-highlights.tsx`）+ 取**最后一个 rect** → `{x: right + 7, y: top + height/2}`（CSS `translateY(-50%)` 负责视觉居中）。
- 点击：`openReference(set, referenceId)` → `dialog.open(set, referenceId)`，**不传第三个 anchor**，于是 `ReferenceDialog` 走它自己的默认停靠（`[data-composer-card]`），与首次写入引用后的打开路径完全一致。`pointerdown`/`mousedown` 都 `preventDefault()`，保住用户的选区（贴纸同样处理）。

## 避让（启发式，无跨插件契约）

贴纸角标同样落在 `right + 7`，两者会重叠。做法是算出点位后读 `.dsh-sticker-board-dot` 的矩形，若 `|Δx| < 20 且 |Δy| < 22` 就按 **24px 阶梯**下推，直到不重叠：

- 阈值取自贴纸自己的 `spreadDotPoint`（`|Δx| < 18、|Δy| < 20`）并略放宽；阶梯同样取 24px，视觉上两族角标一致。
- **这是启发式，没有跨插件契约**：Core 只是观察贴纸渲染出来的矩形，不向贴纸索取任何东西。贴纸改类名、改位置或没渲染，本插件就退化为「不避让」，也就是回到原本的单纯重叠，不会报错也不会阻塞。
- 局限：只避让**当前已渲染**的贴纸角标；贴纸在下一帧移动时不会再来一次联动计算（我们自己的 rAF 重绘只由 DOM/滚动/尺寸变化触发）。每帧全量读取一次贴纸角标矩形是这个启发式的固定成本。

## 性能

既有的高亮实现是每帧全量重建 Range、无缓存、无视口裁剪，本任务要求不能把开销翻倍，于是：

- **文本表缓存**：新增 `reference-text-index.ts`（上一轮半成品，本轮接续并整理）：按 anchor 根元素缓存「非空白字符表 + 拼接串」，供 `referenceRange` 与角标共用一次 TreeWalker。挂在 body 之外的（jsdom、已摘除节点）只测量不缓存，避免钉住整棵子树。
- **惰性失效（不是每帧清空）**：缓存由一个 `dirty` 标志失效——`markReferenceTextDirty()` 只在 mutation observer 判定「这批变更可能动到正文或点位」时置位，真正的清表推迟到**下一次读取**；`clearReferenceTextIndex()` 只在观察重新开始时用。滚动/尺寸变化触发的重绘因此直接复用上一帧量好的表，不必每次重绘都重跑 TreeWalker（每帧清空会把缓存开销原样还给每次滚动）。
- **跳过自身 host 的 mutation**：`affectsMessageText(records)`（放在 `reference-text-index.ts`，高亮与角标共用）把「落在 `[data-dsh-annotation-badges]`/`[data-dsh-annotation-dialog-host]` 内」的记录滤掉。否则在注释框里打字、或角标自己重定位，都会把文本表标脏。属性变更则按 `LAYOUT_ATTRIBUTES = ['data-chat-anchor-key','class','style','hidden','data-streaming']` 判定：这几个属性不必然改字，但会移动正文或改变角标该落在哪，因此**算作影响**；其余属性变更被忽略，纯样式噪声不会触发重绘。
- **视口裁剪（margin 160px）**：先读 anchor 元素的一个矩形，整段落在视口外 160px 以外就直接跳过，连 Range 都不建。**高亮侧也补了同一层裁剪**（此前是高亮开销的大头）。
- **大量引用时退化**：单会话候选超过 200 时，只测「离视口最近」的 200 个，渲染量不再随引用总数增长。
- 位置结果按「候选列表不变则复用」缓存，并在每次重绘开始时整体失效，因此不会拿旧布局的点位继续画。

## 已知限制（本任务未改跨层逻辑）

已发送（`state === 'sent'`）引用的角标**可以点开、但只能看**：`ReferenceDialog` 依 `set.state === 'pending'` 决定 `editable`，非 pending 时注释区渲染成只读文本 `.dshAnnotationCommentReadOnly`（无 textarea、无保存按钮），并且 host 侧 `store.updateComment` 对非 pending 集合本来就抛 `RangeError('No pending reference set')`。实际表现就是：点 sent 角标 → 弹出只读卡片，能看注释、能「重新添加到当前提问」「解除双向引用」、必要时「重试回链」，但**改不了注释**。这是既有行为，本任务只把它带到角标入口上，没有改协议或 host。

## 验证

- 类型检查：`node node_modules/typescript/bin/tsc --noEmit` → 退出码 0。
- 全量测试：`node node_modules/vitest/vitest.mjs run --pool=threads --maxWorkers=1` → 52 个文件、302 项全部通过（既有 286 项断言未放宽）。
- 新增 `tests/reference-badges.test.tsx`（10 项，jsdom 无布局）：
  - N 个引用生成 N 个角标，pending + 已预取 sent 去重后只画一个，跨会话条目不画，空集合不挂 host；
  - anchor 解析失败（`missing-anchor`）不渲染角标，也不猜位置；
  - 点击调用 `dialog.open` 且参数**只有两个**（不带 anchor），`pointerdown`/`mousedown` 都被 `preventDefault`；
  - 取最后一个 rect 定位（`87px / 42px` 固定值）；
  - 消息 DOM 变化会重绘（`127px → 157px`），自身 host 内的 mutation 不重绘；只改布局属性（`class`）也要重绘，不必等滚动；
  - 空候选集合不挂角标 host；
  - 视口外 4000px 的 anchor 连 `document.createRange` 都不会被调用；
  - 避让：合成贴纸矩形与真实 `.dsh-sticker-board-dot` 两种方式都验证按 24px 阶梯下推；
  - `affectsMessageText` 的过滤口径。
- 新增 `tests/reference-text-index.test.ts`（6 项）：读第二次复用同一张表；只置脏不算失效（pointer 不变），`markReferenceTextDirty()` 之后才换新表；`clearReferenceTextIndex()` 立即丢表；游离根不缓存（连读两次得到两张表）；`LAYOUT_ATTRIBUTES` 恰好是那 5 个属性；自身 host 内 `style` 变更不算影响、`data-chat-anchor-key` 上的同样变更算影响。
- 未做真实浏览器里的像素级目视验收；本记录不代替用户实测。
