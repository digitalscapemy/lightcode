import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import obfuscator from 'vite-plugin-javascript-obfuscator'

// Conservative obfuscation: identifier renaming + string encoding only. The
// aggressive transforms (controlFlowFlattening, deadCodeInjection, selfDefending)
// are deliberately OFF — they bloat the bundle and are the usual cause of
// runtime breakage in libraries like xterm/webgl. This still renames every
// local symbol and hides string literals, which is the bulk of the value.
const obfuscatorOptions = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal' as const,
  simplify: true,
  stringArray: true,
  stringArrayThreshold: 0.5,
  stringArrayEncoding: ['base64'] as ('base64' | 'rc4' | 'none')[],
  splitStrings: false,
  transformObjectKeys: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: false }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: false }
  },
  renderer: {
    build: {
      sourcemap: false,
      // Keep the app in a single chunk so obfuscated identifier renaming stays
      // internally consistent (no cross-chunk ESM import/export mismatches).
      rollupOptions: { output: { manualChunks: undefined } }
    },
    plugins: [
      obfuscator({
        // Build-only: `npm run dev` stays plaintext for fast HMR iteration.
        apply: 'build',
        options: obfuscatorOptions
      })
    ]
  }
})
