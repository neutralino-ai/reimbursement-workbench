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

归档输出到 `output/ios/<版本>/`。在 Xcode Organizer 打开 `.xcarchive`，选择 Distribute App → App Store Connect，使用已登录开发者账号的分发证书上传。上传完成、Apple 处理完成、Beta Review 通过、公开链接可安装是四个不同状态；不能用编译成功代替。

在 App Store Connect 为此应用创建外部测试组；仅在目标构建已可供测试后启用公开链接。把核实过的 `https://testflight.apple.com/join/XXXXXXXX` 设置为发布环境的 `TESTFLIGHT_PUBLIC_URL`。Release 自动附上带入口的 `iOS-Installation.md`，源码归档也包含 iOS 工程。

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

只有在 Mac 正式签名、公证验证通过、iOS Release 编译通过、目标版本 TestFlight 链接可安装后才打新标签。不要替换旧标签或覆盖旧 Release 二进制。

GitHub 托管构建需要维护者单独配置签名环境；代码中只引用变量/secret 名称，不包含凭据。变量为 `MAC_SIGNING_IDENTITY`、`APPLE_TEAM_ID`、`TESTFLIGHT_PUBLIC_URL`；可选 CI 凭据为 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`NOTARIZATION_APPLE_ID`、`NOTARIZATION_APP_PASSWORD`。私钥上传到 CI 是独立授权事项，未授权时应在本机完成签名发布，不擅自导出证书。

Windows 仍由原安装程序流程构建，本次 Apple 签名不代表 Windows Authenticode 签名。
