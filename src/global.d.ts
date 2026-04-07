export {}

declare global {
  interface Window {
    api: {
      platform: string

      checkPrerequisites: () => Promise<Record<string, boolean>>
      getConfig:          () => Promise<Record<string, string>>
      saveConfig:         (config: Record<string, string>) => Promise<void>

      vmStatus:  () => Promise<string>
      deploy:    () => Promise<void>
      vmStart:   () => Promise<void>
      vmStop:    () => Promise<void>
      tfDestroy: () => Promise<void>

      openTunnel:  () => Promise<{ ok: boolean; port: number }>
      closeTunnel: () => Promise<void>
      openNovnc:   () => Promise<void>
      closeNovnc:  () => Promise<void>

      openExternal: (url: string) => Promise<void>

      onLog: (cb: (line: string) => void) => () => void
    }
  }
}
