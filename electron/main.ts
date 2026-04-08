import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { spawn, execFile, ChildProcess } from 'child_process'
import { createServer } from 'http'
import { createServer as createNetServer } from 'net'

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

// Enable remote debugging in dev so playwright/CDP can drive UI tests
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
const CORE_DIR = isDev
  ? join(app.getAppPath(), 'core')
  : join(process.resourcesPath, 'core')
const CONFIG_DIR = join(app.getPath('userData'), 'config')
const ENV_FILE   = join(CONFIG_DIR, '.env')

let mainWindow: BrowserWindow | null = null
let tunnelProcess: ChildProcess | null = null
let activeTunnelPort: number | null = null

// ── Dev bridge (SSE log streaming to plain browser) ─────────────────────────
const sseClients: Array<(line: string) => void> = []
function sendLog(msg: string): void {
  mainWindow?.webContents.send('log', msg)
  for (const c of sseClients) c(msg)
}

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
  if (isDev) startDevBridgeServer()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closeTunnelProcess()
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

// Returns the path to the true 64-bit System32 directory.
// On a 64-bit OS running a 32-bit process the Windows File System Redirector silently
// maps "System32" → "SysWOW64", which does NOT contain wsl.exe. The "Sysnative"
// virtual folder bypasses the redirector and points at the real 64-bit System32.
// Reference: https://learn.microsoft.com/en-us/windows/wsl/basic-commands
function winSys32(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const is32bitOnWin64 = process.arch !== 'x64' && require('os').arch() === 'x64'
  return join(root, is32bitOnWin64 ? 'Sysnative' : 'System32')
}

// Absolute path to wsl.exe — avoids PATH lookup entirely so spawn never fails
// with ENOENT regardless of what PATH the packaged Electron process inherited.
function wslExe(): string { return join(winSys32(), 'wsl.exe') }

