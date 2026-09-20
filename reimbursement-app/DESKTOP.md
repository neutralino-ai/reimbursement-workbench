# 桌面客户端

## 检查更新

从 v0.2.0 起，登录页和已登录界面均有“检查更新”按钮，显示当前客户端版本。按钮匿名查询本项目 GitHub 最新正式 Release，跳过草稿和预发布版，并按 Windows/macOS、x64/arm64 选择对应安装包。发现新版后可打开官方下载链接；当前版本、无公开 Release、网络错误和 GitHub 限流分别显示。

这是检查及手动下载安装，不会后台替换正在运行的程序。下载后退出旧版，再打开新版。v0.1.0 没有此按钮，首次升级到 v0.2.0 须手动下载。检查更新不需要报销登录、Agent 令牌或 GitHub 私有访问令牌。仓库和 Release 必须公开，才可匿名查询下载。

桌面版使用 React + Electron。页面随应用分发，通过 JavaScript 直接访问远程 HTTPS API。本机不启动 HTTP 服务、业务后端或数据库，也不代理 API；服务器保存台账、原件和审批依据。

## 使用

Windows x64：打开构建生成的 `Reimbursement-<version>-win-x64.exe`。这是便携程序，使用者不需要安装 Node、pnpm 或另开浏览器。

macOS：Apple Silicon 使用 `Reimbursement-<version>-mac-arm64.zip`，Intel 使用 `Reimbursement-<version>-mac-x64.zip`。解压后打开 `Reimbursement.app`。

当前测试发行包未签名；Mac 包还未公证、未进行 Mac 实机运行验证。系统可能显示安全提示，构建成功不代表所有桌面功能均已验收。

在“服务器连接”填写远程服务基址，例如 `https://api.example.com/reimbursement`，不要附加 `/api`。保存后应用重新加载并退出旧会话。本机保存的地址覆盖安装包内的默认地址；更新服务器地址无需重新打包。

首次使用时，管理员提供一次性设置链接或设置码，用户在应用内输入并自行设置密码。设置码有时效且只能使用一次；过期后由管理员重新签发。设置成功后再使用密码登录。不要把设置码或密码提交到代码仓库。

## 数据与登录

- 安装包只含构建后的页面、桌面壳与 Electron 运行环境，不含业务后端、数据库、原件或 Agent 令牌。
- `connection.json` 只保存 API 地址，位于应用自己的用户配置目录；Windows 为 `%APPDATA%/报销工作台/connection.json`。
- 登录会话使用 Electron 的非持久化会话；关闭应用后需要重新登录。
- 发票和其他材料通过鉴权 API 读取，另存为的附件保存在用户选择的位置。
- MCP/CLI 使用独立的私有配置和 Agent 令牌，桌面应用不读取它们。

## 构建

构建环境需要 Node 24 和 pnpm。从 `reimbursement-app/` 执行依赖安装，然后在相应平台选择构建命令：

```sh
pnpm install --frozen-lockfile --store-dir .pnpm-store
node node_modules/electron/install.js
```

Windows x64：

```sh
pnpm desktop:win
```

在 Mac 上生成 Apple Silicon 或 Intel 包：

```sh
pnpm desktop:mac
pnpm desktop:mac:intel
```

构建脚本在 `desktop-build/` 创建独立目录，只复制明确列出的前端和桌面文件。输出写入工作区 `output/desktop/<version>/`，不将整个工作区或根目录 `node_modules` 作为安装包输入。构建审计记录发行文件和包内资源的 SHA-256。

`scripts/package-mac-linux.mjs` 也支持使用独立安装的 `@electron/packager@20.3.0` 在 Linux 交叉生成未签名的 Mac 测试包。它保留 Mac 框架符号链接和可执行权限，并检查资源哈希；交叉打包不能替代 Mac 实机运行验证。Mac 签名和公证需要在发行环境配置开发者证书，本项目不包含证书或密码。

## 服务器要求

客户端需要可连接且证书有效的 HTTPS API。服务端应启用云端鉴权，并显式允许 Origin `reimbursement://app`。如还使用独立浏览器前端，应额外登记其精确 Origin。`webSecurity`、沙盒和上下文隔离保持启用，不放行 `null` Origin，也不关闭证书校验。

API 基址通过公开的 `public/frontend-config.json` 字段 `apiBaseUrl` 提供默认值；该文件不含凭据。管理员应自行验证部署环境的 TLS、入站端口、API 鉴权、CORS 和证书续期。服务端接口与部署文档位于配套的私有 `reimbursement-workbench-server` 仓库。

## 验证范围

```sh
pnpm typecheck
pnpm test
pnpm build
```

Windows 包还可在解包目录执行 `Reimbursement.exe --verify-package`。它检查页面资源、桌面文件和包目录，不打开窗口、不连接服务器，也不读取财务数据。

开发期间已验证 Windows 便携程序启动、连接界面和使用虚构费用的五列流程表，以及类型检查、前端构建和自动化测试。包内容检查不代替实际登录、附件点击、PDF 预览或保存验证；这些桌面端到端功能尚未完成全面验收。Mac 包尚未进行实机运行验证。每次发行应保留该版本的检查结果，不以源码检查代替最终安装包验收。
