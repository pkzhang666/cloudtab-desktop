import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, AlertCircle, Save, Trash2, Loader2, CheckCircle2 } from 'lucide-react'

const MACHINE_TYPES = [
  { value: 'e2-medium',     spec: '1 vCPU / 4 GB',  cost: '~$9/mo' },
  { value: 'e2-standard-2', spec: '2 vCPU / 8 GB',  cost: '~$11/mo' },
  { value: 'e2-standard-4', spec: '4 vCPU / 16 GB', cost: '~$19/mo' },
]

const DEFAULTS: Record<string, string> = {
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
}

export default function Settings() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<Record<string, string>>(DEFAULTS)
  const [loaded,    setLoaded]    = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [destroying,setDestroying]= useState(false)
  const [error,     setError]     = useState('')
  const [saved,     setSaved]     = useState(false)

  useEffect(() => {
    window.api.getConfig()
      .then(cfg => setConfig({ ...DEFAULTS, ...cfg }))
      .catch(() => setConfig(DEFAULTS))
      .finally(() => setLoaded(true))
  }, [])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setConfig(c => ({ ...c, [k]: e.target.value }))

  async function handleSave() {
    if (!config.PROJECT_ID.trim()) { setError('Project ID is required.'); return }
    if (!config.VM_NAME.trim())    { setError('VM name is required.'); return }
    if (config.VNC_PASSWORD && config.VNC_PASSWORD.length < 8) {
      setError('Password must be at least 8 characters.'); return
    }
    setSaving(true); setError('')
    try {
      await window.api.saveConfig(config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save config.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDestroy() {
    if (!confirm(
      'This will permanently destroy all GCP infrastructure (VM, VPC, firewall rules, NAT).\n\n' +
      'Your Chrome profile data will be lost. This cannot be undone.\n\nContinue?'
    )) return
    setDestroying(true); setError('')
    try { await window.api.tfDestroy() }
    catch (e: any) { setError(e?.message ?? 'Destroy failed.') }
    finally { setDestroying(false) }
  }

  if (!loaded) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      <header className="flex items-center gap-3 px-5 py-3 border-b border-gray-800">
        <button onClick={() => navigate('/dashboard')}
          className="p-1.5 rounded-md hover:bg-gray-800 transition-colors">
          <ChevronLeft size={16} className="text-gray-400" />
        </button>
        <h1 className="font-semibold">Settings</h1>
      </header>

      <main className="flex-1 p-5 space-y-6 overflow-y-auto">

        {/* GCP */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">GCP Configuration</h2>

          <Field label="Project ID" required>
            <input value={config.PROJECT_ID} onChange={set('PROJECT_ID')}
              placeholder="my-gcp-project" className="input" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Region">
              <input value={config.REGION} onChange={set('REGION')} className="input" />
            </Field>
            <Field label="Zone">
              <input value={config.ZONE} onChange={set('ZONE')} className="input" />
            </Field>
          </div>

          <Field label="VM Name" required>
            <input value={config.VM_NAME} onChange={set('VM_NAME')} className="input" />
          </Field>

          <Field label="Machine Type">
            <select value={config.MACHINE_TYPE} onChange={set('MACHINE_TYPE')} className="input">
              {MACHINE_TYPES.map(m => (
                <option key={m.value} value={m.value}>
                  {m.value} — {m.spec} ({m.cost})
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Disk Size (GB)">
              <input type="number" min="20" value={config.DISK_SIZE_GB} onChange={set('DISK_SIZE_GB')} className="input" />
            </Field>
            <Field label="Spot VM">
              <select value={config.PREEMPTIBLE} onChange={set('PREEMPTIBLE')} className="input">
                <option value="false">No (stable)</option>
                <option value="true">Yes (~70% cheaper)</option>
              </select>
            </Field>
          </div>
        </section>

        {/* Security */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Security</h2>

          <Field label="VNC Password" hint="Leave blank to keep current">
            <input type="password" value={config.VNC_PASSWORD} onChange={set('VNC_PASSWORD')}
              placeholder="min 8 characters" className="input" />
          </Field>

          <Field label="Display Resolution">
            <select value={config.RESOLUTION} onChange={set('RESOLUTION')} className="input">
              <option value="1920x1080x24">1920×1080 (Full HD)</option>
              <option value="2560x1440x24">2560×1440 (2K)</option>
              <option value="1280x800x24">1280×800 (compact)</option>
            </select>
          </Field>
        </section>

        {error && (
          <p className="text-sm text-red-400 flex items-center gap-1.5">
            <AlertCircle size={14} />{error}
          </p>
        )}

        <button onClick={handleSave} disabled={saving}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
          {saving
            ? <><Loader2 size={16} className="animate-spin" />Saving…</>
            : saved
            ? <><CheckCircle2 size={16} className="text-green-300" />Saved!</>
            : <><Save size={16} />Save changes</>}
        </button>

        {/* Danger zone */}
        <section className="space-y-3 pt-2">
          <h2 className="text-xs font-semibold text-red-500 uppercase tracking-wider">Danger Zone</h2>
          <div className="bg-gray-900 rounded-xl p-4 space-y-3">
            <p className="text-sm text-gray-400">
              Permanently destroy all GCP infrastructure provisioned by CloudTab.
              Your Chrome profile data will be lost.
            </p>
            <button onClick={handleDestroy} disabled={destroying}
              className="w-full py-2.5 bg-red-900/50 hover:bg-red-800/60 border border-red-700/50 rounded-xl text-red-400 font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {destroying
                ? <><Loader2 size={16} className="animate-spin" />Destroying…</>
                : <><Trash2 size={16} />Destroy infrastructure</>}
            </button>
          </div>
        </section>

      </main>
    </div>
  )
}

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm text-gray-300">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
        {hint && <span className="text-gray-500 ml-2 text-xs">{hint}</span>}
      </label>
      {children}
    </div>
  )
}