// wsl.exe may exist but have zero distributions installed.
// Run `wsl --list --quiet` and check for at least one line of output.
function wslHasDistro(): boolean {
  try {
    const result = require('child_process').spawnSync(
      wslExe(), ['--list', '--quiet'],
      { encoding: 'utf16le', stdio: 'pipe' },  // wsl outputs UTF-16 LE
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
// Uses an absolute path for powershell.exe (via %SystemRoot%) so this works regardless
// of what PATH the packaged Electron app inherited.
// Uses ExpandEnvironmentVariables so tokens like %SystemRoot%\system32 are resolved
// to real paths before being stored — Node.js spawn does not expand them automatically.
function freshWindowsEnv(): NodeJS.ProcessEnv {
  const psExe = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  )
  const ps = require('child_process').spawnSync(
    psExe,
    ['-NoProfile', '-Command',
     "[System.Environment]::ExpandEnvironmentVariables([System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User'))"],
    { encoding: 'utf8', stdio: 'pipe' },
  )
  const freshPath: string = ps.stdout?.trim() || process.env.PATH || ''
  return { ...process.env, PATH: freshPath }
}

function resolveWindowsCommandPath(cmd: string): string | null {
  const result = require('child_process').spawnSync(
    join(winSys32(), 'where.exe'),
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
    const cmdExe = process.env.ComSpec ?? join(winSys32(), 'cmd.exe')
    const [cmd, cmdArgs] = isWindows
      ? [cmdExe, ['/c', 'gcloud', ...args]]
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
    ? [wslExe(), ['--user', 'root', '--', 'env', '-i', ...buildWslLinuxEnv(), 'bash', toWslPath(scriptPath), ...args]]
    : ['bash', [scriptPath, ...args]]

  return new Promise((resolve, reject) => {
    const env = isWindows ? freshWindowsEnv() : process.env
    const proc = spawn(cmd, cmdArgs, { env })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; sendLog(d.toString()) })
    proc.stderr.on('data', (d) => { err += d; sendLog(d.toString()) })
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
    ? [wslExe(), ['--user', 'root', '--', 'env', '-i', ...buildWslLinuxEnv(), 'make', '-C', toWslPath(makefileDir), target]]
    : ['make', ['-C', makefileDir, target]]

  return new Promise((resolve, reject) => {
    const env = isWindows ? freshWindowsEnv() : process.env
    const proc = spawn(cmd, cmdArgs, { env })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d; sendLog(d.toString()) })
    proc.stderr.on('data', (d) => { err += d; sendLog(d.toString()) })
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

// Read the Windows system proxy from the registry. Go binaries (like terraform.exe)
// do NOT automatically use the Windows proxy registry — they only honour HTTPS_PROXY/HTTP_PROXY
// environment variables. We read the registry and inject those vars so Terraform can
// reach Google APIs through the local HTTP proxy (e.g. Clash/v2ray at 127.0.0.1:10809).
function getWindowsProxyEnv(): Record<string, string> {
  try {
    const psExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = require('child_process').spawnSync(
      psExe,
      ['-NoProfile', '-Command',
       '$k="HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";' +
       '$e=Get-ItemProperty $k -EA SilentlyContinue;' +
       'if($e.ProxyEnable -eq 1 -and $e.ProxyServer){Write-Output $e.ProxyServer}'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 },
    )
    const server = (result.stdout as string)?.trim()
    if (server) {
      const proxyUrl = server.startsWith('http') ? server : `http://${server}`
      return { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: 'localhost,127.0.0.1,::1' }
    }
  } catch { /* ignore */ }
  return {}
}

// Run terraform on Windows — avoids WSL network issues (WSL in NAT mode cannot reach
// Google APIs directly; Windows has proxy access). Streams output via sendLog().
function runWindowsTerraform(args: string[], options?: { timeoutMs?: number }): Promise<string> {
  const terraformDir = join(CORE_DIR, 'terraform')
  const freshEnv = freshWindowsEnv()
  const adcPath = join(getGcloudConfigDir(), 'application_default_credentials.json')
  const env: NodeJS.ProcessEnv = {
    ...freshEnv,
    ...getWindowsProxyEnv(),
    GOOGLE_APPLICATION_CREDENTIALS: adcPath,
  }
  // Pre-fetch a fresh ADC access token so Terraform never needs to call
  // oauth2.googleapis.com.
  try {
    const cmdExe = process.env.ComSpec ?? join(winSys32(), 'cmd.exe')
    const result = require('child_process').spawnSync(
      cmdExe, ['/c', 'gcloud', 'auth', 'application-default', 'print-access-token'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, env: freshEnv },
    )
    const token = (result.stdout as string)?.trim()
    if (token && token.startsWith('ya29')) {
      env.GOOGLE_OAUTH_ACCESS_TOKEN = token
    }
  } catch { /* fallback to GOOGLE_APPLICATION_CREDENTIALS */ }
  // terraform.exe is on PATH (validated at startup via prerequisites check)
  return new Promise((resolve, reject) => {
    const timeoutMs = options?.timeoutMs ?? (args[0] === 'init' ? 3 * 60_000 : 0)
    const proc = spawn('terraform', args, { cwd: terraformDir, env })
    let out = '', err = ''
    let settled = false

    const finishOk = (value: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }

    const finishErr = (error: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        sendLog(`\n==> Terraform ${args[0]} timed out after ${Math.floor(timeoutMs / 60_000)} minutes. Stopping process...\n`)
        proc.kill()
        finishErr(new Error(
          `terraform ${args[0]} timed out after ${Math.floor(timeoutMs / 60_000)} minutes. ` +
          `Please retry Deploy. If it repeats, check proxy/network and ensure no other deploy is running.`
        ))
      }, timeoutMs)
      : null

    proc.stdout.on('data', (d) => { out += d; sendLog(d.toString()) })
    proc.stderr.on('data', (d) => { err += d; sendLog(d.toString()) })
    proc.on('close', (code) => {
      if (code === 0) finishOk(out)
      else finishErr(new Error(err || `terraform ${args[0]} exited with code ${code}`))
    })
    proc.on('error', (e) => finishErr(e instanceof Error ? e : new Error(String(e))))
  })
}

// Run the "push" step (vm-setup + scp files + docker compose) natively on Windows.
// This avoids WSL interop issues where plink.exe running through WSL2 binfmt_misc
// has corrupted stdin/stdout that causes SSH hangs. Running gcloud.cmd directly
// from a Windows process uses the Windows SDK's plink with proper I/O.
async function runWindowsPush(): Promise<void> {
  const config = readEnv()
  const vm = config.VM_NAME
  const zone = config.ZONE
  const project = config.PROJECT_ID
  const remoteDir = config.REMOTE_DIR || '/opt/novnc-chrome'
  if (!vm || !zone || !project) throw new Error('VM_NAME, ZONE, PROJECT_ID must be configured')

  const cmdExe = process.env.ComSpec ?? join(winSys32(), 'cmd.exe')
  const freshEnv = freshWindowsEnv()
  const proxyEnv = getWindowsProxyEnv()
  const adcPath = join(getGcloudConfigDir(), 'application_default_credentials.json')
  const winEnv: NodeJS.ProcessEnv = { ...freshEnv, ...proxyEnv, GOOGLE_APPLICATION_CREDENTIALS: adcPath }
  try {
    const r = require('child_process').spawnSync(
      cmdExe, ['/c', 'gcloud', 'auth', 'application-default', 'print-access-token'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, env: freshEnv },
    )
    const t = (r.stdout as string)?.trim()
    if (t?.startsWith('ya29')) winEnv.GOOGLE_OAUTH_ACCESS_TOKEN = t
  } catch { /* fallback to ADC file */ }

  const sshFlags = [
    `--zone=${zone}`, `--project=${project}`, '--tunnel-through-iap',
    '--strict-host-key-checking=no',
  ]

  const runGcloudCmd = (args: string[]) => new Promise<void>((res, rej) => {
    const proc2 = spawn(cmdExe, ['/c', 'gcloud.cmd', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], env: winEnv,
    })
    proc2.stdout.on('data', (d: Buffer) => sendLog(d.toString()))
    proc2.stderr.on('data', (d: Buffer) => sendLog(d.toString()))
    proc2.on('close', (code: number | null) =>
      code === 0 ? res() : rej(new Error(`gcloud ${args[0]} ${args[1] ?? ''} exited with code ${code}`)))
    proc2.on('error', rej)
  })

  sendLog('==> Verifying VM is ready...\n')
  // Encode vm-setup.sh as base64 and embed in --command to avoid stdin piping
  // through the cmd.exe→batch chain which consumes/corrupts input bytes.
  const setupScript: Buffer = require('fs').readFileSync(join(CORE_DIR, 'scripts', 'vm-setup.sh'))
  const scriptB64 = setupScript.toString('base64')
  await runGcloudCmd(['compute', 'ssh', vm, ...sshFlags,
    `--command=echo '${scriptB64}' | base64 -d | bash`])

  sendLog('==> Syncing files to VM...\n')
  await runGcloudCmd([
    'compute', 'scp', '--recurse', '--compress',
    join(CORE_DIR, 'docker-compose.yml'), join(CORE_DIR, 'docker'), join(CORE_DIR, '.env'),
    `${vm}:${remoteDir}/`,
    ...sshFlags,
  ])

  sendLog('==> Starting Docker stack on VM...\n')
  await runGcloudCmd([
    'compute', 'ssh', vm, ...sshFlags,
    `--command=cd ${remoteDir} && sudo docker compose up -d --build`,
  ])
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
    // Use a WSL-native CLOUDSDK_CONFIG so gcloud in WSL uses OpenSSH (not plink.exe).
    // Sharing the Windows gcloud config causes Linux gcloud to inherit Windows-specific SSH
    // settings (plink path etc.) — using a separate dir avoids that.  All gcloud commands in
    // the Makefile pass --project/--zone explicitly, so no config value is needed.
    pairs.push('CLOUDSDK_CONFIG=/root/.config/gcloud-cloudtab')
    // Let terraform / other ADC-aware tools find credentials (terraform ignores CLOUDSDK_CONFIG)
    pairs.push(`GOOGLE_APPLICATION_CREDENTIALS=${gcloudConfigWsl}/application_default_credentials.json`)
    // Fetch a fresh ADC access token from Windows gcloud and inject it directly so that
    // Terraform in WSL never needs to call oauth2.googleapis.com (WSL has no direct internet
    // in NAT mode; the Windows proxy at localhost is not reachable from the WSL network).
    try {
      const cmdExe = process.env.ComSpec ?? join(winSys32(), 'cmd.exe')
      const result = require('child_process').spawnSync(
        cmdExe, ['/c', 'gcloud', 'auth', 'application-default', 'print-access-token'],
        { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, env: freshWindowsEnv() },
      )
      const token = (result.stdout as string)?.trim()
      if (token && token.startsWith('ya29')) {
        pairs.push(`GOOGLE_OAUTH_ACCESS_TOKEN=${token}`)
      }
    } catch { /* ignore — terraform falls back to GOOGLE_APPLICATION_CREDENTIALS */ }
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
    wslExe(),
    ['--user', 'root', '--', 'bash', '-c',
     'command -v make && command -v terraform && command -v docker && command -v gcloud'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, env: wslEnv },
  )
  if (quickCheck.status === 0) return true

  sendLog('Installing required tools in Ubuntu (this may take a few minutes)...\n')

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
    wslExe(),
    ['--user', 'root', '--', 'bash', '-c', installScript],
    { encoding: 'utf8', stdio: 'pipe', timeout: 600_000, env: wslEnv },  // 10 min max
  )

  if (install.status === 0) {
    sendLog('WSL environment ready.\n')
    return true
  }

  sendLog(`WSL tool installation failed:\n${install.stderr}\n`)
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
      ? [process.env.ComSpec ?? join(winSys32(), 'cmd.exe'), ['/c', command, ...args]]
      : [command, args]
    const proc = spawn(cmd, cmdArgs, { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    proc.stdout!.on('data', (d) => { out += d; sendLog(d.toString()) })
    proc.stderr!.on('data', (d) => { err += d; sendLog(d.toString()) })
    proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `${command} exited with code ${code}`)))
    proc.on('error', reject)
  })
}

