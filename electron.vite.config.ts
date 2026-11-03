import { resolve } from 'path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// https://github.com/vdesjs/vite-plugin-monaco-editor/issues/21#issuecomment-1827562674
import monacoEditorPluginModule from 'vite-plugin-monaco-editor'
const isObjectWithDefaultFunction = (
  module: unknown
): module is { default: typeof monacoEditorPluginModule } =>
  module != null &&
  typeof module === 'object' &&
  'default' in module &&
  typeof module.default === 'function'
const monacoEditorPlugin = isObjectWithDefaultFunction(monacoEditorPluginModule)
  ? monacoEditorPluginModule.default
  : monacoEditorPluginModule

// Win7 build: bundle all deps (Vite converts ESM→CJS), only externalize native modules
const revision = Number(
  readFileSync('packaging/arch/PKGBUILD', 'utf8').match(/^pkgrel=(\d+)$/m)?.[1]
)
if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid application revision')
const isLegacyBuild = process.env.LEGACY_BUILD === 'true'
const legacyExternal = ['sysproxy-rs', 'electron', 'utf-8-validate', 'bufferutil']

export default defineConfig({
  main: {
    define: { __LEGACY_BUILD__: JSON.stringify(isLegacyBuild), __APP_REVISION__: revision },
    plugins: isLegacyBuild ? [] : [externalizeDepsPlugin()],
    build: isLegacyBuild
      ? { rollupOptions: { external: legacyExternal, output: { format: 'cjs' } } }
      : undefined
  },
  preload: {
    plugins: isLegacyBuild ? [] : [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: isLegacyBuild ? legacyExternal : undefined,
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    define: { __LEGACY_BUILD__: JSON.stringify(isLegacyBuild) },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          floating: resolve('src/renderer/floating.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      monacoEditorPlugin({
        languageWorkers: ['editorWorkerService', 'typescript', 'css'],
        customDistPath: (_, out) => `${out}/monacoeditorwork`,
        customWorkers: [
          {
            label: 'yaml',
            entry: 'monaco-yaml/yaml.worker'
          }
        ]
      })
    ]
  }
})
