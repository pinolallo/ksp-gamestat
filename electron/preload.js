const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectSfsFile: () => ipcRenderer.invoke('select-sfs-file'),
    platform: process.platform,
});
