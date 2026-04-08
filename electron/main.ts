import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { spawn, execFile, ChildProcess } from 'child_process'

type WindowsInstallTarget = 'wsl' | 'gcloud'
type GcloudAuthTarget = 'gcloud-auth' | 'adc'

const isWindows = process.platform === 'win32'
const isMac     = process.platform === 'darwin'

// Required for headless Linux / GCP VMs with Xvfb
if (!isWindows && !isMac) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}
app.commandLine.appendSwitch('disable-gpu')

// ── Paths ──────────────────────────────────────────────────────────────────
const isDev = !app.isPackaged
const CORE_DIR = isDev
  ? join(app.getAppPath(), 'core')
  : join(process.resourcesPath, 'core')
const CONFIG_DIR = join(app.getPath('userData'), 'config')
const ENV_FILE   = join(CONFIG_DIR, '.env')

let mainWindow: BrowserWindow | null = null
let tunnelProcess: ChildProcess | null = null

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 800,
    minHeight: 560,
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
    }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  mkdirSync(CONFIG_DIR, { recursive: true })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  tunnelProcess?.kill()
  if (!isMac) app.quit()
})

// ── Shell helpers ──────────────────────────────────────────────────────────

// Convert a Windows absolute path to a WSL path: C:\foo → /mnt/c/foo
function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)
    .replace(/\\/g, '/')
}

// Check whether a CLI tool exists on PATH (injection-safe: no shell)
function commandExists(cmd: string): boolean {
  try {
    if (isWindows) {
      return !!resolveWindowsCommandPath(cmd)
    } else {
      const result = require('child_process').spawnSync('which', [cmd], { stdio: 'pipe' })
      return result.status === 0
    }
  } catch { return false }
}

// wsl.exe may exist but have zero distributions installed.
// Run `wsl --list --quiet` and check for at least one line of output.
function wslHasDistro(): boolean {
  try {
    const result = require('child_process').spawnSync(
      'wsl.exe', ['--list', '--quiet'],
      { encoding: 'utf16le', stdio: 'pipe', env: freshWindowsEnv() },  // wsl outputs UTF-16 LE
    )
    if (result.status !== 0) return false
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(Boolean)
    return lines.length > 0
  } catch { return false }
}

// Read the current merged PATH from the Windows registry so newly installed tools
// are visible even though the Electron process was started before they were installed.
function freshWindowsEnv(): NodeJS.ProcessEnv {
  const ps = require('child_process').spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command',
     "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: 'utf8', stdio: 'pipe' },
  )
  const freshPath: string = ps.stdout?.trim() || process.env.PATH || ''
  return { ...process.env, PATH: freshPath }
}

function resolveWindowsCommandPath(cmd: string): string | null {
  const result = require('child_process').spawnSync(
    'where.exe',
    [cmd],
    { encoding: 'utf8', stdio: 'pipe', env: freshWindowsEnv() },
  )
  if (result.status !== 0) return null

  const candidates = String(result.stdout || '')
    .split(/\r?\n/)
    .map((s: string) => s.trim())
    .filter(Boolean)

  const preferred = candidates.find((p: string) => /\.exe$/i.test(p))
    || candidates.find((p: string) => /\.cmd$/i.test(p))
    || candidates.find((p: string) => /\.bat$/i.test(p))
    || candidates[0]

  return preferred || null
}

// Run a gcloud command safely — args passed as array, never interpolated into a string.
// On Windows, gcloud is a .cmd file and cannot be spawned directly — use cmd.exe /c.
function gcloud(args: string[], timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const freshEnv = isWindows ? freshWindowsEnv() : undefined
    const [cmd, cmdArgs] = isWindows
      ? ['cmd.exe', ['/c', 'gcloud', ...args]]
      : ['gcloud', args]
    execFile(cmd, cmdArgs, {
      encoding: 'utf8',
      ...(freshEnv && { env: freshEnv }),
      ...(timeoutMs && { timeout: timeoutMs }),
    }, (err, stdout: string, stderr: string) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  })
}

