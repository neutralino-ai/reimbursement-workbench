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
