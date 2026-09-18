# 付款凭证预审：本地试验

本文保留独立 CLI 的使用方法。v0.3.0 已提供服务器持久化自动核验队列与客户端设置，见 [AUTOMATION.md](AUTOMATION.md)。下述 CLI 仍只输出本地结果；后端服务在字段一致后可用 Agent 身份标记付款核验通过，保持人工核验、财务审批独立。

使用 DeepSeek 官方 `deepseek-flash`，`POST /responses`，`stream:false`、`reasoning.effort:none`，图片输入和 JSON Schema 输出。模型只读取截图，不接收待匹配发票金额/日期，避免照抄预期答案。程序随后精确比对商户、原币金额、币种、交易日期、结算状态和本次输入中的重复图片。只接受明确的单笔付款；缺字段、多笔交易、退款/撤销/待结算、日期不同、模型返回不完整或格式错误均不能通过。首版面向 OpenAI/ChatGPT 商户。

结果 `matched` 仅表示材料字段一致；截图不能独立证明银行交易真实性，也不代表人工确认或财务审批。当前没有跨全台账、跨不同图片的交易身份查重。该试验不等同于已完成准确率评估。

## 使用

密钥只保存在 Git 忽略的私有文件，内容为 `DEEPSEEK_API_KEY=...`。不写入客户端、源码或命令行。

先通过云端 MCP/API 查询 `workspace.get`、`tasks.list`，下载明确授权的付款图片并校验 SHA256。准备私有 JSON 数组，每项包含 `localPath`（图片绝对路径）、`record`（id、version、invoiceNumber、date、amount、currency）和 `material`（id、sha256）。不要把真实输入清单提交 Git。

```sh
node scripts/review-payment.mjs --input /private/inputs.json --env-file /private/env.txt --output-dir /private/results
```

支持 PNG/JPEG/WebP，一批最多十张。PDF/HEIC 需先在 Agent 侧转成图片副本，保留原件。CLI 保存字段、可见原文依据、规则判断、原件哈希、记录版本、模型、提示词版本、耗时和 token 用量；不会保存密钥或浏览器会话。API 失败不自动重试；非 200 响应不算审核成功。后端自动核验另有任务持久化、全台账相同付款图片检测和原件/记录版本失效保护；不同图片中的同一真实交易仍可能需要人工辨别。