// Run a bash script — on Windows, delegate to WSL
function runScript(script: string, args: string[] = []): Promise<string> {
  if (isWindows && !wslHasDistro()) {
    return Promise.reject(new Error(
      'WSL has no Linux distribution installed. Open a terminal and run: wsl --install -d Ubuntu\n' +
      'Then restart, launch Ubuntu once to finish setup, and try again.'
    ))
  }
  const scriptPath = join(CORE_DIR, 'scripts', script)
  const [cmd, cmdArgs] = isWindows
    ? ['wsl', ['--user', 'root', '--', 'env', '-i', ...buildWslLinuxEnv(), 'bash', toWslPath(scriptPath), ...args]]
    : ['bash', [scriptPath, ...args]]

  return new Promise((resolve, reject) => {
    const env = isWindows ? freshWindowsEnv() : process.env
    const proc = spawn(cmd, cmdArgs, { env })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(out)
      } else if (err.includes('command not found')) {
        reject(new Error(`${err}\n\nInstall missing tools in Ubuntu: sudo apt update && sudo apt install -y build-essential`))
      } else {
        reject(new Error(err || `Script exited with code ${code}`))
      }
    })
    proc.on('error', reject)
  })
}

// Run a make target — on Windows, delegate to WSL
function runMake(target: string): Promise<string> {
  if (isWindows && !wslHasDistro()) {
    return Promise.reject(new Error(
      'WSL has no Linux distribution installed. Open a terminal and run: wsl --install -d Ubuntu\n' +
      'Then restart, launch Ubuntu once to finish setup, and try again.'
    ))
  }
  const makefileDir = CORE_DIR
  const [cmd, cmdArgs] = isWindows
    ? ['wsl', ['--user', 'root', '--', 'env', '-i', ...buildWslLinuxEnv(), 'make', '-C', toWslPath(makefileDir), target]]
    : ['make', ['-C', makefileDir, target]]

  return new Promise((resolve, reject) => {
    const env = isWindows ? freshWindowsEnv() : process.env
    const proc = spawn(cmd, cmdArgs, { env })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(out)
      } else if (err.includes('make: command not found')) {
        reject(new Error(`make not found in Ubuntu.\n\nRun this in Ubuntu to install it:\n  sudo apt update && sudo apt install -y build-essential`))
      } else {
        reject(new Error(err || `make ${target} exited with code ${code}`))
      }
    })
    proc.on('error', reject)
  })
}

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {}
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => {
        const [k, ...v] = l.split('=')
        return [k.trim(), v.join('=').trim()]
      })
  )
}