function runElevatedWindowsProcess(command: string, args: string[]): Promise<void> {
  if (!isWindows) throw new Error('Windows installer flow is only available on Windows.')

  const argList = args.map(quotePowerShell).join(', ')
  const script = `$p = Start-Process -FilePath ${quotePowerShell(command)} -Verb RunAs -Wait -PassThru -ArgumentList @(${argList}); exit $p.ExitCode`

  return new Promise((resolve, reject) => {
    const psExe = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    )
    const proc = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: process.env,
      windowsHide: false,
    })
    let err = ''
    proc.stdout.on('data', (d) => sendLog(d.toString()))
    proc.stderr.on('data', (d) => {
      err += d
      sendLog(d.toString())
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
      sendLog('Installing WSL 2 and Ubuntu 24.04...\n')
      // After restart, build-essential will be auto-installed on the next Re-check.
      await runElevatedWindowsProcess('wsl', ['--install', '-d', 'Ubuntu-24.04'])
      sendLog('WSL installation queued. Restart Windows when prompted.\n')
      return { restartRequired: true }
    case 'gcloud':
      sendLog('Installing Google Cloud SDK with winget...\n')
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

  sendLog(`Launching: gcloud ${args.join(' ')}...\n`)

  // Launch gcloud auth as a detached, independent process so the browser-based
  // OAuth flow doesn't block the IPC call. The IPC returns immediately;
  // the user completes login in the browser then clicks Re-check.
  const env = isWindows ? freshWindowsEnv() : process.env
  const cmdExe = process.env.ComSpec ?? join(winSys32(), 'cmd.exe')
  const [cmd, cmdArgs] = isWindows
    ? [cmdExe, ['/c', 'gcloud', ...args]]
    : ['gcloud', args]
  const child = spawn(cmd, cmdArgs, { env, windowsHide: false, stdio: 'ignore', detached: true })
  child.unref()
}

function closeTunnelProcess(): void {
  tunnelProcess?.kill()
  tunnelProcess = null
  activeTunnelPort = null
}

function checkLocalPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const tester = createNetServer()
    tester.once('error', (err: NodeJS.ErrnoException) => {
      tester.close()
      if (err.code === 'EADDRINUSE') {
        resolve(false)
        return
      }
      reject(err)
    })
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, '127.0.0.1')
  })
}

