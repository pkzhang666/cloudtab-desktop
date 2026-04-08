import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

const MACHINE_TYPES = [
  { value: 'e2-medium',     label: 'e2-medium',     spec: '1 vCPU / 4 GB',  cost: '~$9/mo',  note: 'Light use' },
  { value: 'e2-standard-2', label: 'e2-standard-2', spec: '2 vCPU / 8 GB',  cost: '~$11/mo', note: 'Recommended' },
  { value: 'e2-standard-4', label: 'e2-standard-4', spec: '4 vCPU / 16 GB', cost: '~$19/mo', note: 'Heavy use / video' },
]

export default function Onboarding() {
  const navigate = useNavigate()
  const isWindows = window.api.platform === 'win32'
  const [step, setStep] = useState(1)
  const [prereqs, setPrereqs] = useState<Record<string, boolean> | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [authenticating, setAuthenticating] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [prereqError, setPrereqError] = useState('')
  const [prereqMessage, setPrereqMessage] = useState('')

  const [config, setConfig] = useState({
    PROJECT_ID:   '',
    REGION:       'us-central1',
    ZONE:         'us-central1-a',
    VM_NAME:      'cloudtab',
    MACHINE_TYPE: 'e2-standard-2',
    DISK_SIZE_GB: '50',
    PREEMPTIBLE:  'false',
    SUBNET_CIDR:  '10.0.0.0/24',
    VNC_PASSWORD: '',
    RESOLUTION:   '1920x1080x24',
  })

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setConfig(c => ({ ...c, [k]: e.target.value }))

  // Step 1 — check prerequisites
  async function checkPrereqs() {
    setChecking(true)
    setPrereqError('')
    try {
      const r = await window.api.checkPrerequisites()
      setPrereqs(r)
    } catch (e: any) {
      setPrereqError(e?.message ?? 'Failed to check prerequisites.')
    } finally {
      setChecking(false)
    }
  }

  const prereqsOk = prereqs && Object.values(prereqs).every(Boolean)
  const missingWindowsInstalls = prereqs
    ? (['wsl', 'gcloud'] as const).filter((key) => isWindows && !prereqs[key])
    : []

  async function handleInstallMissingWindowsPrereqs() {
    setInstalling(true)
    setPrereqError('')
    setPrereqMessage('')
    try {
      const result = await window.api.installMissingWindowsPrerequisites()
      if (result.installed.length === 0) {
        setPrereqMessage('Nothing to install. Everything already looks present.')
      } else {
        const label = result.installed.join(', ')
        setPrereqMessage(
          result.restartRequired
            ? `Installed or started: ${label}. Restart Windows if prompted, then re-check.`
            : `Installed or started: ${label}. Re-check after the installers finish.`
        )
      }
      await checkPrereqs()
    } catch (e: any) {
      setPrereqError(e?.message ?? 'Automatic installation failed.')
    } finally {
      setInstalling(false)
    }
  }

  async function handleGcloudAuth(target: 'gcloud-auth' | 'adc') {
    setAuthenticating(target)
    setPrereqError('')
    setPrereqMessage('')
    try {
      await window.api.runGcloudAuth(target)
      // runGcloudAuth returns immediately — the browser is open for the user to complete auth.
      setPrereqMessage(
        target === 'adc'
          ? 'A browser window has opened for ADC setup. Complete sign-in, then click Re-check.'
          : 'A browser window has opened for gcloud sign-in. Complete sign-in, then click Re-check.'
      )
    } catch (e: any) {
      setPrereqError(e?.message ?? 'Authentication failed.')
    } finally {
      setAuthenticating('')
    }
  }

  // Step 3 — save config + run setup
  async function handleSave() {
    if (config.VNC_PASSWORD.length < 8) { setError('Password must be at least 8 characters.'); return }
    setSaving(true); setError('')
    try {
      await window.api.saveConfig(config)
      navigate('/dashboard')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">

        {/* Logo */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">CloudTab</h1>
          <p className="mt-1 text-gray-400 text-sm">Secure remote Chrome on GCP</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          {[1,2,3].map(s => (
            <div key={s} className={`flex-1 h-1 rounded-full transition-colors ${step >= s ? 'bg-blue-500' : 'bg-gray-800'}`} />
          ))}
        </div>

        {/* ── Step 1: Prerequisites ── */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Check prerequisites</h2>
            <p className="text-gray-400 text-sm">CloudTab needs these tools installed on your machine.</p>

            {!prereqs && (
              <button onClick={checkPrereqs} disabled={checking}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors disabled:opacity-50">
                {checking ? 'Checking...' : 'Check now'}
              </button>
            )}

            {prereqs && (
              <div className="space-y-2">
                {Object.entries({
                  gcloud: 'Google Cloud SDK (gcloud)',
                  'gcloud-auth': 'gcloud auth login',
                  adc: 'gcloud auth application-default login',
                  ...(isWindows ? { wsl: 'WSL 2 + build-essential + terraform' } : {}),
                }).map(([k, label]) => (
                  <div key={k} className="flex items-center gap-3 bg-gray-900 rounded-lg px-4 py-3">
                    {prereqs[k]
                      ? <CheckCircle2 size={16} className="text-green-400 shrink-0" />
                      : <AlertCircle  size={16} className="text-red-400 shrink-0" />}
                    <span className="text-sm">{label}</span>
                    {!prereqs[k] && (
                      <span className="ml-auto text-xs text-red-400">Missing</span>
                    )}
                  </div>
                ))}

                {!prereqsOk && (
                  <div className="text-sm pt-1 space-y-1">
                    <p className="text-red-400">Install missing tools, then click Re-check.</p>
                    {isWindows && !prereqs['wsl'] && (
                      <p className="text-gray-400">
                        WSL is not ready. Click <strong className="text-white">Install missing on Windows</strong> below,
                        then restart when prompted.{' '}
                        After restart, open <strong className="text-white">Ubuntu</strong> from the Start menu once to
                        finish distro setup, then click Re-check.
                      </p>
                    )}
                  </div>
                )}

                {prereqError && (
                  <p className="text-sm text-red-400 flex items-center gap-1">
                    <AlertCircle size={14} /> {prereqError}
                  </p>
                )}

                {prereqMessage && (
                  <p className="text-sm text-gray-300">{prereqMessage}</p>
                )}

                {isWindows && missingWindowsInstalls.length > 0 && (
                  <button onClick={handleInstallMissingWindowsPrereqs} disabled={installing || checking}
                    className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                    {installing
                      ? <><Loader2 size={16} className="animate-spin" />Installing prerequisites…</>
                      : <>Install missing on Windows</>}
                  </button>
                )}

                {prereqs['gcloud'] && !prereqs['gcloud-auth'] && (
                  <button onClick={() => handleGcloudAuth('gcloud-auth')} disabled={!!authenticating || checking}
                    className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                    {authenticating === 'gcloud-auth'
                      ? <><Loader2 size={16} className="animate-spin" />Opening gcloud login…</>
                      : <>Sign in to gcloud</>}
                  </button>
                )}

                {prereqs['gcloud'] && prereqs['gcloud-auth'] && !prereqs['adc'] && (
                  <button onClick={() => handleGcloudAuth('adc')} disabled={!!authenticating || checking}
                    className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                    {authenticating === 'adc'
                      ? <><Loader2 size={16} className="animate-spin" />Configuring ADC…</>
                      : <>Set up application default credentials</>}
                  </button>
                )}

                <div className="flex gap-2 pt-2">
                  <button onClick={() => { setAuthenticating(''); checkPrereqs() }}
                    className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors">
                    Re-check
                  </button>
                  <button onClick={() => setStep(2)} disabled={!prereqsOk}
                    className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1">
                    Continue <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: GCP Config ── */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">GCP configuration</h2>
            <p className="text-gray-400 text-sm">CloudTab will provision infrastructure in your GCP project.</p>

            <Field label="GCP Project ID" required>
              <input value={config.PROJECT_ID} onChange={set('PROJECT_ID')}
                placeholder="my-gcp-project"
                className="input" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Region">
                <input value={config.REGION} onChange={set('REGION')} className="input" />
              </Field>
              <Field label="Zone">
                <input value={config.ZONE} onChange={set('ZONE')} className="input" />
              </Field>
            </div>

            <Field label="VM name">
              <input value={config.VM_NAME} onChange={set('VM_NAME')} className="input" />
            </Field>

            <Field label="Machine type">
              <select value={config.MACHINE_TYPE} onChange={set('MACHINE_TYPE')} className="input">
                {MACHINE_TYPES.map(m => (
                  <option key={m.value} value={m.value}>
                    {m.label} — {m.spec} ({m.cost}) {m.note}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Disk size (GB)">
                <input type="number" value={config.DISK_SIZE_GB} onChange={set('DISK_SIZE_GB')} className="input" />
              </Field>
              <Field label="Spot VM (cheaper)">
                <select value={config.PREEMPTIBLE} onChange={set('PREEMPTIBLE')} className="input">
                  <option value="false">No (stable)</option>
                  <option value="true">Yes (~70% off)</option>
                </select>
              </Field>
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(1)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors">
                Back
              </button>
              <button onClick={() => setStep(3)} disabled={!config.PROJECT_ID}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1">
                Continue <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Security ── */}
        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Security</h2>
            <p className="text-gray-400 text-sm">Set a strong password for your noVNC session.</p>

            <Field label="VNC Password" required hint="Minimum 8 characters">
              <input type="password" value={config.VNC_PASSWORD} onChange={set('VNC_PASSWORD')}
                placeholder="••••••••"
                className="input" />
            </Field>

            <Field label="Display resolution">
              <select value={config.RESOLUTION} onChange={set('RESOLUTION')} className="input">
                <option value="1920x1080x24">1920×1080 (Full HD)</option>
                <option value="2560x1440x24">2560×1440 (2K)</option>
                <option value="1280x800x24">1280×800 (compact)</option>
              </select>
            </Field>

            {error && (
              <p className="text-sm text-red-400 flex items-center gap-1">
                <AlertCircle size={14} /> {error}
              </p>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(2)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors">
                Back
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors disabled:opacity-50">
                {saving ? 'Setting up...' : 'Save & continue'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm text-gray-300">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
        {hint && <span className="text-gray-500 ml-2 text-xs">{hint}</span>}
      </label>
      {children}
    </div>
  )
}
