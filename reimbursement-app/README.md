# 报销工作台前端

React + TypeScript 界面，可作为静态网页、Electron Windows/macOS 客户端或 iPhone/iPad 客户端运行。它通过 HTTPS 直接访问独立的报销 API，不在本地启动数据库或业务后端。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

启动后打开 `http://127.0.0.1:4317/`。连接地址来自 `public/frontend-config.json`，或由桌面客户端的“服务器连接”设置覆盖。该配置只保存公开 API 地址，不保存密码、会话或 Agent token。

## 桌面客户端

```sh
pnpm desktop:mac
pnpm desktop:mac:intel
pnpm desktop:win
```

Mac 本地构建使用 ad-hoc 签名；正式下载与更新只通过 GitHub Release。发布流程必须先完成测试、打包审计、上传 Release 资产，再安装同一正式版本，不能把本地未发布构建当成更新。

## iOS 客户端

```sh
pnpm ios:check
pnpm ios:build
```

iOS 壳携带相同的静态前端，通过受限的 HTTPS 请求连接远程 API；不包含业务数据或服务端代码。

## 隐私边界

本公共仓库只保存客户端代码、通用 UI 资源和构建脚本。业务数据库、附件原件、Agent/MCP、自动化、身份认证和生产部署代码不属于本仓库。