function parseTunnelPort(config: Record<string, string>): number {
  const raw = (config.LOCAL_TUNNEL_PORT ?? '8080').trim()
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n
  return 8080
}

async function resolveTunnelPort(preferredPort: number): Promise<number> {
  if (await checkLocalPortFree(preferredPort)) return preferredPort

  // Search upward from the preferred port for a nearby free port.
  for (let p = preferredPort + 1; p <= Math.min(preferredPort + 50, 65535); p++) {
    if (await checkLocalPortFree(p)) {
      sendLog(`Local port ${preferredPort} is busy. Using local port ${p} for tunnel.\n`)
      return p
    }
  }

  throw new Error(`Could not find a free local tunnel port near ${preferredPort}. Set LOCAL_TUNNEL_PORT in settings and try again.`)
}

async function openTunnelProcess(): Promise<{ ok: boolean; port: number }> {
  if (tunnelProcess) return Promise.resolve({ ok: true, port: activeTunnelPort ?? 8080 })

  const env = readEnv()
  requireConfig(env, ['VM_NAME', 'ZONE', 'PROJECT_ID'])
  const preferredPort = parseTunnelPort(env)
  const localPort = await resolveTunnelPort(preferredPort)

  let envForTunnel: NodeJS.ProcessEnv
  let tunnelCmd: string
  let tunnelArgs: string[]

  if (isWindows) {
    const freshEnv = freshWindowsEnv()
    const theAdcPath = getAdcCredentialPath()
    const proxyEnv = getWindowsProxyEnv()
    const tokenResult = require('child_process').spawnSync(
      process.env.ComSpec ?? join(winSys32(), 'cmd.exe'),
      ['/c', 'gcloud.cmd', 'auth', 'print-access-token'],
      { encoding: 'utf8', env: { ...freshEnv, ...proxyEnv, GOOGLE_APPLICATION_CREDENTIALS: theAdcPath } }
    )
    const accessToken = String(tokenResult.stdout ?? '').trim()
    envForTunnel = {
      ...freshEnv,
      ...proxyEnv,
      GOOGLE_APPLICATION_CREDENTIALS: theAdcPath,
      ...(accessToken ? { GOOGLE_OAUTH_ACCESS_TOKEN: accessToken } : {}),
    }
    const gcloudArgs = [
      'compute', 'ssh', env.VM_NAME,
      `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`,
      '--tunnel-through-iap', '--strict-host-key-checking=no',
      '--', '-L', `${localPort}:localhost:8080`, '-N',
    ]
    tunnelCmd = process.env.ComSpec ?? join(winSys32(), 'cmd.exe')
    tunnelArgs = ['/c', 'gcloud.cmd', ...gcloudArgs]
  } else {
    envForTunnel = process.env
    const gcloudArgs = [
      'compute', 'ssh', env.VM_NAME,
      `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`,
      '--tunnel-through-iap',
      '--', '-L', `${localPort}:localhost:8080`, '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
    ]
    tunnelCmd = 'gcloud'
    tunnelArgs = gcloudArgs
  }

  const proc = spawn(tunnelCmd, tunnelArgs, { env: envForTunnel, windowsHide: false })
  proc.stdout.on('data', (d) => sendLog(String(d)))
  proc.stderr.on('data', (d) => sendLog(String(d)))

  return new Promise<{ ok: boolean; port: number }>((resolve, reject) => {
    proc.on('error', (err) => reject(err))

    // Give the tunnel up to 8s to establish before declaring success.
    const timer = setTimeout(() => {
      tunnelProcess = proc
      activeTunnelPort = localPort
      proc.on('close', () => { tunnelProcess = null })
      resolve({ ok: true, port: localPort })
    }, 8000)

    // If the process exits before the timer fires, the tunnel failed.
    proc.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`IAP tunnel exited early (code ${code}). Is the VM running?`))
    })
  })
}

