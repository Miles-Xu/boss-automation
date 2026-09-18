# API

通过 `require('boss-automation')` 导入。浏览器操作是异步函数；字段解析是同步函数，不需要浏览器。各操作可以单独调用，调用顺序由调用者决定。

## 连接



```js
const { connect } = require('boss-automation');
const session = await connect({ host: '127.0.0.1', port: 9222 });
try {
  // 在此调用所需操作。
} finally {
  await session.close();
}
```

连接已启动、已登录的 Chrome 中的 BOSS 推荐页。默认 `host: '127.0.0.1'`、`port: 9222`；存在多个匹配标签页时，用 `targetId` 指定 Chrome 调试目标 ID。可传入 `signal: controller.signal` 取消操作，或 `cdp` 注入兼容 `chrome-remote-interface` 的客户端。

连接使用本机按端口共享的锁；同一浏览器的所有调用进程需使用相同的锁目录。目录依次取 `lockRoot`、环境变量 `BOSS_BROWSER_LEASE_ROOT`，最后使用系统临时目录下按用户区分的子目录。锁不协调不同机器上的客户端。同一 session 同时只能执行一个操作，重叠调用报 `SESSION_BUSY`。列表监听可以持续存在，`capture.read()` 仍需与页面操作顺序执行。

`session.close()` 释放监听、CDP 连接和锁，保留 Chrome；CDP 关闭失败时保留锁。取消不能撤销已经发出的请求或点击。库使用 DOM/Input/Network 和按值返回的 `Runtime.evaluate`，不调用 `Runtime.enable`。

## 职位与页签



| 操作                                | 用途与返回值                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `listJobs(session)`               | 打开职位菜单，读取后关闭。返回 `{ jobs: [{ value, label, current }], selectedLabel }`。选项缺少 `value` 时，该字段为 `null`。 |
| `selectJob(session, value)`       | 按职位 `value` 精确选择并核对，返回 `{ value, label }`。                                                         |
| `selectPageScope(session, scope)` | 切换到 `recommend`、`latest` 或 `featured`，返回选中的 scope。                                                 |

职位名称不用于模糊匹配。同名职位通过 `value` 区分；页签或职位不存在时抛错。

## 筛选

`describeFilters(session)` 打开筛选面板，读取后关闭。返回：



```js
{
  pageScope: 'recommend',
  selectedJobLabel: '示例职位',
  filters: {
    degree: {
      available: true,
      options: [{ label: '本科', active: true, unlimited: false }],
      activeLabels: ['本科']
    },
    age: { available: true, min: 16, max: 46, labels: ['16', '不限'] },
    firstDegree: { available: true, checked: false }
    // 其余筛选组按同样结构返回。
  }
}
```

`applyFilters(session, filters)` 只设置传入的组，确认后重新读取并核对。返回结构与 `describeFilters` 相同。例如，只设置学历：



```js
await applyFilters(session, { degree: ['本科'] });
```

标签组包括 `school`、`degree`、`major`、`activation`、`exchangeResumeWithColleague`、`switchJobFrequency`、`experience`、`salary`、`intention`、`gender`、`recentNotView`。值为一个标签字符串或非空标签数组，必须与页面选项一致。清除条件时，传该组实际提供的 “不限” 或 “全部” 标签。

`firstDegree` 接受布尔值。`age` 接受 `{ min, max }`，两者都必须是整数，范围 16..46；46 是页面表示不限年龄的端点。选项是否可用以当前账号、职位和页签为准。

设置多个组不是事务：中途失败可能留下已修改的选项。错误中的 `confirmationAttempted` 表示尝试点击过确认，`confirmed` 表示确认后面板已关闭，`cleanupError` 记录额外的关闭失败。`confirmationAttempted: true` 时应先核对页面，不能直接重试。

## 监听列表响应

