// src/bridge.ts
//
// Injects a browser-compatible window.api when running outside of Electron.
// In normal Electron operation, preload.ts provides window.api via contextBridge
// and this module is a no-op.  In a plain browser (dev HTTP bridge testing),
// all IPC calls are forwarded to the local HTTP bridge server in main.ts.

const BRIDGE = 'http://127.0.0.1:3001'

function detectPlatform(): string {
  const p = (navigator.platform || '').toLowerCase()
  if (p.includes('win')) return 'win32'
  if (p.includes('mac')) return 'darwin'
  return 'linux'
}

async function bridgePost(route: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch(`${BRIDGE}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const e = await res.json(); msg = (e as { error?: string }).error ?? msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

if (!(window as Window & { api?: unknown }).api) {
  window.api = {
    platform: detectPlatform(),

    checkPrerequisites:
      () => bridgePost('check-prerequisites') as Promise<Record<string, boolean>>,
    installMissingWindowsPrerequisites:
      () => bridgePost('install-missing-windows-prerequisites') as Promise<{ installed: Array<'wsl' | 'gcloud' | 'terraform' | 'docker'>; restartRequired: boolean }>,
    runGcloudAuth:
      (t) => bridgePost('run-gcloud-auth', t) as Promise<void>,
    getConfig:
      () => bridgePost('get-config') as Promise<Record<string, string>>,
    saveConfig:
      (c) => bridgePost('save-config', c) as Promise<void>,

    vmStatus:  () => bridgePost('vm-status') as Promise<string>,
    deploy:    () => bridgePost('deploy') as Promise<void>,
    vmStart:   () => bridgePost('vm-start') as Promise<void>,
    vmStop:    () => bridgePost('vm-stop') as Promise<void>,
    tfDestroy: () => bridgePost('tf-destroy') as Promise<void>,

    openTunnel:  () => bridgePost('open-tunnel') as Promise<{ ok: boolean; port: number }>,
    closeTunnel: () => bridgePost('close-tunnel') as Promise<void>,
    openNovnc:   (port?: number) => { const p = Number(port) > 0 ? Number(port) : 8080; window.open(`http://localhost:${p}/vnc.html?reconnect=true`, '_blank'); return Promise.resolve() },
    closeNovnc:  () => Promise.resolve(),

    openExternal: (url) => bridgePost('open-external', url) as Promise<void>,

    onLog: (cb) => {
      const es = new EventSource(`${BRIDGE}/api/logs`)
      es.onmessage = (evt) => cb(JSON.parse(evt.data as string) as string)
      return () => es.close()
    },
  }
}
