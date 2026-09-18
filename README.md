# boss-automation

`boss-automation` 提供了一套可用的代码框架，为日常使用 BOSS 直聘的招聘 HR 提供流程自动化操作的开发底座。

我们的项目由多个可以单独调用的 Node.js 模块组成，它们的功能涵盖：连接浏览器、切换职位和页签、应用筛选、读取列表原始数据、获取候选人详情、整理字段，以及执行收藏或打招呼等明确动作。开发者可以按自己的流程组合这些模块，也可以让自己的 Agent 直接阅读代码和测试，再接入自己的工具。

## 我们的技术选型思路

常见的招聘平台自动化工作流中，Agent 往往会逐个打开候选人详情，截图、滚动，再通过 OCR 或视觉模型还原简历。在实际开发中，我们发现 BOSS 页面本身已经持有用于渲染页面的结构化对象，也会发出列表和详情请求。直接读取这些数据，能够保留原始字段、数组结构和候选人标识，省去截图识别，也更容易写测试和排查错配。

不过，列表数据并不等于一个人选的完整简历。本项目把两者分开处理：



1. 读取当前页面卡片及对应的列表原始对象，或监听页面此后发出的列表响应。

2. 需要完整资料时，再获取单个候选人的详情。

3. 使用同类型 ID 和实际详情请求的 `securityId` 核验归属，无法确认时则不合并。

我们认为：在页面上的探索可以交给 Agent ，但对于海量、高频和重复的招聘动作来说，如果某个步骤已经跑通，那么更适合将它固定成代码，加以接口。在本项目中，我们封装了每个单步操作，如筛选、信息采集等动作，开发者可以基于各种动作的组合搭配，自行编排工作流。

## 包含的操作



```
浏览器会话       connect

职位与页签       listJobs / selectJob / selectPageScope

筛选             describeFilters / applyFilters

列表             startListCapture / readCandidates / scrollCandidates

详情             getCandidateDetail

页面动作         favoriteCandidate / greetCandidate

离线字段处理     parseGeek / parseResumeDetail / mergeCandidateDetail / formatResumeApiData
```

浏览器会话包含本机端口互斥、取消、连接断开检测和清理。页面动作会在点击前重新核对候选人和详情，最多点击一次；没有明确控件时不执行；点击后无法取得成功信号时返回 unconfirmed，不会自动重试。

## 使用



```
npm ci --ignore-scripts

npm test
```

完整接口见 [API 文档](docs/api.md)，字段结构见 [字段文档](docs/fields.md)，可运行示例见 [examples/read-list.cjs](examples/read-list.cjs)。

## 项目范围和边界

我们的项目目前仅聚焦推荐页相关的能力，如果 BOSS 直聘页面结构或接口发生变化，选择器和字段映射可能需要更新。

本项目不是一个招聘平台产品或招聘看板，而是面向 BOSS 直聘的自动化开发底座。考虑到不同团队和 HR 的流程、标准与结果需求并不相同，我们只提供可组合的页面操作和数据获取能力，不预设开发者的上层工作流。开发者与 Agent 可以在现有的单步操作之上，结合自己的招聘风格和需求，构建自己的招聘工具，继续自行扩展开发及编排更多的自动化操作。

示例 `examples/read-list.cjs` 会把读取结果写到标准输出，其中可能包含候选人资料。是否保存、脱敏或继续处理由调用者负责。

## 致谢与声明

本项目采用 [MIT License](LICENSE)。参考项目、BOSS 直聘平台说明和运行依赖署名见 [NOTICE.md](NOTICE.md)。