`startListCapture(session, { maxEntries: 200 })` 开始记录页面此后发起的列表请求。它只监听，不触发请求。`maxEntries` 为正整数，限制保留的请求和响应条数，较早的记录会被淘汰。

目前识别两个 GET 接口：



* `/wapi/zpjob/rec/geek/list`

* `/wapi/zpitem/web/refinedGeek/list`

返回的 capture 提供：



| 方法                                            | 含义                                         |
| --------------------------------------------- | ------------------------------------------ |
| `capture.mark()`                              | 同步返回当前请求序号，用于划定本次操作的起点。                    |
| `capture.read({ after: 0, timeoutMs: 5000 })` | 返回发起序号大于 `after` 的已捕获列表响应，按发起顺序排列。读取不清空缓存。 |
| `capture.close()`                             | 移除监听、清空缓存；session 关闭时也会清理。                 |

响应项为 `{ sequence, request: { url, params }, payload }`。`params` 是 URL 查询参数，`payload` 是去掉 `code` / `zpData` 或 `data` 外层后的原始对象，列表数组位于 `payload.geekList` 或 `payload.geeks`。

监听必须先于需要捕获的请求启动。`read()` 只等待调用时已开始读取的响应正文，不等待尚未完成的网络请求或未来请求；`timeoutMs` 是正文读取的等待上限。过早读取可能返回空数组，可在页面请求完成后再次读取。请求序号反映发起时间，晚到的旧响应不会变成本次操作的响应。

监听无法恢复启动前的请求。它不把响应自动绑定到当前职位或卡片；调用者应结合 `request.params` 和自己的操作记录选择数据。只有成功且包含列表数组的响应会进入结果，普通请求失败可能没有记录。取消、登录、验证、限流和正文读取超时会抛错。

## 读取与滚动

`readCandidates(session)` 返回 `{ pageScope, context, candidates }`。它读取当前有布局的卡片及对应 Vue 原始对象，不滚动、不请求详情，也不启动网络监听。卡片可能已加载但位于视口之外。

对应不到原始对象时，该卡片的 `raw` 为 `null`、`list.status` 为 `unavailable`。读取期间卡片发生变化时抛出 `LIST_CHANGED_DURING_READ`。字段说明见 [fields.md](fields.md)。

`scrollCandidates(session, { deltaY: 720, timeoutMs: 5000, intervalMs: 250 })` 将最后一张卡片移入视口，发送一次向下滚轮动作，再轮询卡片身份顺序。返回 `{ before, after, changed }`；`before`、`after` 是卡片引用数组，不是原始候选人数据。没有卡片时不滚动。

`deltaY` 必须为正数。`changed: false` 只表示等待期间未读到变化，不表示列表已经读完。是否继续滚动、何时重新读取、如何去重均由调用者决定。

## 读取一个人的详情



```js
const updated = await getCandidateDetail(session, candidate, {
  method: 'api', timeoutMs: 10000, intervalMs: 250
});
```

返回 candidate 的新副本，不修改输入。`method` 明确选择一种方式：



| method    | 条件与动作                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------- |
| `api`（默认） | 使用 candidate 中明确的 `securityId` 和可选 `lid`，在已登录页面发出一次详情请求。可以传 `parseGeek(raw)` 的结果，不要求该人仍有渲染的卡片。 |
| `page`    | 要求 candidate 含当前卡片的 `ref`；提供了 `context` 时一并核对。打开该卡片，等待新发起且身份相符的详情响应，再关闭详情。                     |

API 请求失败不会打开卡片，页面方式也不会先尝试 API。`timeoutMs` 控制详情请求或页面详情的等待时间，`intervalMs` 控制页面轮询间隔。这些参数限制请求或轮询阶段的等待，定位、检查及关闭详情的耗时另计。

