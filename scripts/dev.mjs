import { spawn } from 'node:child_process'

const env = { ...process.env }
if (process.platform === 'linux') env.ELECTRON_EXEC_PATH ||= '/usr/bin/electron'
const child = spawn('pnpm', ['exec', 'electron-vite', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
