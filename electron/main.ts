import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { spawn, execSync, ChildProcess } from 'child_process'

const isWindows = process.platform === 'win32'
const isMac     = process.platform === 'darwin'

// Required for headless Linux / GCP VMs with Xvfb.
// On Windows/Mac these are no-ops or handled by the OS.
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
    // hiddenInset gives the traffic-light buttons on Mac;
    // 'hidden' on Windows/Linux removes the default title bar for a clean look
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isWindows && { titleBarOverlay: { color: '#0a0a0f', symbolColor: '#9ca3af', height: 32 } }),
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

// Convert a Windows absolute path to a WSL path: C:\foo\bar → /mnt/c/foo/bar
function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)
    .replace(/\\/g, '/')
}

// Check whether a CLI tool exists on PATH
function commandExists(cmd: string): boolean {
  try {
    execSync(isWindows ? `where "${cmd}"` : `command -v ${cmd}`, { stdio: 'ignore' })
    return true
  } catch { return false }
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
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)))
  })
}

// Run a make target — on Windows, delegate to WSL
function runMake(target: string, env: Record<string, string> = {}): Promise<string> {
  const [cmd, cmdArgs] = isWindows
    ? ['wsl', ['make', '-C', toWslPath(CORE_DIR), target]]
    : ['make', ['-C', CORE_DIR, target]]

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { env: { ...process.env, ...env } })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('log', d.toString()) })
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)))
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

// ── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.handle('check-prerequisites', async () => {
  const results: Record<string, boolean> = {}

  for (const tool of ['gcloud', 'terraform', 'docker']) {
    results[tool] = commandExists(tool)
  }

  // On Windows, also require WSL
  if (isWindows) {
    results['wsl'] = commandExists('wsl')
  }

  try { execSync('gcloud auth print-access-token', { stdio: 'ignore' }); results['gcloud-auth'] = true }
  catch { results['gcloud-auth'] = false }

  try { execSync('gcloud auth application-default print-access-token', { stdio: 'ignore' }); results['adc'] = true }
  catch { results['adc'] = false }

  return results
})

ipcMain.handle('get-config', () => readEnv())

ipcMain.handle('save-config', async (_e, config: Record<string, string>) => {
  writeEnv(config)
  await runScript('setup.sh')
})

ipcMain.handle('vm-status', async () => {
  const env = readEnv()
  if (!env.PROJECT_ID || !env.VM_NAME || !env.ZONE) return 'NOT_CONFIGURED'
  try {
    const out = execSync(
      `gcloud compute instances describe ${env.VM_NAME} --zone=${env.ZONE} --project=${env.PROJECT_ID} --format=value(status)`,
      { encoding: 'utf8' }
    )
    return out.trim()
  } catch { return 'NOT_FOUND' }
})

ipcMain.handle('deploy',   async () => runMake('deploy'))

ipcMain.handle('vm-start', async () => {
  const env = readEnv()
  execSync(`gcloud compute instances start ${env.VM_NAME} --zone=${env.ZONE} --project=${env.PROJECT_ID} --quiet`)
})

ipcMain.handle('vm-stop', async () => {
  const env = readEnv()
  execSync(`gcloud compute instances stop ${env.VM_NAME} --zone=${env.ZONE} --project=${env.PROJECT_ID} --quiet`)
})

ipcMain.handle('open-tunnel', async () => {
  if (tunnelProcess) return { ok: true, port: 8080 }
  const env = readEnv()
  tunnelProcess = spawn('gcloud', [
    'compute', 'ssh', env.VM_NAME,
    `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`,
    '--tunnel-through-iap',
    '--', '-L', '8080:localhost:8080', '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
  ])
  tunnelProcess.on('close', () => { tunnelProcess = null })
  await new Promise(r => setTimeout(r, 4000))
  return { ok: true, port: 8080 }
})

ipcMain.handle('close-tunnel', async () => {
  tunnelProcess?.kill()
  tunnelProcess = null
})

ipcMain.handle('open-novnc', async () => {
  mainWindow?.loadURL('http://localhost:8080')
})

ipcMain.handle('close-novnc', async () => {
  if (isDev) mainWindow?.loadURL((process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173') + '#/dashboard')
  else mainWindow?.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
})

ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

ipcMain.handle('tf-destroy', async () => runMake('tf-destroy'))
