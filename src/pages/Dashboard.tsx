import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Play, Square, Wifi, WifiOff, Settings, RefreshCw,
  Terminal, ChevronDown, ChevronUp, Loader2, Globe,
} from 'lucide-react'
import { useStore } from '../store'

const STATUS_COLOR: Record<string, string> = {
  RUNNING:       'text-green-400',
  TERMINATED:    'text-gray-500',
  STAGING:       'text-yellow-400',
  STOPPING:      'text-yellow-400',
  NOT_FOUND:     'text-gray-500',
  NOT_CONFIGURED:'text-red-400',
  LOADING:       'text-gray-500',
}

const STATUS_LABEL: Record<string, string> = {
  RUNNING:       'Running',
  TERMINATED:    'Stopped',
  STAGING:       'Starting…',
  STOPPING:      'Stopping…',
  NOT_FOUND:     'Not deployed',
  NOT_CONFIGURED:'Not configured',
  LOADING:       'Loading…',
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { vmStatus, tunnelStatus, logs, deploying, setVmStatus, setTunnelStatus, appendLog, clearLogs, setDeploying } = useStore()
  const [showLogs, setShowLogs] = useState(false)
  const [actionLoading, setActionLoading] = useState('')
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Subscribe to log stream
  useEffect(() => {
    const unsub = window.api.onLog(line => appendLog(line))
    return unsub
  }, [appendLog])

  // Poll VM status
  useEffect(() => {
    let cancelled = false
    async function poll() {
      while (!cancelled) {
        const s = await window.api.vmStatus()
        if (!cancelled) setVmStatus(s as any)
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

  async function handleDeploy() {
    setDeploying(true); clearLogs(); setShowLogs(true)
    try { await window.api.deploy() } catch {}
    setDeploying(false)
    const s = await window.api.vmStatus()
    setVmStatus(s as any)
  }

  async function handleStart() {
    setActionLoading('start')
    try { await window.api.vmStart() } catch {}
    setActionLoading('')
    const s = await window.api.vmStatus()
    setVmStatus(s as any)
  }

  async function handleStop() {
    if (!confirm('Stop the VM? Your session will be disconnected.')) return
    setActionLoading('stop')
    if (tunnelStatus === 'open') { await window.api.closeTunnel(); setTunnelStatus('closed') }
    try { await window.api.vmStop() } catch {}
    setActionLoading('')
    setVmStatus('TERMINATED')
  }

  async function handleConnect() {
    setActionLoading('connect')
    setTunnelStatus('opening')
    try {
      await window.api.openTunnel()
      setTunnelStatus('open')
      await window.api.openNovnc()
    } catch {
      setTunnelStatus('error')
    }
    setActionLoading('')
  }

  async function handleDisconnect() {
    setActionLoading('disconnect')
    await window.api.closeTunnel()
    setTunnelStatus('closed')
    await window.api.closeNovnc()
    setActionLoading('')
  }

  const isRunning = vmStatus === 'RUNNING'
  const isConnected = tunnelStatus === 'open'
  const notDeployed = vmStatus === 'NOT_FOUND'

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
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/settings')}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors">
            <Settings size={16} className="text-gray-400" />
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 p-5 space-y-4">

        {/* Status card */}
        <div className="bg-gray-900 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">VM Status</span>
            <button onClick={async () => { const s = await window.api.vmStatus(); setVmStatus(s as any) }}
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
                ? <><Wifi size={14} className="text-blue-400" /><span className="text-blue-400">Tunnel active — port 8080</span></>
                : tunnelStatus === 'opening'
                ? <><Loader2 size={14} className="text-yellow-400 animate-spin" /><span className="text-yellow-400">Opening tunnel…</span></>
                : <><WifiOff size={14} className="text-red-400" /><span className="text-red-400">Tunnel error</span></>
              }
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-2">
          {notDeployed ? (
            <button onClick={handleDeploy} disabled={deploying}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {deploying
                ? <><Loader2 size={16} className="animate-spin" />Deploying…</>
                : <><Globe size={16} />Deploy VM</>}
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {!isRunning ? (
                <button onClick={handleStart}
                  disabled={!!actionLoading || vmStatus === 'LOADING'}
                  className="py-3 bg-green-700 hover:bg-green-600 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'start'
                    ? <Loader2 size={16} className="animate-spin" />
                    : <Play size={16} />}
                  Start VM
                </button>
              ) : (
                <button onClick={handleStop}
                  disabled={!!actionLoading}
                  className="py-3 bg-gray-800 hover:bg-gray-700 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'stop'
                    ? <Loader2 size={16} className="animate-spin" />
                    : <Square size={16} />}
                  Stop VM
                </button>
              )}

              {!isConnected ? (
                <button onClick={handleConnect}
                  disabled={!isRunning || !!actionLoading}
                  className="py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'connect'
                    ? <Loader2 size={16} className="animate-spin" />
                    : <Wifi size={16} />}
                  Connect
                </button>
              ) : (
                <button onClick={handleDisconnect}
                  disabled={!!actionLoading}
                  className="py-3 bg-gray-800 hover:bg-gray-700 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {actionLoading === 'disconnect'
                    ? <Loader2 size={16} className="animate-spin" />
                    : <WifiOff size={16} />}
                  Disconnect
                </button>
              )}
            </div>
          )}
        </div>

        {/* Tips */}
        {!notDeployed && !isRunning && vmStatus !== 'LOADING' && (
          <p className="text-xs text-gray-500 text-center">
            Start the VM, then Connect to open Chrome in your browser.
          </p>
        )}
        {isConnected && (
          <p className="text-xs text-gray-500 text-center">
            Your Chrome session is running at localhost:8080 via IAP tunnel.
          </p>
        )}

        {/* Logs panel */}
        <div className="bg-gray-900 rounded-xl overflow-hidden">
          <button onClick={() => setShowLogs(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-400 hover:text-white transition-colors">
            <span className="flex items-center gap-2"><Terminal size={14} /> Logs</span>
            {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {showLogs && (
            <div className="h-48 overflow-y-auto px-4 pb-4 font-mono text-xs text-gray-300 space-y-0.5">
              {logs.length === 0
                ? <p className="text-gray-600 pt-2">No logs yet.</p>
                : logs.map((l, i) => <p key={i} className="whitespace-pre-wrap">{l}</p>)
              }
              <div ref={logsEndRef} />
            </div>
          )}
        </div>

      </main>
    </div>
  )
}
