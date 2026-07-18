// Compiles the built main process to V8 bytecode by launching compile-main.cjs
// as a real Electron main process (NOT ELECTRON_RUN_AS_NODE — see the note in
// compile-main.cjs). `require('electron')` in plain Node resolves to the
// Electron executable path.
const { spawnSync } = require('child_process')
const path = require('path')

const electron = require('electron')
if (typeof electron !== 'string') {
  console.error('[bytecode] could not resolve the Electron binary path.')
  process.exit(1)
}

const result = spawnSync(electron, [path.join(__dirname, 'compile-main.cjs')], {
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
