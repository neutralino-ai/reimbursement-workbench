'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Child attachment windows and frames never receive the settings bridge.
if (process.isMainFrame && location.protocol === 'reimbursement:' && location.host === 'app' && ['/', '/index.html'].includes(location.pathname)) {
  contextBridge.exposeInMainWorld('reimbursementDesktop', Object.freeze({
    version: 1,
    getConnection: () => ipcRenderer.invoke('reimbursement:connection:get'),
    saveConnection: value => ipcRenderer.invoke('reimbursement:connection:save', { apiBaseUrl: value?.apiBaseUrl }),
  }));
}
