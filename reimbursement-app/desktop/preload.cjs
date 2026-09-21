'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Child attachment windows and frames never receive the settings bridge.
if (process.isMainFrame && location.protocol === 'reimbursement:' && location.host === 'app' && ['/', '/index.html'].includes(location.pathname)) {
  contextBridge.exposeInMainWorld('reimbursementDesktop', Object.freeze({
    version: 1,
    getConnection: () => ipcRenderer.invoke('reimbursement:connection:get'),
    saveConnection: value => ipcRenderer.invoke('reimbursement:connection:save', { apiBaseUrl: value?.apiBaseUrl }),
    getVersion: () => ipcRenderer.invoke('reimbursement:updates:version'),
    checkForUpdates: () => ipcRenderer.invoke('reimbursement:updates:check'),
    getUpdateInfo: () => ipcRenderer.invoke('reimbursement:updates:info'),
    downloadUpdate: () => ipcRenderer.invoke('reimbursement:updates:download'),
    installUpdate: () => ipcRenderer.invoke('reimbursement:updates:install'),
    cancelUpdate: () => ipcRenderer.invoke('reimbursement:updates:cancel'),
    openUpdate: () => ipcRenderer.invoke('reimbursement:updates:open'),
  }));
}
