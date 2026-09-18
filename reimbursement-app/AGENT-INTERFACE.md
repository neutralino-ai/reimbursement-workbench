# Agent 接口

软件负责台账、原始文件、任务和操作历史。Codex 负责网页收集、读图/PDF、撰写 Word、转换 PDF。UI 用于查看证据和人工核验。MCP、CLI、HTTP API 使用同一业务 dispatcher，不需要在界面里模拟录入，也不需要为每笔常规操作添加人工审批。

## 云端工作区与连接配置

先配置已部署的远程 API 基址，例如 `https://api.example.com/reimbursement`。浏览器静态前端独立运行，默认本机入口是 http://127.0.0.1:4317/；Electron 客户端直接加载包内页面。远程连接失败只报错，不回退本地旧库。人工登录使用 UI 密码，首次密码设置由管理员签发的一次性设置码授权；Agent 使用独立的 Bearer 令牌，不使用用户密码，也不能以 Agent 令牌调用人工核验入口。API 地址配置、网络连通检查和实际业务验收分别进行，不能用一个检查代替其他检查。

前端与 Agent 使用不同配置：浏览器读取公开的 `frontend-config.json`（源码为 `public/frontend-config.json`），只有 `apiBaseUrl`，不含凭据；MCP/CLI 读取下面的私有 `client-connection.json`，其中包含独立令牌文件路径。网页启动脚本只提供 `dist/` 静态文件并打开本地页面；Electron 直接加载包内页面。两种前端都不读取 MCP 配置、不启动业务后端、不打开 SQLite，也不代理 API。

应用目录私有 `client-connection.json` 保存默认云端地址与本机令牌文件路径。格式如下；该配置选择数据来源，不保证公网接口已经可达：

```json
{
  "apiUrl": "https://api.example.com/reimbursement",
  "tokenFile": "/absolute/private/path/reimbursement-agent-token"
}
```

`tokenFile` 是本机私有纯文本文件，只含 64 位十六进制令牌，可有末尾换行；文件上限 4096 字节。不要把令牌内容放进配置 JSON、URL、命令行或运行日志。配置中的相对令牌路径相对于 `client-connection.json` 所在目录解析。Windows 路径可用正斜杠。

连接配置优先级为：`client-connection.json` < `REIMBURSE_API_URL` / `REIMBURSE_AGENT_TOKEN_FILE` 环境变量 < `--api-url` / `--token-file` CLI 参数。`--local` 忽略远程配置和上述两个环境变量，明确使用本地数据。默认远程已配置时，仅传 `--data-dir` 或 `--legacy-dir` 会报错，避免误把旧备份操作发送到云端。

远程模式只访问云端 API，不创建或打开本地 SQLite。所有命令发送到服务基址下的 `/api/agent/commands`，保留 `operationId`、`baseVersion`、Agent 身份和业务返回值。连接要求 HTTPS；仅 loopback 测试或 SSH 隧道允许 HTTP。传输不跟随重定向，地址不能包含账户、查询参数或片段。网络失败时先查询结果或复用原命令重试，不更换同一次操作的 `operationId`。

## MCP

需要 Node.js 24 或更新版本，并在应用目录安装依赖。MCP 使用官方 TypeScript SDK 的 stdio transport。配置远程连接后，本机无需启动 UI 服务；未配置远程连接时仍可直接运行本地模式。启动后 stdout 专用于 MCP 消息；不要在前面加会输出状态文字的包装命令。

```text
node /absolute/path/reimbursement-app/server/mcp.mjs
```

MCP 客户端配置示例（路径需要替换成实际路径）：

```json
{
  "mcpServers": {
    "reimbursement-workbench": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/reimbursement-app/server/mcp.mjs"
      ]
    }
  }
}
```

Windows JSON 路径可用正斜杠，例如 `C:/projects/reimbursement-app/server/mcp.mjs`。上面是通用 MCP 客户端配置格式；不同宿主的配置文件格式可能不同。本项目不自动修改用户全局 MCP 配置。已经开始的 Agent 会话未必能即时发现新 MCP 服务；无法加载时可使用下述 CLI。

## CLI 与同等业务能力

从应用目录执行：

```text
node scripts/agent-cli.mjs --catalog
node scripts/agent-cli.mjs --file command.json
node scripts/agent-cli.mjs --api-url https://api.example.com/reimbursement --token-file /absolute/private/path/reimbursement-agent-token --file command.json
node scripts/agent-cli.mjs --local --data-dir /absolute/path/to/old-backup --actor-id codex --file command.json
```

`command.json` 示例：

```json
{"type":"tasks.list","payload":{}}
```

以 `--catalog` 返回的 schema 为准。查询使用 `payload`；写入还需要稳定的 `operationId`，更新已有资源需提供相应版本。重试复用同一 operationId。金额使用十进制字符串，不传浮点数。导入文件的 `localPath` 始终指运行 Codex 的本机绝对路径，上限 20 MiB；远程模式把原始字节上传到云端，本地模式复制到本地数据目录，均保留源文件并计算哈希。错误输出到 stderr，并设置非零退出码。写操作成功时业务结果在 `data` 字段，外层 `replayed` 表示幂等重放；只读查询直接返回工作区或待办对象。混合年份/供应商的 ARP 使用 `reservedCNY` 与 `reserveReason` 预留范围外占用，原始审批总額不变。

