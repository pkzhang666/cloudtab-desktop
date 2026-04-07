import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Onboarding from './pages/Onboarding'
import Dashboard  from './pages/Dashboard'
import Settings   from './pages/Settings'

export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [apiError, setApiError] = useState(false)

  useEffect(() => {
    if (!window.api) {
      setApiError(true)
      return
    }
    window.api.getConfig()
      .then(cfg => setConfigured(!!(cfg.PROJECT_ID && cfg.VNC_PASSWORD)))
      .catch(() => setConfigured(false))
  }, [])

  if (apiError) {
    return (
      <div style={{ padding: 32, fontFamily: 'monospace', color: '#f00', background: '#111', minHeight: '100vh' }}>
        <h2>Preload API not available</h2>
        <p>window.api is undefined. Check that contextIsolation is enabled and the preload script is loading correctly.</p>
        <p>Open DevTools (View → Toggle Developer Tools) to see console errors.</p>
      </div>
    )
  }

  if (configured === null) {
    return (
      <div style={{ padding: 32, fontFamily: 'monospace', color: '#888', background: '#0a0a0f', minHeight: '100vh' }}>
        Loading…
      </div>
    )
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/dashboard"  element={<Dashboard />} />
        <Route path="/settings"   element={<Settings />} />
        <Route path="*" element={<Navigate to={configured ? '/dashboard' : '/onboarding'} replace />} />
      </Routes>
    </HashRouter>
  )
}