获取成功时写入 `detail.status: 'collected'`。普通 API 失败或页面返回 `DETAIL_NOT_CAPTURED` 时，返回 `detail: { status: 'failed', method, reason }`，保留已有列表和详情。页面响应正文读取超时抛出 `NETWORK_BODY_TIMEOUT`；页面定位失败、无法关闭详情、登录、验证、限流、取消和连接异常也直接抛错。打开详情失败且随后关闭也失败时，以关闭错误为主，原始打开错误保留在 `error.cause`。

## 收藏与打招呼

`favoriteCandidate(session, candidate, options)` 收藏一个人；`greetCandidate(session, candidate, options)` 向一个人打招呼。两者都要求来自当前 `readCandidates` 的完整记录，包括 `raw`、`context`、`ref` 和 `securityId`。

每次操作重新打开详情、核验新响应、检查按钮、最多点击一次、读取结果并关闭详情。无法唯一识别控件或遇到 canvas 控件时不猜坐标。

可选参数：`detailTimeoutMs: 10000` 为打开并核验详情的等待时间；`timeoutMs: 3600` 为点击后的确认等待时间；`intervalMs: 300` 为轮询间隔。返回 `{ action: 'favorite' | 'greet', status, ... }`：



| status         | 含义                         |
| -------------- | -------------------------- |
| `performed`    | 看到了明确的已收藏或继续沟通状态。          |
| `already_done` | 操作前已处于该状态，没有再次点击。          |
| `unsupported`  | 找不到唯一、可识别的动作控件，没有点击。       |
| `unconfirmed`  | 已尝试点击，未取得确认。先核对页面结果，不直接重试。 |

详情消失不算打招呼成功。异常可能附带 `error.actionResult`，记录中断前的动作状态。

## 离线字段处理

以下函数均不连接浏览器、不修改输入：



| 函数                                                | 输入与结果                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `parseGeek(raw)`                                  | 整理一条原始列表记录，返回身份、基本信息、经历等字段；不添加 `raw`、页面 `ref` 或采集状态。                      |
| `parseResumeDetail(input)`                        | 整理原始详情，返回 `{ name, profile, expectations, skills, certifications, raw }`。 |
| `mergeCandidateDetail(candidate, input, options)` | 核对身份后合并详情，返回新的 candidate；不设置或覆盖 `detail` 采集状态。                            |
| `formatResumeApiData(input)`                      | 将详情字段排成文本，保留原文段落，不加入筛选判断。                                                 |

详情 `input` 可以是 payload，也可以是 `{ code: 0, zpData: payload }` 或 `{ code: '0', data: payload }`。无效结构抛出 `DETAIL_PAYLOAD_INVALID`；非零业务码抛出 `DETAIL_BUSINESS_ERROR` 并附 `platformCode`。明确为空的经历数组是有效数据。

`mergeCandidateDetail` 的 options 为 `{ requestSecurityId: '', source: 'provided_detail' }`。跨类型 ID 需要通过请求关联时，传实际发出该详情请求的 `securityId`；身份不匹配抛出 `CANDIDATE_IDENTITY_MISMATCH`。完整离线例子见 [fields.cjs](../examples/fields.cjs)。

## 停止与错误

页面与会话错误提供 `code`；参数错误可能是 `TypeError`、`RangeError`，底层 CDP 错误不一定有 `code`。

`BOSS_LOGIN_REQUIRED`、`BOSS_ANTIBOT_TRIGGERED`、`BOSS_RATE_LIMITED`、`BOSS_PAGE_CHECK_FAILED`、`BOSS_TARGET_CHANGED` 会停止 session；`ABORTED`、`BROWSER_DISCONNECTED`、`BROWSER_LEASE_LOST` 也不能继续使用。关闭连接，处理页面状态后重新连接。

`CANDIDATE_CONTEXT_CHANGED`、`LIST_CHANGED_DURING_READ` 等需要重新读取页面。`PAGE_GEOMETRY_INVALID` 表示 Chrome 返回的节点布局数据损坏；库不会把这类节点当成不可见，也不会据此确认详情已关闭。筛选或动作已发生后再报错时，先核对结果，再决定是否继续。