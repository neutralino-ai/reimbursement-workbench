export function macReleaseOptions(env = process.env) {
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('Release signing discovery must not be disabled.');
  const identity = (env.MAC_SIGNING_IDENTITY || env.CSC_NAME || '').trim();
  if (!identity || identity === '-' || /^(Apple Development|Mac Developer|Apple Distribution|3rd Party)/.test(identity)) throw new Error('MAC_SIGNING_IDENTITY must select a Developer ID Application certificate, not ad-hoc or App Store signing.');
  const qualifier = identity.replace(/^Developer ID Application:\s*/, '');
  const appleID = Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
  const apiKey = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  if (!env.APPLE_KEYCHAIN_PROFILE && !appleID && !apiKey) throw new Error('A notarization keychain profile or complete Apple notarization credentials are required for --release.');
  return {identity: qualifier, notarize: true, hardenedRuntime: true};
}

export function syncIOSVersion(source, version, buildNumber) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('iOS marketing version must be a stable three-part version.');
  if (buildNumber !== undefined && !/^[1-9]\d{0,8}$/.test(String(buildNumber))) throw new Error('iOS build number must be a positive integer.');
  if ([...source.matchAll(/MARKETING_VERSION = [^;]+;/g)].length !== 2 || [...source.matchAll(/CURRENT_PROJECT_VERSION = [^;]+;/g)].length !== 2) throw new Error('Expected Debug and Release iOS version settings.');
  let updated = source.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
  if (buildNumber !== undefined) updated = updated.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
  return updated;
}

export function testFlightURL(value) {
  if (!/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{8}$/.test(value || '')) throw new Error('A verified public TestFlight invitation URL is required, not an IPA or placeholder.');
  return value;
}

export function iosInstallationText(version, env=process.env) {
  if(env.TESTFLIGHT_DISTRIBUTION==='internal')return `# 报销工作台 iOS ${version}\n\n本版本通过 TestFlight 内部测试分发，暂无公开邀请链接。已有测试权限的用户请用获邀的 Apple 账号打开 TestFlight 安装。\n\n最低 iOS 18，支持 iPhone / iPad。TestFlight 权限不授予报销服务器或台账访问权限。GitHub 不提供直接安装的 IPA；完整 iOS 工程位于 reimbursement-app/ios/。\n`;
  const url=testFlightURL(env.TESTFLIGHT_PUBLIC_URL);
  return `# 报销工作台 iOS ${version}\n\n通过 TestFlight 安装：[打开安装入口](${url})。\n\n最低 iOS 18，支持 iPhone / iPad。需要已有报销 API 账号；安装客户端不会授予服务器或台账访问权限。TestFlight 中可安装的版本及名额以 Apple 页面为准。\n\n本 Release 不提供可绕过 Apple 分发限制的 IPA。完整 iOS 工程随同本版本源代码公开，位于 reimbursement-app/ios/。\n`;
}
