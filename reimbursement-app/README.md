# 订阅报销工作台

React + TypeScript 界面与 Node.js 24 + SQLite API 分离。前端在本机运行，通过 HTTPS 直接访问远程台账，可作为静态网页或打包为 Electron Windows/macOS 应用。

iOS 使用 Capacitor 复用同一前端，增加本机语音听写、PDF 系统预览与 ZIP/Word“存储到文件”。Mac 上的 Xcode 配置和真机测试步骤见 [iOS 客户端](IOS.md)。

客户端只包含界面和桌面运行环境，不启动本地业务后端、打开业务数据库或代理 API。远程后端保存原件、事实、来源、版本和核验记录。当前业务流程面向 GPT/Codex 订阅，其他供应商可后续扩展。

## 功能与业务规则

v0.3.0 增加服务器自动核验、客户端 DeepSeek 密钥设置与连接测试、用途整理、中文 PDF/Word 生成，以及多份 PDF 打包 ZIP。使用步骤、运行依赖与版本保护见 [自动核验和申报材料](AUTOMATION.md)。桌面“检查更新”从 GitHub Release 获取当前平台新版。

首页是一张按发票日期从新到旧排列的表格，上方显示各步骤完成数，每笔费用有五个状态列；点击状态可查看原件或维护该步骤。

| 步骤 | 内容 |
| --- | --- |
| 收集原始材料 | 发票原件、来源与实际采集时间；超出采集周期时提示更新。 |
| 核验实付款 | 收集付款截图或账单，保留历史凭证，区分候选匹配与已确认事实。 |
| 准备申报材料 | Agent 编写情况说明，保留 Word，并将说明、发票、付款凭证和汇率截图整合为交财务 PDF。 |
| 交财务秘书 | 显示已交文件数与总数，由用户维护已交、未交或待确认。 |
| 财务审核 | 依据财务系统记录核对审核阶段、费用对应关系与金额。 |

存在有效依据确认费用已进入财务审核时，前四步自动完成，仅财务审核待完成，不增加获批金额。已提交、全部审核通过且足额对应到该笔费用后，五步全部完成，按本项目确认的业务规则默认银行到账，不额外核对银行流水。仅有提交单号、部门审核或部分批准，不能推定已进入财务审核。依据或对应关系失效后重新计算状态，原件与人工核验历史始终保留，不补造附件或历史操作。

原币、人民币申报金额与获批金额分别记录。财务单据包含范围外费用时，预留对应额度以防重复分摊。制度依据支持保存原始文件、版本、页码、条文和解释；官方原件、网页转录与 Agent 生成说明分别标记。

汇率先按适用的明确制度条款处理；没有适用条款时，当前订阅流程沿用用户确认的成功报销先例，采用 invoice 日期的中国银行“中行折算价”。保存官网截图及报价单位，不以新汇率覆盖已确认的历史申报或获批金额。已经进入财务审核的历史记录不要求重建申请包。

其他功能包括材料哈希校验与去重、Apple Card CSV 候选关联、文档来源变更提示、版本冲突检查、操作历史和工作区 JSON 导出。完整备份需包含数据库与原件目录；JSON 导出不包含附件。

## Agent 接口

浏览器登录与网站采集由外部 Agent 完成。后端可调用用户配置的 DeepSeek 识别已上传材料并整理用途，由确定性的文档模板生成 PDF/Word；外部 Agent 仍可通过 MCP/API/CLI 导入和登记材料。用户通过界面核验和纠正，Agent 不能冒充用户完成人工核验。

- MCP：`node server/mcp.mjs`
- 查看工具：`node scripts/agent-cli.mjs --catalog`
- 执行命令：`node scripts/agent-cli.mjs --file command.json`
- 接口文档：[AGENT-INTERFACE.md](AGENT-INTERFACE.md)
- 工作流程：[reimbursement-workflow Skill](agent-tools/reimbursement-workflow/SKILL.md)
- HTTP 规范：[server/AGENT-API.md](server/AGENT-API.md)

MCP/CLI 从应用目录的私有 `client-connection.json` 读取远程连接。示例：

```json
{
  "apiUrl": "https://api.example.com/reimbursement",
  "tokenFile": "/absolute/private/path/agent-token"
}
```

令牌放在仅当前用户可读取的文件中，配置只保存路径。相对路径按配置文件所在目录解析。环境变量 `REIMBURSE_API_URL`、`REIMBURSE_AGENT_TOKEN_FILE` 可覆盖配置，CLI 参数 `--api-url`、`--token-file` 优先级更高。连接配置与令牌均不提交版本库。

先查询工作区与待办，再执行操作。写入使用稳定的 `operationId` 和当前 `baseVersion`，不确定是否成功时复用原命令重试。远程模式下 `material.import` 的 `localPath` 指 Agent 电脑上的文件，原件通过 HTTPS 上传；服务端不读取客户端提供的本机路径。

