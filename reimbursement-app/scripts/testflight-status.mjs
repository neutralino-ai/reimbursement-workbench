import fs from 'node:fs';
import crypto from 'node:crypto';
const bundle='cn.neutrinophysics.reimbursement';
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version;
const build=process.env.IOS_BUILD_NUMBER;
if(!/^[1-9]\d{0,8}$/.test(build||''))throw new Error('IOS_BUILD_NUMBER required');
const key=fs.readFileSync(process.env.APPLE_API_KEY);
const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
async function api(route,method='GET',body){
  const now=Math.floor(Date.now()/1000);
  const payload=encode({alg:'ES256',kid:process.env.APPLE_API_KEY_ID,typ:'JWT'})+'.'+encode({iss:process.env.APPLE_API_ISSUER,iat:now,exp:now+300,aud:'appstoreconnect-v1'});
  const jwt=payload+'.'+crypto.sign('sha256',Buffer.from(payload),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const result=await fetch('https://api.appstoreconnect.apple.com'+route,{method,headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!result.ok)throw new Error(`App Store Connect HTTP ${result.status}: ${await result.text()}`);
  return result.status===204?{}:await result.json();
}
const apps=await api(`/v1/apps?filter[bundleId]=${bundle}`);
if(apps.data.length!==1)throw new Error('Expected exactly one App Store Connect app');
const app=apps.data[0].id;
for(let attempt=0;attempt<60;attempt++){
  const response=await api(`/v1/builds?filter[app]=${app}&filter[version]=${build}&include=preReleaseVersion,buildBetaDetail`);
  const entry=response.data[0];
  if(entry){
    const pre=response.included?.find(x=>x.type==='preReleaseVersions'&&x.id===entry.relationships.preReleaseVersion.data.id);
    if(pre?.attributes.version!==version)throw new Error('Processed build marketing version mismatch');
    const state=entry.attributes.processingState;
    console.log(`iOS ${version} (${build}): ${state}`);
    if(['FAILED','INVALID'].includes(state))throw new Error('Apple rejected this uploaded build');
    if(state==='VALID'){
      if(entry.attributes.expired)throw new Error('Uploaded build is expired');
      if(entry.attributes.usesNonExemptEncryption!==false)throw new Error('Export compliance must be resolved before TestFlight distribution');
      const groups=await api(`/v1/betaGroups?filter[app]=${app}`);
      const group=groups.data.find(g=>g.attributes.isInternalGroup&&g.attributes.name==='Reimbursement Internal');
      if(!group)throw new Error('Build processed, but Reimbursement Internal testing group has not been configured');
      if(!group.attributes.hasAccessToAllBuilds)throw new Error('Enable automatic distribution for Reimbursement Internal in App Store Connect');
      // Internal groups receive builds automatically. Apple rejects the public
      // add-build relationship endpoint for internal groups with HTTP 422.
      const assigned=await api(`/v1/betaGroups/${group.id}/builds?limit=200`);
      const beta=await api(`/v1/builds/${entry.id}/buildBetaDetail`);
      if(assigned.data.some(b=>b.id===entry.id)&&beta.data.attributes.internalBuildState==='IN_BETA_TESTING'){
        const audit={version,build,buildID:entry.id,processingState:state,internalGroup:group.id,assigned:true,internalBuildState:beta.data.attributes.internalBuildState};
        console.log(JSON.stringify(audit));
        if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\nApple processed iOS ${version} (${build}); available in Reimbursement Internal. Device installation is a separate check.\n`);
        process.exit(0);
      }
      console.log('Waiting for automatic internal TestFlight distribution');
    }
  }else console.log(`Waiting for Apple to register iOS ${version} (${build})`);
  await new Promise(resolve=>setTimeout(resolve,20000));
}
throw new Error('Apple processing or internal distribution is still pending; do not claim TestFlight is ready.');
