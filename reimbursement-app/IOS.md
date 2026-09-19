# iOS 客户端与语音输入

现有 React 前端通过 Capacitor 8.5.2 嵌入 iOS App。Windows/macOS 继续使用 Electron，三端连接同一个远程 HTTPS API。手机不启动业务后端，不保存 SQLite，也不保存 DeepSeek 密钥。当前是供本人签名测试的开发版本，未发布 App Store/TestFlight。

## 在 Mac 上运行

需要 Node.js 24+、pnpm 11、Xcode 26+（首次启动完成组件安装）。本 App 最低 iOS 18；选择该版本是为了与现有 WebKit 前端 API 保持兼容。

在仓库根目录运行：

```sh
git switch main
git pull --ff-only
cd reimbursement-app
pnpm install --frozen-lockfile
pnpm ios:sync
pnpm ios:open
```

`ios:sync` 重新构建并复制静态前端，再验证包内只有公开前端文件。每次改 React/TypeScript 后都要运行一次。原生依赖使用 Swift Package Manager，由 Xcode 下载，不需要 CocoaPods。

Xcode 中选择 **App → Signing & Capabilities → Team**，选自己的 Apple 账号，保持自动签名。若 Bundle Identifier 已被占用，改成自己唯一的值；不要提交个人 Team ID 或签名文件。连接 iPhone、启用开发者模式，在运行设备中选它，再按 Run。模拟器可检查页面和登录，语音效果必须用真机确认。

不签名检查编译：

```sh
pnpm ios:build
```

只测试 Mac 桌面版则用 `pnpm desktop:dev`；生成 Apple Silicon 安装包用 `pnpm desktop:mac`，Intel 用 `pnpm desktop:mac:intel`。桌面版继续支持系统听写快捷键，不使用 iOS 录音按钮。

## 登录与用途听写

1. 默认 API 来自 `public/frontend-config.json`，可在登录页或主页面“服务器连接”中修改。填写 HTTPS 服务根地址，包含部署子路径，不加 `/api`。
2. 使用现有工作台密码登录。会话只用于当前前端会话；应用被终止后可能需要重新登录。不是 Agent 令牌。
3. 在一笔尚未交财务的费用中打开“准备申报材料”，在用途区域选择“普通话”或 “English”，点“语音输入”。第一次会请求麦克风与语音识别权限。
4. 点“停止录音”，检查并修改“本段识别文字”，再点“采用文字”。文字追加到用途原文，保留已有内容；“丢弃本段”不会删除已有用途。
5. 可录多段，每段最多 55 秒。录音或尚未处理识别文字时，保存/AI 整理/PDF 生成暂停，防止漏掉这段内容。拒绝权限或识别不可用时，可用键盘输入/系统听写。
6. 点“DeepSeek 整理说明”，只把确认采用的用途文字和选择的截图交给现有后端流程。检查最终用途和金额后生成 PDF 草稿，再人工确认材料备妥。

原生识别使用 `SFSpeechRecognizer`，仅在所选语言支持 `supportsOnDeviceRecognition` 时运行，并强制 `requiresOnDeviceRecognition = true`。不支持时显示错误，不回退云端音频识别。App 不生成音频文件、不保存录音、不上传音频，也不直接把语音发给 DeepSeek。系统键盘听写是独立的系统功能，遵循用户的系统设置。

切换到后台、来电或拔出录音设备会停止当前录音并保留已经识别的文字；最终短语可能丢失，需要用户检查。普通话夹杂英文产品名的准确率由设备和语言模型决定，不能当作已核实事实。

## 图片、PDF 和 ZIP

凭证上传复用现有文件选择器，可从“照片”或“文件”选择截图。第一版推荐 PNG/JPEG/PDF；HEIC 自动转换尚未实现。点击 PDF 在系统 Quick Look 内预览；“下载 Word / 申报 ZIP”打开系统分享面板，可选“存储到文件”。手机原生预览/导出暂限每个文件 20 MB，较大文件用桌面客户端。

附件先通过带 Session 的 HTTPS 请求读取，再交给本机临时预览目录。临时副本在关闭预览/分享后删除，异常退出后的残留在下次启动清理。用户自己存储/分享的副本由用户管理。生成的 PDF/Word 使用服务器已有的中文字体与文档模板。

## 后端配置

现有跨域白名单需要增加精确来源 `capacitor://localhost`，同时保留桌面和网页原有来源，例如：

```text
REIMBURSE_FRONTEND_ORIGINS=reimbursement://app,capacitor://localhost,http://127.0.0.1:4317
```

该来源仅是允许客户端发送跨域请求；每次数据请求仍需要 Session/Bearer 鉴权。拒绝 `null`、其他 Capacitor hostname、带端口或非规范来源。客户端使用标准 WebView fetch，未开启 Capacitor 原生 HTTP 绕过，不关闭 TLS 验证，不新增公开网站或端口。

## 验证范围

Node 测试覆盖原生来源的预检/登录/原件下载/写入/注销、非授权来源拒绝，以及识别结果乱序、取消和追加原文。GitHub Actions 在 macOS 上构建未签名的 iOS 模拟器 App；通过编译不等于真机语音已验收。

首次真机验收：

- 登录现有 API，读取列表；PNG 截图上传后可以查看原件。
- 首次授权、拒绝权限、系统设置重新允许后均有清楚反馈。
- 普通话/英文各录一段；停止后可编辑，采用后保留之前用途；丢弃不污染原文。
- 来电/后台/55 秒限时会停止；旧录音结果不改写下一段，麦克风指示灯熄灭。
- 识别文字未采用时不能触发 AI；采用后只有显式点击才提交用途。
- 完整 PDF 可预览，Word/ZIP 可“存储到文件”；在 Mac 打开检查中文。
- 退出登录后读取原件失败；改服务器后不能沿用旧服务器会话。

Apple 账号签名、iPhone 权限、系统语言资源和麦克风识别效果仍需在自己的 Mac/iPhone 上完成验收。