云端返回的 `material.href` 已包含 `/reimbursement` 前缀，直接使用该路径，不要再次添加前缀。用户在已登录的浏览器中查看或下载；Agent 读取原件时使用相同独立令牌放在 HTTP `Authorization` 请求头，不能附在 URL 查询参数中。当前 MCP/CLI 命令目录没有独立的原件下载工具。

可用业务工具包括工作台查询、待办查询、操作历史、材料导入、规则依据登记、账单登记、业务事实更新、ARP 登记、审批金额关联及移除、生成文档登记。工具 schema 和业务验证来自 `server/agent.mjs`。MCP/CLI 身份固定为 agent；人工核验只能通过应用人工核验入口执行，调用参数不能伪造 human 身份。

## 规则依据原件

制度与发票一样保存原件：先通过 `material.import` 导入 `role: "policy"` 的 PDF，再以 `policy.register` 登记 `{id,title,versionLabel,materialID,status,note,clauses}`。新依据使用 `baseVersion: "new"`，维护已有依据使用 `workspace.policies` 中的当前版本。`status` 为 `active`、`reference` 或 `superseded`；允许多份文件分别适用于不同事项。每条引用使用 `{id,topic,section,pdfPage,printedPage?,quote,interpretation,scope}`，把条款原文、解释和适用范围分开。原文与页码由 Agent 阅读原 PDF 核实，接口不会自动判断某条规则是否适用于订阅。

`workspace.policies` 返回规则元数据、版本、原件链接和完整性，最近更新的在前。`history.list` 支持 `entityType: "policy"`。打开原件使用 `material.href`，下载同一份原件使用 `material.href + "?download=1"`；原件缺失或哈希变化时拒绝下载。规则选择及条款维护不会改写已有申报、获批金额、付款或汇率事实。

UI 的 `POST /api/policies/upload` 接收 `{filename,contentBase64,title,versionLabel,note,operationId}`，先保存为 `reference`。`POST /api/policies/:id` 接收 `{title,versionLabel,materialID,status,note,clauses,baseVersion,operationId}`，可维护标题、版本、依据状态和条款。这些路径相对于应用基址；两者只接受同源操作，云端还要求已登录的用户会话，拒绝 Authorization header，并保留人工身份。Agent 使用自己的 MCP/API 命令。返回均为 `{operationId,type,replayed,data}`。细节见 [API 说明](server/AGENT-API.md)。

用户已确定汇率依据的优先顺序：有适用的明确制度条款时按条款执行；没有条款时沿用同类 GPT 订阅成功获批的先例，使用中国银行“中行折算价”，日期取用户指定的 invoice 日期并留存中行官网截图。不能因制度未写明而再要求财务确认或阻塞新申请包，也不能把先例写成制度原文。设备计价、出访等特定事项条款不能直接套用于在线订阅。价格口径已确定不代表实际付款或每笔最终申报金额已核实，仍需各自证据。保留既有申报和获批金额。新要求若改变日期或价格类别，需要调整接口支持后据实登记，不能把其他报价冒记为中行折算价。

## 随附 Skill

入口是 [agent-tools/reimbursement-workflow/SKILL.md](agent-tools/reimbursement-workflow/SKILL.md)。它告诉 Codex 如何组合自己的浏览器、PDF、图片和 Word 能力与应用工具。应用不内置网页登录器；已上传材料可交后端 DeepSeek 核验及模板生成服务处理，见 [自动化 API](AUTOMATION.md)。Skill 已随应用提供，未自动安装到用户全局技能目录；可以在对话中指定该文件使用，或按宿主支持的方式安装。

## 本地备份与边界

显式使用 `--local` 时，默认数据目录为应用的 `data/`，也可用 `REIMBURSE_DATA_DIR` 或 `--data-dir` 指定。访问迁移前旧备份示例：`node server/mcp.mjs --local --data-dir /absolute/path/to/old-backup`。这访问的是独立旧副本，修改不会同步到云端。MCP 与单独启动的本地 API 后端指向同一目录时共享该本地数据；默认静态前端不访问数据库。MCP 本身不开放网络端口。`--legacy-dir` 仅用于明确指定的历史导入，MCP/CLI 不自动扫描电脑寻找旧数据。

云端访问是多设备操作同一份台账，不是本地与远端的双向同步；离线写入与自动合并未实现。网页登录收集或向 ARP 自动提交仍由 Agent 能力和用户授权决定。同期 UI 服务若需观察 MCP 写入，刷新或重新查询工作台即可。应用会保留业务变更与 agent 身份，生成文档不会自动提交报销。有效ARP依据明确确认该笔费用已进入财务审核时，前四步自动完成，仅最后一步“财务审核”待完成，获批金额不变。全部审核通过且足额对应后五步全部完成，按用户规则默认到账、记为已报销；不再要求独立银行核对。单号、部门审核或部分批准本身不足以推定财务审核状态，依据失效后重新计算；推定结果不改写原件、人工核验或手动交付历史。

实现参考：[官方 SDK v1 server 文档](https://ts.sdk.modelcontextprotocol.io/server) 和 [官方 SDK 版本记录](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0)。集成测试使用 SDK Client 启动真实 stdio 子进程并执行握手、工具列表和工具调用。
