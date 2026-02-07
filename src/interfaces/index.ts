import fs from 'fs'

type ExportMap = Record<string, unknown>

const interfaceExports = module.exports as ExportMap

fs.readdirSync(`${__dirname}/`).forEach((file) => {
  if (
    (file.endsWith('.js') || file.endsWith('.ts')) &&
    file !== 'index.js' &&
    file !== 'index.ts'
  ) {
    const name = file.replace(/\.(js|ts)$/, '')
    interfaceExports[name] = require('./' + file)
  }
})
