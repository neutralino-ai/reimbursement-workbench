# 报销工作台

用于订阅费用报销的跨平台工作台：集中保存发票、付款凭证、汇率依据和申请包，用五阶段流程展示每笔费用的状态。当前流程面向 GPT/Codex 订阅，其他供应商可在后续扩展。

React + TypeScript 前端在本机运行，可作为静态网页，也可用 Electron 打包为 Windows/macOS 应用。前端通过 HTTPS 直接访问远程 Node.js 24 + SQLite API；桌面客户端不包含业务后端、数据库或 Agent 令牌。

Agent 负责网页登录与材料下载、图片/PDF 阅读、Word 编写和 PDF 转换，通过 MCP/API/CLI 登记原件与业务事实。用户在界面查看依据、核验信息和维护交财务状态。

## 流程

| 收集原始材料 | 核验实付款 | 准备申报材料 | 交财务秘书 | 财务审核 |
| --- | --- | --- | --- | --- |
| 发票与采集时间 | 付款截图或账单 | 情况说明、发票、付款及汇率依据 | 文件交付进度 | 审核状态与对应金额 |

首页按发票日期从新到旧排列，显示每一步的完成数和逐笔状态，点击状态可查看原件。有效财务依据确认费用已进入财务审核时，前四步自动完成；全部审核通过且金额足额对应后，五步完成，按本项目业务规则默认到账，不另外核对银行流水。自动完成不会补造原件或人工核验记录。

## 源码与运行

代码位于 [`reimbursement-app/`](reimbursement-app/README.md)，需要 Node.js 24 或更高版本及 pnpm。

```sh
cd reimbursement-app
pnpm install --frozen-lockfile
```

将 `public/frontend-config.json` 的 `apiBaseUrl` 设置为已部署的远程服务地址，例如 `https://api.example.com/reimbursement`，然后启动静态前端：

```sh
pnpm build
pnpm start
```

浏览器打开 `http://127.0.0.1:4317/`。该服务只提供静态页面，不启动本地业务后端或代理 API。桌面运行、打包、后端配置与测试命令见[应用说明](reimbursement-app/README.md)。

Agent 入口见 [MCP/CLI 接口](reimbursement-app/AGENT-INTERFACE.md)和[报销流程 Skill](reimbursement-app/agent-tools/reimbursement-workflow/SKILL.md)。

## 范围与数据

- 已实现共享远程台账、原件存储、版本冲突检查、幂等写入与操作历史；尚未实现离线写入或双向同步。
- Windows 客户端已验证启动，Mac 构建包尚未签名、公证或完成 Mac 实机验收。真实账户登录、附件预览与完整报销流程需在实际部署环境验收。
- 本仓库保存应用源码与通用说明，不包含私人报销材料、数据库、令牌、登录会话、部署审计或安装包。
- 数据库与原件应一起备份；工作区 JSON 导出不包含附件，不能替代完整备份。
