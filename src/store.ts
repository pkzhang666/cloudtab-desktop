import { create } from 'zustand'

type VmStatus = 'RUNNING' | 'TERMINATED' | 'STAGING' | 'STOPPING' | 'NOT_FOUND' | 'NOT_CONFIGURED' | 'LOADING'
type TunnelStatus = 'closed' | 'opening' | 'open' | 'error'

interface AppState {
  vmStatus: VmStatus
  tunnelStatus: TunnelStatus
  logs: string[]
  deploying: boolean

  setVmStatus:     (s: VmStatus)     => void
  setTunnelStatus: (s: TunnelStatus) => void
  appendLog:       (line: string)    => void
  clearLogs:       ()                => void
  setDeploying:    (b: boolean)      => void
}

export const useStore = create<AppState>((set) => ({
  vmStatus:     'LOADING',
  tunnelStatus: 'closed',
  logs:         [],
  deploying:    false,

  setVmStatus:     (vmStatus)     => set({ vmStatus }),
  setTunnelStatus: (tunnelStatus) => set({ tunnelStatus }),
  appendLog:       (line)         => set(s => ({ logs: [...s.logs.slice(-500), line] })),
  clearLogs:       ()             => set({ logs: [] }),
  setDeploying:    (deploying)    => set({ deploying }),
}))