// ── Dev HTTP Bridge ─────────────────────────────────────────────────────────
// Exposes all IPC handlers over HTTP + SSE so the app can be driven from a
// plain browser (e.g., for automated UI testing) without Electron preload.
// Only started in dev mode — never shipped in the production build.
function startDevBridgeServer(): void {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // SSE: stream log lines to browser
    if (req.url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
      const send = (line: string) => res.write(`data: ${JSON.stringify(line)}\n\n`)
      sseClients.push(send)
      req.on('close', () => { const i = sseClients.indexOf(send); if (i >= 0) sseClients.splice(i, 1) })
      return
    }

    // Parse body
    const raw = await new Promise<string>(resolve => {
      let d = ''
      req.on('data', (c: Buffer) => { d += c.toString() })
      req.on('end', () => resolve(d))
    })
    let args: unknown[] = []
    try { const p = raw ? JSON.parse(raw) : []; args = Array.isArray(p) ? p : [p] } catch { args = [] }

    const route = (req.url ?? '').replace(/^\/api\//, '')
    try {
      let result: unknown
      switch (route) {
        case 'platform':                             result = process.platform; break
        case 'check-prerequisites':                  result = await getPrerequisiteStatus(); break
        case 'install-missing-windows-prerequisites':result = await installMissingWindowsPrerequisites(); break
        case 'run-gcloud-auth':                      await runGcloudAuth(args[0] as GcloudAuthTarget); result = null; break
        case 'get-config':                           result = readEnv(); break
        case 'save-config': {
          writeEnv(args[0] as Record<string, string>)
          try { await runScript('setup.sh') } catch { /* non-fatal */ }
          result = null; break
        }
        case 'vm-status': {
          const env = readEnv()
          if (!env.PROJECT_ID || !env.VM_NAME || !env.ZONE) { result = 'NOT_CONFIGURED'; break }
          try { result = (await gcloud(['compute', 'instances', 'describe', env.VM_NAME, `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`, '--format=value(status)'])).trim() }
          catch { result = 'NOT_FOUND' }
          break
        }
        case 'deploy': {
          if (isWindows) {
            sendLog('==> Initializing Terraform providers...\n')
            await runWindowsTerraform(['init', '-upgrade'])
            sendLog('==> Provisioning infrastructure...\n')
            await runWindowsTerraform(['apply', '-auto-approve'])
            sendLog('==> VM provisioned.\n')
            await runWindowsPush()
          } else {
            await runMake('deploy')
          }
          result = null; break
        }
        case 'tf-destroy': {
          if (isWindows) {
            sendLog('==> Destroying infrastructure...\n')
            await runWindowsTerraform(['destroy', '-auto-approve'])
            sendLog('==> Infrastructure destroyed.\n')
          } else {
            await runMake('tf-destroy')
          }
          result = null; break
        }
        case 'vm-start': {
          const env = readEnv(); requireConfig(env, ['VM_NAME', 'ZONE', 'PROJECT_ID'])
          await gcloud(['compute', 'instances', 'start', env.VM_NAME, `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`, '--quiet'])
          result = null; break
        }
        case 'vm-stop': {
          const env = readEnv(); requireConfig(env, ['VM_NAME', 'ZONE', 'PROJECT_ID'])
          await gcloud(['compute', 'instances', 'stop', env.VM_NAME, `--zone=${env.ZONE}`, `--project=${env.PROJECT_ID}`, '--quiet'])
          result = null; break
        }
        case 'open-external': await shell.openExternal(args[0] as string); result = null; break
        case 'open-tunnel':   result = await openTunnelProcess(); break
        case 'close-tunnel':  closeTunnelProcess(); result = null; break
        case 'open-novnc':    result = null; break
        case 'close-novnc':   result = null; break
        default: res.writeHead(404); res.end('not found'); return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? String(err) }))
    }
  })
  server.listen(3001, '127.0.0.1', () => console.log('[dev-bridge] http://127.0.0.1:3001'))
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
  if (isWindows) {
    // On Windows, run Terraform natively (internet works via Windows proxy) then
    // use the Windows-native push function (avoids WSL/plink interop issues).
    sendLog('==> Initializing Terraform providers...\n')
    await runWindowsTerraform(['init', '-upgrade'])
    sendLog('==> Provisioning infrastructure...\n')
    await runWindowsTerraform(['apply', '-auto-approve'])
    sendLog('==> VM provisioned.\n')
    await runWindowsPush()
  } else {
    await runMake('deploy')
  }
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
  return await openTunnelProcess()
})

ipcMain.handle('close-tunnel', async () => {
  closeTunnelProcess()
})

ipcMain.handle('open-novnc', async (_e, requestedPort?: number) => {
  const port = requestedPort ?? activeTunnelPort ?? 8080
  await shell.openExternal(`http://localhost:${port}/vnc.html?reconnect=true`)
})

ipcMain.handle('close-novnc', async () => {
  const currentUrl = mainWindow?.webContents.getURL() ?? ''
  if (!/\/vnc\.html(\?|$)/.test(currentUrl)) return
  if (isDev) mainWindow?.loadURL((process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173') + '#/dashboard')
  else mainWindow?.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
})

ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

ipcMain.handle('tf-destroy', async () => {
  if (isWindows) {
    sendLog('==> Destroying infrastructure...\n')
    await runWindowsTerraform(['destroy', '-auto-approve'])
    sendLog('==> Infrastructure destroyed.\n')
  } else {
    await runMake('tf-destroy')
  }
})
