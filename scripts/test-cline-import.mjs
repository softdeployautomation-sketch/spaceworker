import('@cline/sdk').then(sdk => {
  const keys = Object.keys(sdk);
  console.log('SDK loaded, key count:', keys.length);
  console.log('First 40 keys:', keys.slice(0, 40));
  console.log('Has ClineCore:', !!sdk.ClineCore);
  console.log('Has loginClineOAuth:', !!sdk.loginClineOAuth);
  console.log('Has startClineDeviceAuth:', !!sdk.startClineDeviceAuth);
  console.log('Has completeClineDeviceAuth:', !!sdk.completeClineDeviceAuth);
  console.log('Has getValidClineCredentials:', !!sdk.getValidClineCredentials);
  console.log('Has ToolApprovalRequest:', !!sdk.ToolApprovalRequest);
}).catch(e => console.log('Error:', e.message));
