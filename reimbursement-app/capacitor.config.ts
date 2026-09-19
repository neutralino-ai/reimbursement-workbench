import type {CapacitorConfig} from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cn.neutrinophysics.reimbursement',
  appName: '报销工作台',
  webDir: 'dist',
  server: {hostname: 'localhost', iosScheme: 'capacitor'},
  ios: {contentInset: 'never', preferredContentMode: 'mobile', backgroundColor: '#f4f6fa'},
  // Keep standard fetch, TLS verification and the API's exact CORS allowlist.
  plugins: {CapacitorHttp: {enabled: false}},
};
export default config;
