# 自动核验与申报材料

客户端只调用远程 API。服务器保存原件、核验任务和文档；静态网页和 Electron 均不运行本地业务后端。隔离测试使用新建临时目录，不接触迁移前副本。

## 使用

1. 主页面打开 **AI 设置**，填写或更新 DeepSeek API Key，检验连接，再保存并启用自动核验。留空保留已保存密钥。密钥通过 HTTPS 发送、在服务器以 AES-256-GCM 加密保存；界面只返回末四位。主密钥与数据均须纳入私有服务器备份。
2. 上传发票和单笔付款截图。服务器每五秒检查新材料，依次读取发票及付款图片，按精确金额、币种、发票编号、日期、商户与结算状态核验。多个候选文件需在第二列选定原件；不匹配、缺字段、失败或重启中断不会自动重试计费，可手动重新核验。
3. 打开该笔第三列 **申报材料**，填写用途原文或上传用途截图，点击 **DeepSeek 整理说明**。语音使用系统听写直接填入文本框：Windows Win+H、Mac 已配置的听写快捷键或手机键盘麦克风。本版没有录音上传和语音转写服务。
4. 检查并修改用途，确认显示的人民币金额，生成 PDF 草稿。系统采用已登记的发票日中行折算价与官方截图，不让模型计算金额，也不覆盖不同的既有申报金额。
5. 查看完整 PDF，确认后标记材料备妥。主页面 **申报 ZIP** 可选择多笔，每笔一份整合 PDF；说明 Word 单独下载保留。交财务和财务审核仍按原流程记录。

模型使用官方 `deepseek-flash` Responses API，`stream:false`、`store:false`。原始凭证与用途附件会发送给所配置服务进行识别。模型先读取原图，不接收待匹配金额；程序再比较提取字段。结论表示材料一致性，不鉴定截图真实性。相同付款文件跨台账会被拦截，不同图片中重复的真实交易仍可能需人工判断。

自动核验写入 Agent 身份，不修改人工核验。进入财务审核或已全部通过的历史费用跳过前序核验和重建。原件、用途、金额或记录版本变化会使旧材料过期；旧 ZIP 不再显示为可提交的下载结果。服务须单实例运行，持久化队列使用私有 JSON；重启中的任务保留为中断，避免重复请求模型。

## 文档格式

每份 PDF 包含情况说明、发票、付款截图、汇率截图及选用的用途附件。模板固定，模型只提供文字，不生成代码、HTML 或模板。生成前逐份校验原件 SHA256，保存附件页码、来源记录版本与模板版本。每页渲染检查后登记为草稿，最终内容由用户检查。

PDF 嵌入随源码提供、按 SIL OFL 分发的 Noto Sans SC 字体；原 PDF 附件按完整页面渲染为图片副本后编排，以减少客户端字体依赖。原文件始终另存不变，PDF 中的附件副本不等于供应商原件。ZIP 使用 ASCII 文件名减少解压编码问题。Word 可编辑但不嵌入字体，版式可能因客户端字体替换不同；交财务以 PDF 为准。测试覆盖 PDFium/Windows 渲染、字体嵌入及中文文本，不能等同于所有 Mac 软件的实机验证。

目前发票识别最多八页，单笔付款凭证必须单页，单个用途附件最多八页、合计十二页，最多五份用途附件。整合时每份原件最多十二页，ZIP 最多三十份 PDF，生成文件导入沿用 20 MiB 上限。PNG/JPEG/WebP 与 PDF 可用；HEIC 应先转成图片副本再上传，无法读取时任务报错，不会截断或猜测。

## 后端部署

Node.js 24 以上；独立 Python 3.12 虚拟环境安装锁定依赖：

```sh
python3 -m venv /opt/reimbursement/document-runtime
/opt/reimbursement/document-runtime/bin/pip install -r server/document-requirements.txt
```

设置 `REIMBURSE_PYTHON=/opt/reimbursement/document-runtime/bin/python`，部署 `server/` 全部模块和 `server/assets/fonts/`。工作文件在 `REIMBURSE_DATA_DIR/automation/work`，不得放入公开静态目录。服务账户对数据目录可写，对应用代码只读。完整备份包含数据库、原件及 `automation/`（含加密主密钥）。本服务不需要启动原网站或打开 80/443。

## Agent HTTP API

以下路径相对于配置的 API 基址。Agent 用独立 `Authorization: Bearer …`；客户端用 `Authorization: Session …`。不把密钥、用户会话或令牌放入 URL。HTTP 自动化服务是现有 MCP/CLI 的补充；MCP catalog 尚未增加自动化命令。

`GET /api/agent/automation` 返回已遮蔽设置、任务、用途版本；`GET /api/agent/workspace` 返回费用及最新 `aiReview`。自动化写请求返回任务或资源本身，区别于原业务命令的 `data` 包装。写入需稳定 `operationId`，重复请求复用同一请求体。

| POST /api/agent/automation/… | 字段 |
| --- | --- |
| review | recordID, baseVersion（费用版本）, materialIDs（可选，明确一份发票和一份付款原件） |
| purpose | recordID, recordVersion, baseVersion（用途版本，初次为 new）, text, sourceMaterialIDs（purposeEvidence 原件） |
| purpose-draft | recordID, purposeVersion |
| packet | recordID, baseVersion, purposeVersion, purpose（用户提供或确认的真实文字）, claimedCNY, confirmed:true |
| zip | documentIDs（已由用户确认备妥、未过期的文档） |

新用途附件先以现有 `material.import` 的 `purposeEvidence` 角色保存。先读取当前版本、核验结果、有效汇率及依据，再生成；不要用测试用途登记真实申报材料。

仅人工 Session 可调用 `/api/automation/settings`（baseVersion, enabled, apiKey 可选）、`/test`（apiKey 可选）、`/approve-packet`（operationId, jobID, confirmed:true）。对应 Agent 路径返回 403。其他操作客户端使用相同名称的 `/api/automation/…` 路径。长任务立即返回 queued，通过 GET 轮询；终态包括 matched、needs_review、mismatch、completed、failed、stale、interrupted。
