import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIOSProfile} from '../scripts/ios-signing-policy.mjs';
const team='ABCDEFGHIJ',uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',now=new Date('2026-09-22T00:00:00Z');
const profile=()=>({UUID:uuid,TeamIdentifier:[team],ExpirationDate:'2027-09-22T00:00:00Z',Entitlements:{'application-identifier':team+'.cn.neutrinophysics.reimbursement','com.apple.developer.team-identifier':team,'get-task-allow':false,'beta-reports-active':true}});
test('only a current App Store profile for this app/team is accepted',()=>{
  assert.doesNotThrow(()=>validateIOSProfile(profile(),team,uuid,now));
  for(const mutate of [p=>p.Entitlements['get-task-allow']=true,p=>p.Entitlements['beta-reports-active']=false,p=>p.ProvisionedDevices=['a-device'],p=>p.ProvisionsAllDevices=true,p=>p.Entitlements['application-identifier']=team+'.another.app',p=>p.TeamIdentifier=['OTHERTEAM1'],p=>p.Entitlements['com.apple.developer.team-identifier']='OTHERTEAM1',p=>p.UUID='different',p=>p.ExpirationDate='2025-01-01',p=>p.ExpirationDate='invalid']){
    const p=profile();mutate(p);assert.throws(()=>validateIOSProfile(p,team,uuid,now));
  }
});