function writeEnv(config: Record<string, string>) {
  const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`)
  writeFileSync(ENV_FILE, lines.join('\n') + '\n')
  writeFileSync(join(CORE_DIR, '.env'), lines.join('\n') + '\n')
}

// Validate required config keys before running gcloud commands
function requireConfig(env: Record<string, string>, keys: string[]): void {
  const missing = keys.filter(k => !env[k])
  if (missing.length) throw new Error(`Missing config: ${missing.join(', ')}. Please complete setup first.`)
}

async function getPrerequisiteStatus(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {}
  // Windows: only gcloud and wsl + distro
  results['gcloud'] = commandExists('gcloud')
  if (isWindows) {
    results['wsl'] = commandExists('wsl') && wslHasDistro()
    if (results['wsl']) {
      // Auto-install build-essential, terraform, docker, gcloud in WSL
      results['wsl'] = await ensureWslEnvironment()
    }
  }

  results['gcloud-auth'] = await hasActiveGcloudLogin()
  results['adc'] = await hasApplicationDefaultCredentials()

  return results
}

async function hasActiveGcloudLogin(): Promise<boolean> {
  if (!commandExists('gcloud')) return false

  // Most reliable signal for regular gcloud auth login.
  try {
    const configuredAccount = await gcloud(['config', 'get-value', 'account', '--quiet'])
    if (configuredAccount.trim() && configuredAccount.trim() !== '(unset)') return true
  } catch {
    // keep checking fallbacks
  }

  try {
    const activeAccount = await gcloud([
      'auth',
      'list',
      '--filter=status:ACTIVE',
      '--format=value(account)',
    ])
    return activeAccount.trim().length > 0
  } catch {
    // Final fallback for Windows sessions where CLI state exists but account query fails.
    return existsSync(join(getGcloudConfigDir(), 'credentials.db'))
  }
}

function getGcloudConfigDir(): string {
  if (isWindows) {
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
    return join(appData, 'gcloud')
  }
  return join(process.env.HOME || '', '.config', 'gcloud')
}

function getAdcCredentialPath(): string {
  // Respect CLOUDSDK_CONFIG if the user has set it (overrides default config dir)
  const sdkConfig = process.env.CLOUDSDK_CONFIG
  if (sdkConfig) return join(sdkConfig, 'application_default_credentials.json')
  return join(getGcloudConfigDir(), 'application_default_credentials.json')
}

async function hasApplicationDefaultCredentials(): Promise<boolean> {
  if (!commandExists('gcloud')) return false

  // Fast path: credential file presence is the reliable signal.
  // Avoids hanging on print-access-token while another gcloud auth process is in flight.
  if (existsSync(getAdcCredentialPath())) return true

  // Fallback: validate via token with a 10-second timeout to avoid hanging.
  try {
    await gcloud(['auth', 'application-default', 'print-access-token'], 10_000)
    return true
  } catch {
    return false
  }
}

// Build KEY=VALUE pairs for `env -i` inside WSL.
// Provides a clean Linux environment (no Windows PATH translation warnings)
// and shares gcloud/ADC credentials from Windows so WSL gcloud uses the
// same auth state — users don't need to authenticate twice.
function buildWslLinuxEnv(): string[] {
  const pairs: string[] = [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME=/root',
    'SHELL=/bin/bash',
    'DEBIAN_FRONTEND=noninteractive',
  ]
  if (isWindows) {
    const gcloudConfigWsl = toWslPath(getGcloudConfigDir())
    // Let gcloud in WSL share the same credentials as Windows gcloud
    pairs.push(`CLOUDSDK_CONFIG=${gcloudConfigWsl}`)
    // Let terraform / other ADC-aware tools find credentials (terraform ignores CLOUDSDK_CONFIG)
    pairs.push(`GOOGLE_APPLICATION_CREDENTIALS=${gcloudConfigWsl}/application_default_credentials.json`)
  }
  return pairs
}

// Auto-install all required Linux tools in WSL (idempotent — safe to call on every Re-check).
// Installs: build-essential, terraform (HashiCorp APT), docker.io + docker-compose, google-cloud-cli (Google APT).
// Returns true when all tools are present after the attempt.
async function ensureWslEnvironment(): Promise<boolean> {
  if (!isWindows || !wslHasDistro()) return false

  const wslEnv = freshWindowsEnv()

  // Quick check: all tools already present?
  const quickCheck = require('child_process').spawnSync(
    'wsl',
    ['--user', 'root', '--', 'bash', '-c',
     'command -v make && command -v terraform && command -v docker && command -v gcloud'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, env: wslEnv },
  )
  if (quickCheck.status === 0) return true

  mainWindow?.webContents.send('log', 'Installing required tools in Ubuntu (this may take a few minutes)...\n')

  // Build the install script as a joined string to avoid TypeScript template-literal
  // interpolation of bash variables like ${VAR} or line-continuation escaping issues.
  const installScript = [
    'set -e',
    'DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y curl gnupg software-properties-common lsb-release apt-transport-https ca-certificates build-essential',
    // Docker
    'if ! command -v docker >/dev/null 2>&1; then',
    '  apt-get install -y docker.io docker-compose',
    'fi',
    // Terraform — not in Ubuntu repos, requires HashiCorp APT repo
    'if ! command -v terraform >/dev/null 2>&1; then',
    '  curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg',
    '  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/hashicorp.list',
    '  apt-get update -qq',
    '  apt-get install -y terraform',
    'fi',
    // Google Cloud CLI
    'if ! command -v gcloud >/dev/null 2>&1; then',
    '  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg',
    '  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list',
    '  apt-get update -qq',
    '  apt-get install -y google-cloud-cli',
    'fi',
    'echo "All WSL tools installed."',
  ].join('\n')

  const install = require('child_process').spawnSync(
    'wsl',
    ['--user', 'root', '--', 'bash', '-c', installScript],
    { encoding: 'utf8', stdio: 'pipe', timeout: 600_000, env: wslEnv },  // 10 min max
  )

  if (install.status === 0) {
    mainWindow?.webContents.send('log', 'WSL environment ready.\n')
    return true
  }

  mainWindow?.webContents.send('log', `WSL tool installation failed:\n${install.stderr}\n`)
  return false
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// On Windows, CLI tools like gcloud are .cmd files — spawn via cmd.exe /c.
// stdin is closed ('ignore') so interactive gcloud auth flows don't block waiting for input.
function runLoggedProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = isWindows ? freshWindowsEnv() : process.env
    const [cmd, cmdArgs] = isWindows
      ? ['cmd.exe', ['/c', command, ...args]]
      : [command, args]
    const proc = spawn(cmd, cmdArgs, { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    proc.stdout!.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr!.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `${command} exited with code ${code}`)))
    proc.on('error', reject)
  })
}

function runElevatedWindowsProcess(command: string, args: string[]): Promise<void> {
  if (!isWindows) throw new Error('Windows installer flow is only available on Windows.')

  const argList = args.map(quotePowerShell).join(', ')
  const script = `$p = Start-Process -FilePath ${quotePowerShell(command)} -Verb RunAs -Wait -PassThru -ArgumentList @(${argList}); exit $p.ExitCode`

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: process.env,
      windowsHide: false,
    })
    let err = ''
    proc.stdout.on('data', (d) => mainWindow?.webContents.send('log', d.toString()))
    proc.stderr.on('data', (d) => {
      err += d
      mainWindow?.webContents.send('log', d.toString())
    })
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `Installation exited with code ${code}`)))
    proc.on('error', reject)
  })
}

async function installWindowsPrerequisite(target: WindowsInstallTarget): Promise<{ restartRequired: boolean }> {
  if (!commandExists('winget') && target !== 'wsl') {
    throw new Error('winget is required for automatic installs. Install App Installer from Microsoft Store first.')
  }

  switch (target) {
    case 'wsl':
      mainWindow?.webContents.send('log', 'Installing WSL 2 and Ubuntu 24.04...\n')
      // After restart, build-essential will be auto-installed on the next Re-check.
      await runElevatedWindowsProcess('wsl', ['--install', '-d', 'Ubuntu-24.04'])
      mainWindow?.webContents.send('log', 'WSL installation queued. Restart Windows when prompted.\n')
      return { restartRequired: true }
    case 'gcloud':
      mainWindow?.webContents.send('log', 'Installing Google Cloud SDK with winget...\n')
      await runElevatedWindowsProcess('winget', ['install', '--id', 'Google.CloudSDK', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'])
      return { restartRequired: false }
  }
}

async function installMissingWindowsPrerequisites(): Promise<{ installed: WindowsInstallTarget[]; restartRequired: boolean }> {
  const current = await getPrerequisiteStatus()
  const installOrder: WindowsInstallTarget[] = ['wsl', 'gcloud']
  const installed: WindowsInstallTarget[] = []
  let restartRequired = false

  for (const target of installOrder) {
    if (!current[target]) {
      const result = await installWindowsPrerequisite(target)
      installed.push(target)
      restartRequired = restartRequired || result.restartRequired
    }
  }

  return { installed, restartRequired }
}

async function runGcloudAuth(target: GcloudAuthTarget): Promise<void> {
  if (!commandExists('gcloud')) {
    throw new Error('gcloud is not installed yet.')
  }

  const args = target === 'adc'
    ? ['auth', 'application-default', 'login']
    : ['auth', 'login']

  mainWindow?.webContents.send('log', `Launching: gcloud ${args.join(' ')}...\n`)

  // Launch gcloud auth as a detached, independent process so the browser-based
  // OAuth flow doesn't block the IPC call. The IPC returns immediately;
  // the user completes login in the browser then clicks Re-check.
  const env = isWindows ? freshWindowsEnv() : process.env
  const [cmd, cmdArgs] = isWindows
    ? ['cmd.exe', ['/c', 'gcloud', ...args]]
    : ['gcloud', args]
  const child = spawn(cmd, cmdArgs, { env, windowsHide: false, stdio: 'ignore', detached: true })
  child.unref()
}

// ── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.handle('check-prerequisites', async () => getPrerequisiteStatus())

ipcMain.handle('install-missing-windows-prerequisites', async () => {
  return await installMissingWindowsPrerequisites()
})

ipcMain.handle('run-gcloud-auth', async (_e, target: GcloudAuthTarget) => {
  await runGcloudAuth(target)
})

ipcMain.handle('get-config', () => readEnv())

ipcMain.handle('save-config', async (_e, config: Record<string, string>) => {
  writeEnv(config)
  // setup.sh generates terraform.tfvars from .env — non-fatal if it fails in fresh installs
  try { await runScript('setup.sh') } catch { /* tfvars generated on first deploy */ }
})

ipcMain.handle('vm-status', async () => {
  const env = readEnv()
  if (!env.PROJECT_ID || !env.VM_NAME || !env.ZONE) return 'NOT_CONFIGURED'
  try {
    return await gcloud([
      'compute', 'instances', 'describe', env.VM_NAME,
      `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`,
      '--format=value(status)',
    ])
  } catch { return 'NOT_FOUND' }
})

ipcMain.handle('deploy', async () => {
  await runMake('deploy')
})

ipcMain.handle('vm-start', async () => {
  const env = readEnv()
  requireConfig(env, ['VM_NAME', 'ZONE', 'PROJECT_ID'])
  await gcloud(['compute', 'instances', 'start', env.VM_NAME, `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`, '--quiet'])
})

ipcMain.handle('vm-stop', async () => {
  const env = readEnv()
  requireConfig(env, ['VM_NAME', 'ZONE', 'PROJECT_ID'])
  await gcloud(['compute', 'instances', 'stop', env.VM_NAME, `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`, '--quiet'])
})

ipcMain.handle('open-tunnel', async () => {
  if (tunnelProcess) return { ok: true, port: 8080 }
  const env = readEnv()
  requireConfig(env, ['VM_NAME', 'ZONE', 'PROJECT_ID'])

  return new Promise<{ ok: boolean; port: number }>((resolve, reject) => {
    const envForTunnel = isWindows ? freshWindowsEnv() : process.env
    const tunnelGcloudArgs = [
      'compute', 'ssh', env.VM_NAME,
      `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`,
      '--tunnel-through-iap',
      '--', '-L', '8080:localhost:8080', '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
    ]
    const [tunnelCmd, tunnelArgs] = isWindows
      ? ['cmd.exe' as string, ['/c', 'gcloud', ...tunnelGcloudArgs]]
      : ['gcloud' as string, tunnelGcloudArgs]
    const proc = spawn(tunnelCmd, tunnelArgs, { env: envForTunnel, windowsHide: false })

    proc.on('error', (err) => reject(err))

    // Give the tunnel up to 8s to establish before declaring success
    const timer = setTimeout(() => {
      tunnelProcess = proc
      proc.on('close', () => { tunnelProcess = null })
      resolve({ ok: true, port: 8080 })
    }, 8000)

    // If the process exits before the timer fires, the tunnel failed
    proc.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`IAP tunnel exited early (code ${code}). Is the VM running?`))
    })
  })
})

ipcMain.handle('close-tunnel', async () => {
  tunnelProcess?.kill()
  tunnelProcess = null
})

ipcMain.handle('open-novnc', async () => {
  mainWindow?.loadURL('http://localhost:8080/vnc.html?autoconnect=true&reconnect=true')
})

ipcMain.handle('close-novnc', async () => {
  if (isDev) mainWindow?.loadURL((process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173') + '#/dashboard')
  else mainWindow?.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
})

ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

ipcMain.handle('tf-destroy', async () => {
  await runMake('tf-destroy')
})
