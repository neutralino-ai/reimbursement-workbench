import test from 'node:test';
import assert from 'node:assert/strict';
import {macReleaseOptions,syncIOSVersion,testFlightURL,iosInstallationText} from '../scripts/release-policy.mjs';
test('Mac public release refuses missing, ad-hoc and development signing',()=>{
  for(const identity of ['', '-', 'Apple Development: Example', 'Apple Distribution: Example']) assert.throws(()=>macReleaseOptions({MAC_SIGNING_IDENTITY:identity,APPLE_KEYCHAIN_PROFILE:'test'}));
  assert.throws(()=>macReleaseOptions({MAC_SIGNING_IDENTITY:'Example (ABCDEFGHIJ)'}),/notarization/);
  assert.throws(()=>macReleaseOptions({MAC_SIGNING_IDENTITY:'Example',APPLE_ID:'user@example.test'}));
});
test('Mac signed release enables notarization and strips builder-rejected prefix',()=>{
  assert.deepEqual(macReleaseOptions({MAC_SIGNING_IDENTITY:'Developer ID Application: Example (ABCDEFGHIJ)',APPLE_KEYCHAIN_PROFILE:'test'}),{identity:'Example (ABCDEFGHIJ)',notarize:true,hardenedRuntime:true});
  assert.throws(()=>macReleaseOptions({MAC_SIGNING_IDENTITY:'Example',APPLE_KEYCHAIN_PROFILE:'test',CSC_IDENTITY_AUTO_DISCOVERY:'false'}));
});
test('iOS Debug and Release versions stay synchronized; build numbers are explicit',()=>{
  const source='MARKETING_VERSION = 0.3.0; CURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 0.3.0; CURRENT_PROJECT_VERSION = 1;';
  const updated=syncIOSVersion(source,'0.3.7','2');
  assert.equal((updated.match(/MARKETING_VERSION = 0.3.7;/g)||[]).length,2);
  assert.equal((updated.match(/CURRENT_PROJECT_VERSION = 2;/g)||[]).length,2);
  assert.throws(()=>syncIOSVersion(source,'0.3.7-beta','2'));
  for(const invalid of ['0','-1','1; SECRET','x'])assert.throws(()=>syncIOSVersion(source,'0.3.7',invalid));
  assert.throws(()=>syncIOSVersion('','0.3.7','1'));
});
test('iOS release entry accepts only a public TestFlight invitation',()=>{
  assert.equal(testFlightURL('https://testflight.apple.com/join/Abcd1234'),'https://testflight.apple.com/join/Abcd1234');
  for(const invalid of ['', 'https://example.test/join/Abcd1234','https://testflight.apple.com.evil.test/join/Abcd1234','https://testflight.apple.com/join/Abcd1234?token=secret'])assert.throws(()=>testFlightURL(invalid));
});

test('internal TestFlight distribution never fabricates a public invitation',()=>{
  const text=iosInstallationText('0.3.7',{TESTFLIGHT_DISTRIBUTION:'internal'});
  assert.match(text,/内部测试/);
  assert.doesNotMatch(text,/testflight.apple.com\/join/);
  assert.throws(()=>iosInstallationText('0.3.7',{}));
});
