import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const standaloneDir = join(root, '.next', 'standalone')

if (!existsSync(standaloneDir)) {
  throw new Error('Missing .next/standalone. Run next build with output: "standalone" first.')
}

cpSync(join(root, '.next', 'static'), join(standaloneDir, '.next', 'static'), {
  recursive: true,
})

cpSync(join(root, 'public'), join(standaloneDir, 'public'), {
  recursive: true,
})
