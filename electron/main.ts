import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { spawn, execFile, ChildProcess } from 'child_process'

type WindowsInstallTarget = 'wsl' | 'gcloud' | 'terraform' | 'docker'
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
      // Ask PowerShell to resolve the command using the *current* system PATH
      // (the Electron process inherits a stale PATH from launch time; newly installed
      //  tools only appear after reading from the registry)
      const result = require('child_process').spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command',
         `$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User'); Get-Command '${cmd.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source`],
        { stdio: 'pipe' },
      )
      return result.status === 0
    } else {
      const result = require('child_process').spawnSync('which', [cmd], { stdio: 'pipe' })
      return result.status === 0
    }
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
  const ps = require('child_process').spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command',
     `$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User'); (Get-Command '${cmd.replace(/'/g, "''")}' -ErrorAction SilentlyContinue).Source`],
    { encoding: 'utf8', stdio: 'pipe' },
  )
  const resolved = (ps.stdout || '').trim()
  return resolved || null
}

// Run a gcloud command safely — args passed as array, never interpolated into a string
function gcloud(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const freshEnv = isWindows ? freshWindowsEnv() : undefined
    const gcloudBin = isWindows ? (resolveWindowsCommandPath('gcloud') || 'gcloud') : 'gcloud'
    execFile(gcloudBin, args, { encoding: 'utf8', ...(freshEnv && { env: freshEnv }) },
      (err, stdout: string, stderr: string) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout.trim())
      })
  })
}

// Run a bash script — on Windows, delegate to WSL
function runScript(script: string, args: string[] = []): Promise<string> {
  const scriptPath = join(CORE_DIR, 'scripts', script)
  const [cmd, cmdArgs] = isWindows
    ? ['wsl', ['bash', toWslPath(scriptPath), ...args]]
    : ['bash', [scriptPath, ...args]]

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, {
      env: { ...process.env, CORE_DIR: isWindows ? toWslPath(CORE_DIR) : CORE_DIR },
    })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || `Script exited with code ${code}`)))
    proc.on('error', reject)
  })
}

// Run a make target — on Windows, delegate to WSL
function runMake(target: string): Promise<string> {
  const makefileDir = CORE_DIR
  const [cmd, cmdArgs] = isWindows
    ? ['wsl', ['make', '-C', toWslPath(makefileDir), target]]
    : ['make', ['-C', makefileDir, target]]

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { env: process.env })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || `make ${target} exited with code ${code}`)))
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
  for (const tool of ['gcloud', 'terraform', 'docker']) {
    results[tool] = commandExists(tool)
  }
  if (isWindows) results['wsl'] = commandExists('wsl')

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
  return join(getGcloudConfigDir(), 'application_default_credentials.json')
}

async function hasApplicationDefaultCredentials(): Promise<boolean> {
  if (!commandExists('gcloud')) return false

  // Prefer real token validation to avoid false positives from stale credential files.
  try {
    await gcloud(['auth', 'application-default', 'print-access-token'])
    return true
  } catch {
    return false
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function runLoggedProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = isWindows ? freshWindowsEnv() : process.env
    const executable = isWindows ? (resolveWindowsCommandPath(command) || command) : command
    const proc = spawn(executable, args, { env, windowsHide: false })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
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
      mainWindow?.webContents.send('log', 'Installing WSL 2...\n')
      await runElevatedWindowsProcess('wsl', ['--install'])
      return { restartRequired: true }
    case 'gcloud':
      mainWindow?.webContents.send('log', 'Installing Google Cloud SDK with winget...\n')
      await runElevatedWindowsProcess('winget', ['install', '--id', 'Google.CloudSDK', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'])
      return { restartRequired: false }
    case 'terraform':
      mainWindow?.webContents.send('log', 'Installing Terraform with winget...\n')
      await runElevatedWindowsProcess('winget', ['install', '--id', 'Hashicorp.Terraform', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'])
      return { restartRequired: false }
    case 'docker':
      mainWindow?.webContents.send('log', 'Installing Docker Desktop with winget...\n')
      await runElevatedWindowsProcess('winget', ['install', '--id', 'Docker.DockerDesktop', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'])
      return { restartRequired: false }
  }
}

async function installMissingWindowsPrerequisites(): Promise<{ installed: WindowsInstallTarget[]; restartRequired: boolean }> {
  const current = await getPrerequisiteStatus()
  const installOrder: WindowsInstallTarget[] = ['wsl', 'gcloud', 'terraform', 'docker']
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

  mainWindow?.webContents.send('log', `Running gcloud ${args.join(' ')}...\n`)
  await runLoggedProcess('gcloud', args)
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
    const gcloudBin = isWindows ? (resolveWindowsCommandPath('gcloud') || 'gcloud') : 'gcloud'
    const proc = spawn(gcloudBin, [
      'compute', 'ssh', env.VM_NAME,
      `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`,
      '--tunnel-through-iap',
      '--', '-L', '8080:localhost:8080', '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
    ], { env: envForTunnel, windowsHide: false })

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