远程连接失败会报错，不自动回退本地数据库。只有明确维护独立本地数据时才使用 `--local --data-dir <absolute-path>`。这不属于正常桌面运行方式，也不提供本地与远程数据合并。

## 静态前端开发

需要 Node.js 24 或更高版本及 pnpm。以下命令在本目录执行：

```sh
pnpm install --frozen-lockfile
```

先修改公开配置 `public/frontend-config.json`：

```json
{"apiBaseUrl":"https://api.example.com/reimbursement"}
```

该文件只包含公开 API 地址，不包含密码或令牌，与 Agent 的私有连接配置独立。地址应指向应用挂载路径，不额外附加 `/api`。

```sh
pnpm build
pnpm start
```

`pnpm build` 使用 `--base=/` 生成 `dist/`。`pnpm start` 和 `pnpm dev` 均只在 `http://127.0.0.1:4317/` 提供已构建页面；`dev` 不启用热更新，修改源码或连接配置后需重新构建。修改 API 地址后重启静态服务，以更新 CSP 允许的连接地址。静态服务拒绝 API 路径，不读取业务数据库。

Windows 可运行 `start-windows.cmd`，macOS 可运行 `sh start-macos.command`，启动静态服务并打开浏览器。若端口被其他程序占用，启动器会报错而不会停止该程序。前端能打开与远程 API 能访问是两个独立的检查项。

## 桌面运行与打包

安装依赖后，若 Electron 运行文件尚未安装，可执行：

```sh
node node_modules/electron/install.js
pnpm desktop:dev
```

桌面界面从内置的 `reimbursement://app` 加载，不启动本地 HTTP 服务。“服务器连接”可覆盖包内默认 API 地址。保存后重新加载并退出旧会话。用户通过管理员签发的一次性设置凭据初始化密码；Agent 使用独立令牌。

```sh
pnpm desktop:win
pnpm desktop:mac
pnpm desktop:mac:intel
```

Windows 命令生成便携 EXE。两个 Mac 命令分别生成 Apple Silicon 与 Intel 包，应在 Mac 构建环境运行。构建输出位于工作区 `output/desktop/<version>/`，通过明确的文件清单只打包前端与桌面代码，不包含业务数据、后端或令牌。Linux 交叉打包脚本 `scripts/package-mac-linux.mjs` 可生成未签名的 Mac 测试包，需要另备其指定的打包依赖。

客户端保持沙盒、上下文隔离与 HTTPS 证书校验启用。桌面连接设置仅保存 API 地址，登录会话保存在内存会话中，关闭应用后重新登录。Agent 凭据不进入桌面客户端。

## 远程后端

后端在服务器独立运行，采用 HTTPS 反向代理。以下为服务器端配置示例，不是在客户端启动本地业务服务：

```sh
export PORT=4320
export REIMBURSE_DATA_DIR=/var/lib/reimbursement
export REIMBURSE_PUBLIC_URL=https://api.example.com/reimbursement
export REIMBURSE_API_ONLY=1
export REIMBURSE_FRONTEND_ORIGINS='reimbursement://app,http://127.0.0.1:4317,http://localhost:4317'
pnpm backend
```

Node 服务监听 loopback，HTTPS 代理应保留应用路径前缀与完整公开 Host。`REIMBURSE_API_ONLY=1` 使服务只提供 API，不托管前端。后端仅允许显式列出的前端 Origin，不放行任意来源或 `null` Origin。

人工登录使用独立的密码与 Session 鉴权，Agent 使用 Bearer 令牌；两种身份不能互换。管理员通过 `scripts/auth-admin.mjs` 签发一次性初始化凭据，用户自行设置密码。服务器的数据目录、私有配置、备份和 TLS 凭据应独立于源码仓库管理。

## 检查与限制

```sh
pnpm typecheck
pnpm test
pnpm build
```

测试覆盖 MCP 握手与调用、远程 MCP/CLI、身份隔离、幂等重试、版本冲突、材料完整性、金额分摊、文档来源变化与流程状态。测试使用显式临时数据目录或模拟远程接口，不以真实财务数据作为测试夹具。

已验证 Windows 桌面启动、包内文件检查和使用合成数据的流程界面；这些检查不替代实际部署中的人工登录、PDF 预览与下载、完整报销业务验收。Mac 包尚未签名、公证，也未完成 Mac 实机运行验收；Windows 测试包亦未签名。

目前共享的是一份远程台账。虽已提供版本与操作历史，尚未实现离线写入或双向同步，也不内置网站自动采集或自动对外提交。手机屏幕适配不等于 iOS 原生应用或手机完整流程已经验收。

不要提交私人原件、数据库、银行流水、登录会话、连接配置、Agent 令牌、部署审计或生成申请包。源码仓库、应用发行包与财务数据分别维护。
