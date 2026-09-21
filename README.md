# 报销工作台客户端

公开的 React + TypeScript 前端、Electron 桌面客户端和 iOS 客户端。客户端通过 HTTPS 连接独立部署的报销 API，不包含业务数据库、原件、登录会话、Agent token 或服务端源码。

## 开发

需要 Node.js 24 或更高版本及 pnpm：

```sh
cd reimbursement-app
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

公开连接配置位于 `reimbursement-app/public/frontend-config.json`，只包含 API 地址。服务端不在本仓库中；客户端只消费已部署的 HTTPS API。

申报材料以 ZIP 交付：报销说明 PDF 内保留付款、汇率查询和科研用途截图，发票原件单独放在 ZIP 中。支持单笔与多笔合并报销，Word 说明可单独下载。

## 客户端发行

```sh
cd reimbursement-app
pnpm desktop:mac       # Apple Silicon
pnpm desktop:mac:intel # Intel
pnpm desktop:win       # Windows portable EXE
pnpm ios:build
```

桌面发行包只包含静态前端和桌面运行文件。客户端“检查更新”只认 GitHub 的正式 Release，不把本地构建或分支提交当作可更新版本。

## 目录

- `reimbursement-app/src/`：公开前端界面与流程状态展示
- `reimbursement-app/desktop/`：Electron 壳与 Release 检查
- `reimbursement-app/ios/`：Capacitor iOS 壳
- `reimbursement-app/scripts/`：前端构建、桌面打包与 iOS 检查

私有 API、Agent/MCP、SQLite 数据存储、原件处理和生产部署位于独立的私有 server 仓库。
