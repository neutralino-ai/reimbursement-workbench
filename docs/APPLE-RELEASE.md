# Apple 客户端发布

iOS 完整源码在 `reimbursement-app/ios/`，使用 Capacitor + UIKit；GitHub 不分发可任意安装的 IPA。安装入口为 TestFlight，正式 App Store 上架是另一项操作，不会由本流程自动提交。

## iOS 构建与 TestFlight

在 `reimbursement-app` 目录：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm ios:build
DEVELOPMENT_TEAM=YOURTEAMID IOS_BUILD_NUMBER=1 pnpm ios:archive
```

模拟器及归档命令都会重新生成并核对 Web 资源，使 Debug/Release 的 `MARKETING_VERSION` 与 `package.json` 一致。归档需要显式提供构建号；同名归档存在时停止，不覆盖历史文件。

只有授权 Xcode 创建或更新签名材料后，才使用 `node scripts/build-ios.mjs --archive --allow-provisioning-updates`。工程不保存个人团队 ID、证书、账号或设备标识。

归档输出到 `output/ios/<版本>/`。可在 Xcode Organizer 分发，也可使用 `Signed iOS TestFlight` 工作流：从受保护的发布环境导入 Apple Distribution 证书和本应用的 App Store 描述文件，归档、检查签名和应用标识、导出 IPA，再通过 API 密钥上传。构建号按从 2020 年开始的秒数生成，跨工作流和重试递增。工作流等待 Apple 处理完成并将构建分配到内部测试组；不公开上传 IPA 或证书。

当前用户选择仅自己内部测试。在 App Store Connect 创建 `Reimbursement Internal` 内部测试组并添加账号持有人，仓库变量 `TESTFLIGHT_DISTRIBUTION=internal`。不生成公开链接、不提交外部 Beta Review。如果将来明确改为外部测试，完成 Apple 审核后设置经核实的 `TESTFLIGHT_PUBLIC_URL`。Release 附件 `iOS-Installation.md` 如实区分内部测试和公开邀请，源码归档也包含 iOS 工程。上传、处理完成、组内分发和实体设备安装是不同验证结果。

外部测试审核可能需要测试账号。不得向 Apple 提交个人真实报销账号或财务资料；需要单独授权并提供隔离的合成数据演示环境。

## Mac Developer ID 与公证

App Store 的 Apple Distribution / Mac Installer Distribution 与站外下载包的 Developer ID Application 不是同一种证书。

本机推荐使用已有 Developer ID Application 证书和系统钥匙串内的公证配置：

```sh
MAC_SIGNING_IDENTITY='Your Name (YOURTEAMID)' \
APPLE_KEYCHAIN_PROFILE='your-existing-notary-profile' \
pnpm desktop:mac:release
```

Intel 构建使用 `node scripts/package-desktop.mjs --mac --release`，然后运行 `verify-desktop-package.mjs --mac` 和 `verify-mac-release.mjs`。普通 `desktop:mac` 仍只用于本地临时签名测试，不能当成正式签名发布。

`--release` 在缺少身份或公证配置时失败。正式校验要求 Developer ID、Hardened Runtime、签名时间戳、公证票据和 Gatekeeper 接受；不移除 quarantine，也不关闭 Gatekeeper/TLS。

## GitHub 发布门禁

可先在 main 手动运行桌面签名构建和 iOS TestFlight 工作流。打新版本标签后，只有 Mac 签名、公证和 Gatekeeper 校验通过、iOS 编译以及 TestFlight 处理和内部组分配通过，才发布桌面附件。不要替换旧标签或覆盖旧 Release 二进制。

GitHub `apple-release` 环境仅允许 main 和 v* 标签使用，不向 PR 提供签名凭据。用户已授权此仓库使用现有 Apple API 密钥和签名证书，私钥只存于加密 Secrets：`APPLE_API_PRIVATE_KEY`、`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`IOS_DISTRIBUTION_P12`、`IOS_DISTRIBUTION_PASSWORD`、`IOS_PROVISIONING_PROFILE`。P12 和描述文件使用 Base64；API 密钥保存 PEM 原文。非秘密变量：`MAC_SIGNING_IDENTITY`、`APPLE_TEAM_ID`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`TESTFLIGHT_DISTRIBUTION`。临时文件和 iOS 签名钥匙串在任务结束时清理，不上传为构建产物。API 密钥用于鉴权和公证，不能代替签名证书或提升 Apple 角色权限。

Windows 仍由原安装程序流程构建，本次 Apple 签名不代表 Windows Authenticode 签名。
