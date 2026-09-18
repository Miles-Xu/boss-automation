# 字段

`readCandidates()` 返回 `{ pageScope, context, candidates }`。一条 candidate 包含：

| 字段 | 含义 |
| --- | --- |
| `ref` | 卡片页签、页面顺序、姓名和带类型的 DOM 身份；操作时重新定位，旧 nodeId 不直接复用 |
| `context` | 读取时的职位、页签和筛选界面信息；用于发现页面变化，不是可重放的请求参数 |
| `raw` | 原始列表对象；对应不到时为 `null` |
| `list` | `status: collected / unavailable`，附来源或缺失原因 |
| `listIdentity` | 按类型区分的 `geekId`、`encryptGeekId`、`encryptUserId` 数组 |
| `securityId`、`lid` | 列表提供的详情请求参数；不解码、不生成 |
| `profile` | `workHistory`、`education`、`projects` 三组整理后的经历 |
| `detail` | 本次详情获取状态；初始为 `not_requested` |
| `resumeDetail` | 获取成功的原始详情，不含外层响应的 `code` / `zpData` |
| `resumeText` | 从详情字段排版的文本，保留段落，不包含筛选判断 |

归一化后的顶层 `geekId` 是卡片查询键，不一定是 BOSS 原始数值 `geekId`。需要辨别 ID 类型时使用 `listIdentity` 和 `raw`。

## 列表与详情

常见列表结构是 `{ geekId, haveChatted, geekCard: {...} }`，也兼容字段直接位于顶层的记录。推荐列表中的 `geekWorks`、`geekEdus` 可能只是摘要；精选列表可只有 `encryptUserId`，经历字段为 `null`。

详情通常位于 `zpData.geekDetail`，也兼容 `geekDetailInfo`、`detail` 或直接对象。详情获取函数去掉 `zpData` 包装，保留其内部对象到 `resumeDetail`。

| 信息 | 列表中的常见字段 | 详情中的常见字段 | 整理后 |
| --- | --- | --- | --- |
| 姓名 | `geekCard.geekName` | `geekBaseInfo.name` | `name` |
| 工作 | `geekCard.geekWorks` / `workList` | `geekWorkExpList` | `profile.workHistory` |
| 教育 | `geekCard.geekEdus` | `geekEduExpList` | `profile.education` |
| 项目 | 可能缺失 | `geekProjExpList` | `profile.projects` |
| 求职期望 | `expectPositionName` / `expectLocationName` / `salary` | `geekExpectList` / `geekExpPosList` | `expectations` |
| 优势 | `geekDesc` | `geekAdvantage` | `advantage` |
| 技能标签 | `geekSkillList` 等 | `geekSkillList` | `skills` |
| 证书 | 可能缺失 | `geekCertificationList` | `certifications` |

工作经历保留公司、职位、时间、职责、成果、补充描述和标签。`responsibility` 与 `workContent`、`workPerformance` 与 `performance` 等并列原文字段合并时使用换行，不只取其中一段。HTML 标签被移除，实体解码一次；已经整理过的文本不会再次按 HTML 处理，因此 `std::vector<int>` 等字面内容不会在重复合并时丢失。

`profile` 不覆盖所有字段。部门 `geekWorkExpList[].department`、专业技能长文 `professionalSkill`、奖项 `geekHonorList`、项目 URL 等仍在 `resumeDetail` 中。完整别名及映射见 [candidate-profile.cjs](../src/candidate-profile.cjs)，可运行样本见 [fixtures/candidates.cjs](../fixtures/candidates.cjs)。样本中的人名、组织、ID 和正文均为虚构。

## 空值与失败

```js
{ status: 'not_requested' }
{ status: 'collected', source: 'api_detail_fetch',
  sections: { work: 'present', education: 'empty', projects: 'missing' } }
{ status: 'failed', method: 'api', reason: 'DETAIL_HTTP_503' }
{ status: 'failed', method: 'page', reason: 'DETAIL_NOT_CAPTURED' }
```

`sections` 只描述本次响应：`present` 为非空数组，`empty` 为明确空数组，`missing` 为缺字段或非数组。它不证明页面已经披露了全部资料。

`profile` 中的空数组可能来自缺字段、`null` 或源数组为空，不能据此判断“这个人没有经历”。详情补全也不会因为空数组删除列表中已有的经历。判断获取结果先看 `detail.status`，核对字段是否存在再看 `resumeDetail`。

对已有详情的 candidate 再次获取失败时，返回副本会保留旧 `resumeDetail` 和 `profile`，本次 `detail.status` 为 `failed`。旧详情仍在不表示这次请求成功。

## 身份对应

名称和列表下标都不能作为合并依据。同名人选很常见，同一次滚动前后也可能替换卡片。

列表与详情同时给出同类型 ID 时必须一致。精选列表的 `encryptUserId` 不能直接当作详情的 `encryptGeekId`；这类情况使用实际发出的详情请求 `securityId` 关联，即使响应返回的新 `securityId` 已变化。无法确认归属的响应不写入 candidate。

`securityId` 只读取明确的同名字段，不根据字符串长度推测，也不从其他 ID 生成。

## 单独处理原始数据

`startListCapture` 返回监听句柄，其 `capture.read()` 返回列表响应记录数组。单条记录为：

```js
{
  sequence: 1,
  request: { url: 'https://www.zhipin.com/wapi/zpjob/rec/geek/list', params: {} },
  payload: { geekList: [/* 原始列表记录 */] }
}
```

`parseGeek(raw)` 接受其中一条记录，返回整理后的身份和资料，不附带页面引用或采集状态。需要保留原始记录时，可使用 `{ ...parseGeek(raw), raw }`。

`parseResumeDetail(input)` 返回 `{ name, profile, expectations, skills, certifications, raw }`；其中 `raw` 是去掉响应外层后的详情副本。`mergeCandidateDetail(candidate, input)` 核对身份并补入 `resumeDetail`、`resumeText` 和整理后的字段，但保留 candidate 原有的 `detail` 状态。纯数据合并不代表进行过一次浏览器采集。
