import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Play, Square, Wifi, WifiOff, Settings, RefreshCw,
  Terminal, ChevronDown, ChevronUp, Loader2, Globe, AlertCircle,
} from 'lucide-react'
import { useStore } from '../store'

const STATUS_COLOR: Record<string, string> = {
  RUNNING:        'text-green-400',
  TERMINATED:     'text-gray-500',
  STAGING:        'text-yellow-400',
  STOPPING:       'text-yellow-400',
  NOT_FOUND:      'text-gray-500',
  NOT_CONFIGURED: 'text-red-400',
  LOADING:        'text-gray-500',
}

const STATUS_LABEL: Record<string, string> = {
  RUNNING:        'Running',
  TERMINATED:     'Stopped',
  STAGING:        'Starting…',
  STOPPING:       'Stopping…',
  NOT_FOUND:      'Not deployed',
  NOT_CONFIGURED: 'Not configured',
  LOADING:        'Loading…',
}

export default function Dashboard() {
  const navigate = useNavigate()
  const {
    vmStatus, tunnelStatus, logs, deploying,
    setVmStatus, setTunnelStatus, appendLog, clearLogs, setDeploying,
  } = useStore()

  const [showLogs, setShowLogs] = useState(false)
  const [actionLoading, setActionLoading] = useState('')
  const [actionError, setActionError]     = useState('')
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Subscribe to log stream from main process
  useEffect(() => {
    const unsub = window.api.onLog(line => appendLog(line))
    return unsub
  }, [appendLog])

  // Poll VM status every 10s
  useEffect(() => {
    let cancelled = false
    async function poll() {
      while (!cancelled) {
        try {
          const s = await window.api.vmStatus()
          if (!cancelled) setVmStatus(s as any)
        } catch { /* network blip — keep polling */ }
        await new Promise(r => setTimeout(r, 10_000))
      }
    }
    poll()
    return () => { cancelled = true }
  }, [setVmStatus])

  // Auto-scroll logs
  useEffect(() => {
    if (showLogs) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, showLogs])

  function withAction(key: string, fn: () => Promise<void>) {
    return async () => {
      setActionLoading(key)
      setActionError('')
      try { await fn() }
      catch (e: any) { setActionError(e.message ?? String(e)) }
      finally { setActionLoading('') }
    }
  }

  const handleDeploy = withAction('deploy', async () => {
    setDeploying(true); clearLogs(); setShowLogs(true)
    try { await window.api.deploy() }
    finally { setDeploying(false) }
    setVmStatus(await window.api.vmStatus() as any)
  })

  const handleStart = withAction('start', async () => {
    await window.api.vmStart()
    setVmStatus(await window.api.vmStatus() as any)
  })

  const handleStop = withAction('stop', async () => {
    if (!confirm('Stop the VM? Your session will be disconnected.')) return
    if (tunnelStatus === 'open') { await window.api.closeTunnel(); setTunnelStatus('closed') }
    await window.api.vmStop()
    setVmStatus('TERMINATED')
  })

  const handleConnect = withAction('connect', async () => {
    setTunnelStatus('opening')
    try {
      await window.api.openTunnel()
      setTunnelStatus('open')
      await window.api.openNovnc()
    } catch (e) {
      setTunnelStatus('error')
      throw e
    }
  })

  const handleDisconnect = withAction('disconnect', async () => {
    await window.api.closeTunnel()
    setTunnelStatus('closed')
    await window.api.closeNovnc()
  })

  const isRunning   = vmStatus === 'RUNNING'
  const isConnected = tunnelStatus === 'open'
  const notDeployed = vmStatus === 'NOT_FOUND'
  const busy        = !!actionLoading || deploying

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <h1 className="font-bold text-lg tracking-tight">CloudTab</h1>
          <span className={`text-xs font-mono ${STATUS_COLOR[vmStatus]}`}>
            {STATUS_LABEL[vmStatus]}
          </span>
        </div>
        <button
          onClick={() => navigate('/settings')}
          className="p-1.5 rounded-md hover:bg-gray-800 transition-colors">
          <Settings size={16} className="text-gray-400" />
        </button>
      </header>

      <main className="flex-1 p-5 space-y-4">

        {/* Error banner */}
        {actionError && (
          <div className="flex items-start gap-2 bg-red-950/60 border border-red-800/50 rounded-xl px-4 py-3 text-sm text-red-300">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span className="flex-1">{actionError}</span>
            <button onClick={() => setActionError('')} className="text-red-500 hover:text-red-300 ml-2">✕</button>
          </div>
        )}

        {/* Status card */}
        <div className="bg-gray-900 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">VM Status</span>
            <button
              onClick={async () => { const s = await window.api.vmStatus(); setVmStatus(s as any) }}
              className="text-gray-500 hover:text-white transition-colors">
              <RefreshCw size={14} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
            <span className="font-medium">{STATUS_LABEL[vmStatus]}</span>
          </div>

          {tunnelStatus !== 'closed' && (
            <div className="flex items-center gap-2 text-sm">
              {tunnelStatus === 'open'
                ? <><Wifi size={14} className="text-blue-400" /><span className="text-blue-400">IAP tunnel active — port 8080</span></>
                : tunnelStatus === 'opening'
                ? <><Loader2 size={14} className="text-yellow-400 animate-spin" /><span className="text-yellow-400">Opening tunnel…</span></>
                : <><WifiOff size={14} className="text-red-400" /><span className="text-red-400">Tunnel error — try again</span></>}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="space-y-2">
          {notDeployed ? (
            <button onClick={handleDeploy} disabled={busy}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {deploying
                ? <><Loader2 size={16} className="animate-spin" />Deploying…</>
                : <><Globe size={16} />Deploy VM</>}
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {!isRunning ? (
                <button onClick={handleStart} disabled={busy || vmStatus === 'LOADING'}
                  className="py-3 bg-green-700 hover:bg-green-600 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'start' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  Start VM
                </button>
              ) : (
                <button onClick={handleStop} disabled={busy}
                  className="py-3 bg-gray-800 hover:bg-gray-700 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'stop' ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} />}
                  Stop VM
                </button>
              )}

              {!isConnected ? (
                <button onClick={handleConnect} disabled={!isRunning || busy}
                  className="py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'connect' ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
                  Connect
                </button>
              ) : (
                <button onClick={handleDisconnect} disabled={busy}
                  className="py-3 bg-gray-800 hover:bg-gray-700 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'disconnect' ? <Loader2 size={16} className="animate-spin" /> : <WifiOff size={16} />}
                  Disconnect
                </button>
              )}
            </div>
          )}
        </div>

        {/* Contextual hints */}
        {!notDeployed && !isRunning && vmStatus !== 'LOADING' && (
          <p className="text-xs text-gray-500 text-center">Start the VM, then Connect to open your Chrome session.</p>
        )}
        {isConnected && (
          <p className="text-xs text-gray-500 text-center">Chrome is running at localhost:8080 via IAP tunnel.</p>
        )}
        {tunnelStatus === 'error' && (
          <p className="text-xs text-yellow-600 text-center">Tunnel failed. Make sure the VM is running and try again.</p>
        )}

        {/* Logs panel */}
        <div className="bg-gray-900 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowLogs(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-400 hover:text-white transition-colors">
            <span className="flex items-center gap-2"><Terminal size={14} />Logs</span>
            {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {showLogs && (
            <div className="h-48 overflow-y-auto px-4 pb-4 font-mono text-xs text-gray-300 space-y-0.5">
              {logs.length === 0
                ? <p className="text-gray-600 pt-2">No logs yet.</p>
                : logs.map((l, i) => <p key={i} className="whitespace-pre-wrap break-all">{l}</p>)}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>

      </main>
    </div>
  )
}
