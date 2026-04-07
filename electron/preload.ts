import { contextBridge, ipcRenderer } from 'electron'

// Expose a typed API to the renderer process via window.api
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Prerequisites
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),

  // Config
  getConfig:  ()       => ipcRenderer.invoke('get-config'),
  saveConfig: (c: any) => ipcRenderer.invoke('save-config', c),

  // VM lifecycle
  vmStatus:  () => ipcRenderer.invoke('vm-status'),
  deploy:    () => ipcRenderer.invoke('deploy'),
  vmStart:   () => ipcRenderer.invoke('vm-start'),
  vmStop:    () => ipcRenderer.invoke('vm-stop'),
  tfDestroy: () => ipcRenderer.invoke('tf-destroy'),

  // Tunnel + noVNC
  openTunnel:  () => ipcRenderer.invoke('open-tunnel'),
  closeTunnel: () => ipcRenderer.invoke('close-tunnel'),
  openNovnc:   () => ipcRenderer.invoke('open-novnc'),
  closeNovnc:  () => ipcRenderer.invoke('close-novnc'),

  // Utilities
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Streaming logs from main process
  onLog: (cb: (line: string) => void) => {
    ipcRenderer.on('log', (_e, line) => cb(line))
    return () => ipcRenderer.removeAllListeners('log')
  },
})
