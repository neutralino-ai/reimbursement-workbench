export const iosBundleID='cn.neutrinophysics.reimbursement';
export function validateIOSProfile(profile,team,uuid,now=new Date()) {
  const e=profile?.Entitlements;
  if(!/^[A-Z0-9]{10}$/.test(team) || !/^[a-f0-9-]{36}$/i.test(uuid))throw new Error('Invalid signing team or profile UUID');
  if(profile.UUID!==uuid || e?.['application-identifier']!==`${team}.${iosBundleID}` || e?.['com.apple.developer.team-identifier']!==team || !profile.TeamIdentifier?.includes(team))throw new Error('Distribution profile belongs to a different app/team');
  if(e['get-task-allow']!==false || e['beta-reports-active']!==true || profile.ProvisionedDevices || profile.ProvisionsAllDevices)throw new Error('Expected an App Store distribution profile, not development/ad-hoc/enterprise');
  if(!(new Date(profile.ExpirationDate)>now))throw new Error('Distribution profile expired or expiration missing');
}
