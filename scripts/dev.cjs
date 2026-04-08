const { spawn } = require('child_process')
const { join } = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.ELECTRON_EXTRA_LAUNCH_ARGS = '--no-sandbox --disable-setuid-sandbox --disable-gpu-sandbox'

const isWindows = process.platform === 'win32'

// On Windows, .cmd shims (electron-vite.cmd) cannot be spawned directly — Node raises
// EINVAL. Using cmd.exe /c avoids both EINVAL and the DEP0190 security warning that
// comes from shell:true with variable arguments.
const electronViteCmd = join(__dirname, '..', 'node_modules', '.bin',
  isWindows ? 'electron-vite.cmd' : 'electron-vite')

const [cmd, args] = isWindows
  ? [process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
     ['/c', electronViteCmd, 'dev']]
  : [electronViteCmd, ['dev']]

const child = spawn(cmd, args, { stdio: 'inherit', env })

child.on('error', (err) => {
  console.error(`Failed to start electron-vite dev: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
