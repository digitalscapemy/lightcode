// Runs as a real Electron MAIN process (electron <this-file>), NOT under
// ELECTRON_RUN_AS_NODE. This matters: run-as-node configures V8 with a
// different flag set, and bytecode compiled there is rejected at load time by
// the real main process ("Invalid or incompatible cached data"). Compiling
// inside the same context the app boots in keeps the V8 flag hash matching.
const { app } = require('electron')
const bytenode = require('bytenode')
const fs = require('fs')
const path = require('path')

app.whenReady().then(() => {
  try {
    const mainDir = path.join(__dirname, '..', 'out', 'main')
    const jsFile = path.join(mainDir, 'index.js')
    const jscFile = path.join(mainDir, 'index.jsc')

    if (!fs.existsSync(jsFile)) {
      console.error(`[bytecode] ${jsFile} not found — run electron-vite build first.`)
      app.exit(1)
      return
    }

    // index.js -> index.jsc (V8 bytecode), compiled in this main-process V8.
    bytenode.compileFile({ filename: jsFile, output: jscFile })

    // Replace the plaintext entry with a loader that boots the bytecode.
    fs.writeFileSync(jsFile, "require('bytenode');\nrequire('./index.jsc');\n")

    console.log('[bytecode] compiled out/main/index.js -> index.jsc (+ loader)')
    app.exit(0)
  } catch (err) {
    console.error('[bytecode] compile failed:', err)
    app.exit(1)
  }
})
