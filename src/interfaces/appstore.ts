/*
 * Copyright 2017 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import _ from 'lodash'
import { gt } from 'semver'

import { createDebug } from '../debug'
import { SERVERROUTESPREFIX } from '../constants'
import * as modules from '../modules'
import * as categories from '../categories'

type ModulesApi = {
  findModulesWithKeyword: (keyword: string) => Promise<RegistryModule[]>
  getLatestServerVersion: (version: string) => Promise<string>
  installModule: (
    config: AppLike['config'],
    name: string,
    version: string | null,
    stdout: (output: string) => void,
    stderr: (output: string) => void,
    done: (code: number) => void
  ) => void
  removeModule: (
    config: AppLike['config'],
    name: string,
    version: string | null,
    stdout: (output: string) => void,
    stderr: (output: string) => void,
    done: (code: number) => void
  ) => void
  isTheServerModule: (name: string, config: AppLike['config']) => boolean
  getAuthor: (pkg: {
    name: string
    publisher?: { username?: string }
  }) => string
  getKeywords: (pkg: { name: string; keywords: string[] }) => string[]
}

type CategoriesApi = {
  getCategories: (pkg: ModulePackage) => string[]
  getAvailableCategories: () => string[]
}

const {
  findModulesWithKeyword,
  getLatestServerVersion,
  installModule,
  isTheServerModule,
  removeModule,
  getAuthor,
  getKeywords
} = modules as unknown as ModulesApi

const { getAvailableCategories, getCategories } =
  categories as unknown as CategoriesApi

const debug = createDebug('signalk-server:interfaces:appstore')

const npmServerInstallLocations = [
  '/usr/bin/signalk-server',
  '/usr/lib/node_modules/signalk-server/bin/signalk-server',
  '/usr/local/bin/signalk-server',
  '/usr/local/lib/node_modules/signalk-server/bin/signalk-server'
]

type RequestLike = {
  params: Record<string, string>
}

type ResponseLike = {
  status: (code: number) => ResponseLike
  json: (payload: unknown) => ResponseLike
}

type Handler = (req: RequestLike, res: ResponseLike) => void

type AppLike = {
  config: {
    version: string
    name: string
    description: string
    publisher?: {
      username?: string
    }
  }
  plugins: InstalledModule[]
  webapps: InstalledWebApp[]
  addons: InstalledWebApp[]
  embeddablewebapps: InstalledWebApp[]
  providers: ProviderHolder[]
  emit: (event: 'serverevent', payload: ServerEvent) => void
  post: (paths: string[] | string, handler: Handler) => void
  get: (path: string, handler: Handler) => void
}

type ProviderHolder = {
  id?: string
  pipeElements: Array<{
    pipeline: Array<{
      options: { filename?: string }
    }>
    end: () => void
  }>
}

type InstalledModule = {
  id: string
  packageName: string
  version: string
}

type InstalledWebApp = {
  name: string
  id?: string
  version: string
}

type ModulePackage = {
  name: string
  version: string
  description?: string
  date?: string
  author?: string
  keywords: string[]
  links?: {
    npm?: string
  }
}

type RegistryModule = {
  package: ModulePackage
}

type AppStoreModuleInfo = {
  name: string
  version: string
  description?: string
  author?: string
  categories?: string[]
  updated?: string
  keywords?: string[]
  npmUrl?: string | null
  isPlugin?: boolean
  isWebapp?: boolean
  isEmbeddableWebapp?: boolean
  id?: string
  installedVersion?: string
  isWaiting?: boolean
  isInstalling?: boolean
  isRemoving?: boolean
  installFailed?: boolean
  isRemove?: boolean
}

type AppStoreInfo = {
  available: AppStoreModuleInfo[]
  installed: AppStoreModuleInfo[]
  updates: AppStoreModuleInfo[]
  installing: AppStoreModuleInfo[]
  categories: string[]
  storeAvailable: boolean
  isInDocker: boolean
  canUpdateServer?: boolean
  serverUpdate?: string
}

type ServerEvent = {
  type: 'APP_STORE_CHANGED'
  from: 'signalk-server'
  data: AppStoreInfo
}

type ModuleInstallQueueItem = {
  name: string
  version?: string
  isRemove?: boolean
}

type ModuleInstallState = {
  name: string
  output: string[]
  version: string | null
  isRemove?: boolean
  code?: number
}

type AppStoreController = {
  start: () => void
  stop: () => void
}

const appstore = (app: AppLike): AppStoreController => {
  let moduleInstalling: ModuleInstallState | undefined
  const modulesInstalledSinceStartup: Record<string, ModuleInstallState> = {}
  const moduleInstallQueue: ModuleInstallQueueItem[] = []

  return {
    start: () => {
      app.post(
        [
          `${SERVERROUTESPREFIX}/appstore/install/:name/:version`,
          `${SERVERROUTESPREFIX}/appstore/install/:org/:name/:version`
        ],
        (req, res) => {
          let name = req.params.name
          const version = req.params.version

          if (req.params.org) {
            name = `${req.params.org}/${name}`
          }

          findPluginsAndWebapps()
            .then(([plugins, webapps]) => {
              if (
                !isTheServerModule(name, app.config) &&
                !plugins.find(packageNameIs(name)) &&
                !webapps.find(packageNameIs(name))
              ) {
                res.status(404)
                res.json('No such webapp or plugin available:' + name)
              } else {
                if (moduleInstalling) {
                  moduleInstallQueue.push({ name, version })
                  sendAppStoreChangedEvent()
                } else {
                  installSKModule(name, version)
                }
                res.json(`Installing ${name}...`)
              }
            })
            .catch((error: Error) => {
              console.log(error.message)
              debug(error.stack)
              res.status(500)
              res.json(error.message)
            })
        }
      )

      app.post(
        [
          `${SERVERROUTESPREFIX}/appstore/remove/:name`,
          `${SERVERROUTESPREFIX}/appstore/remove/:org/:name`
        ],
        (req, res) => {
          let name = req.params.name

          if (req.params.org) {
            name = `${req.params.org}/${name}`
          }

          findPluginsAndWebapps()
            .then(([plugins, webapps]) => {
              if (
                !plugins.find(packageNameIs(name)) &&
                !webapps.find(packageNameIs(name))
              ) {
                res.status(404)
                res.json('No such webapp or plugin available:' + name)
              } else {
                if (moduleInstalling) {
                  moduleInstallQueue.push({ name, isRemove: true })
                  sendAppStoreChangedEvent()
                } else {
                  removeSKModule(name)
                }
                res.json(`Removing ${name}...`)
              }
            })
            .catch((error: Error) => {
              console.log(error.message)
              debug(error.stack)
              res.status(500)
              res.json(error.message)
            })
        }
      )

      app.get(`${SERVERROUTESPREFIX}/appstore/available/`, (_req, res) => {
        findPluginsAndWebapps()
          .then(([plugins, webapps]) => {
            getLatestServerVersion(app.config.version)
              .then((serverVersion: string) => {
                const result = getAllModuleInfo(plugins, webapps, serverVersion)
                res.json(result)
              })
              .catch(() => {
                // could be that npmjs is down, so we can not get
                // server version, but we have app store data
                const result = getAllModuleInfo(plugins, webapps, '0.0.0')
                res.json(result)
              })
          })
          .catch((error: Error) => {
            console.log(error.message)
            debug(error.stack)
            res.json(emptyAppStoreInfo(false))
          })
      })
    },
    stop: () => undefined
  }

  function findPluginsAndWebapps() {
    return Promise.all([
      findModulesWithKeyword('signalk-node-server-plugin'),
      findModulesWithKeyword('signalk-embeddable-webapp'),
      findModulesWithKeyword('signalk-webapp')
    ]).then(([plugins, embeddableWebapps, webapps]) => {
      const allWebapps = embeddableWebapps.concat(webapps)
      return [
        plugins,
        _.uniqBy(allWebapps, (plugin) => {
          return plugin.package.name
        })
      ] as [RegistryModule[], RegistryModule[]]
    })
  }

  function getPlugin(id: string) {
    return app.plugins.find((plugin) => plugin.packageName === id)
  }

  function getWebApp(id: string) {
    return (
      (app.webapps && app.webapps.find((webapp) => webapp.name === id)) ||
      (app.addons && app.addons.find((webapp) => webapp.name === id)) ||
      (app.embeddablewebapps &&
        app.embeddablewebapps.find((webapp) => webapp.name === id))
    )
  }

  function emptyAppStoreInfo(storeAvailable = true): AppStoreInfo {
    return {
      available: [],
      installed: [],
      updates: [],
      installing: [],
      categories: getAvailableCategories(),
      storeAvailable,
      isInDocker: process.env.IS_IN_DOCKER === 'true'
    }
  }

  function getAllModuleInfo(
    plugins: RegistryModule[],
    webapps: RegistryModule[],
    serverVersion: string
  ): AppStoreInfo {
    const all = emptyAppStoreInfo()

    if (
      process.argv.length > 1 &&
      (npmServerInstallLocations.includes(process.argv[1]) ||
        process.env.SIGNALK_SERVER_IS_UPDATABLE) &&
      !process.env.SIGNALK_DISABLE_SERVER_UPDATES
    ) {
      all.canUpdateServer = !all.isInDocker && true
      if (gt(serverVersion, app.config.version)) {
        all.serverUpdate = serverVersion

        const info: AppStoreModuleInfo = {
          name: app.config.name,
          version: serverVersion,
          description: app.config.description,
          author: getAuthor(app.config),
          npmUrl: null,
          isPlugin: false,
          isWebapp: false
        }

        if (moduleInstallQueue.find((p) => p.name === info.name)) {
          info.isWaiting = true
          all.installing.push(info)
        } else if (modulesInstalledSinceStartup[info.name]) {
          if (moduleInstalling && moduleInstalling.name === info.name) {
            info.isInstalling = true
          } else if (modulesInstalledSinceStartup[info.name].code !== 0) {
            info.installFailed = true
          }
          all.installing.push(info)
        }
      }
    } else {
      all.canUpdateServer = false
    }

    getModulesInfo(plugins, getPlugin, all)
    getModulesInfo(webapps, getWebApp, all)

    if (process.env.PLUGINS_WITH_UPDATE_DISABLED) {
      const disabled = process.env.PLUGINS_WITH_UPDATE_DISABLED.split(',')
      all.updates = all.updates.filter((info) => !disabled.includes(info.name))
    }

    return all
  }

  function getModulesInfo(
    modules: RegistryModule[],
    existing: (name: string) => InstalledModule | InstalledWebApp | undefined,
    result: AppStoreInfo
  ) {
    modules.forEach((plugin) => {
      const name = plugin.package.name
      const version = plugin.package.version

      const pluginInfo: AppStoreModuleInfo = {
        name: name,
        version: version,
        description: plugin.package.description,
        author: getAuthor(plugin.package),
        categories: getCategories(plugin.package),
        updated: plugin.package.date,
        keywords: getKeywords(plugin.package),
        npmUrl: getNpmUrl(plugin),
        isPlugin: plugin.package.keywords.some(
          (v) => v === 'signalk-node-server-plugin'
        ),
        isWebapp: plugin.package.keywords.some((v) => v === 'signalk-webapp'),
        isEmbeddableWebapp: plugin.package.keywords.some(
          (v) => v === 'signalk-embeddable-webapp'
        )
      }

      const installedModule = existing(name)

      if (installedModule) {
        pluginInfo.id = installedModule.id
        pluginInfo.installedVersion = installedModule.version
      }

      if (moduleInstallQueue.find((p) => p.name === name)) {
        pluginInfo.isWaiting = true
        addIfNotDuplicate(result.installing, pluginInfo)
      } else if (modulesInstalledSinceStartup[name]) {
        if (moduleInstalling && moduleInstalling.name === name) {
          if (moduleInstalling.isRemove) {
            pluginInfo.isRemoving = true
          } else {
            pluginInfo.isInstalling = true
          }
        } else if (modulesInstalledSinceStartup[name].code !== 0) {
          pluginInfo.installFailed = true
          addIfNotDuplicate(result.available, pluginInfo)
        }
        pluginInfo.isRemove = modulesInstalledSinceStartup[name].isRemove
        addIfNotDuplicate(result.installing, pluginInfo)
      } else if (installedModule) {
        if (gt(version, installedModule.version)) {
          addIfNotDuplicate(result.updates, pluginInfo)
        }
        addIfNotDuplicate(result.installed, pluginInfo)
      }
      addIfNotDuplicate(result.available, pluginInfo)

      return result
    })
  }

  function addIfNotDuplicate(
    theArray: AppStoreModuleInfo[],
    moduleInfo: AppStoreModuleInfo
  ) {
    if (!theArray.find((p) => p.name === moduleInfo.name)) {
      theArray.push(moduleInfo)
    }
  }

  function getNpmUrl(moduleInfo: RegistryModule) {
    const npm = _.get(moduleInfo.package, 'links.npm') as string | undefined
    return npm || null
  }

  function sendAppStoreChangedEvent() {
    findPluginsAndWebapps().then(([plugins, webapps]) => {
      getLatestServerVersion(app.config.version).then(
        (serverVersion: string) => {
          const result = getAllModuleInfo(plugins, webapps, serverVersion)
          app.emit('serverevent', {
            type: 'APP_STORE_CHANGED',
            from: 'signalk-server',
            data: result
          })
        }
      )
    })
  }

  function installSKModule(module: string, version: string) {
    if (isTheServerModule(module, app.config)) {
      try {
        app.providers.forEach((providerHolder) => {
          if (
            typeof providerHolder.pipeElements[0].pipeline[0].options
              .filename !== 'undefined'
          ) {
            debug('close file connection:', providerHolder.id)
            providerHolder.pipeElements[0].end()
          }
        })
      } catch (err) {
        debug(err)
      }
    }
    updateSKModule(module, version, false)
  }

  function removeSKModule(module: string) {
    updateSKModule(module, null, true)
  }

  function updateSKModule(
    module: string,
    version: string | null,
    isRemove: boolean
  ) {
    moduleInstalling = {
      name: module,
      output: [],
      version: version,
      isRemove: isRemove
    }
    modulesInstalledSinceStartup[module] = moduleInstalling

    sendAppStoreChangedEvent()

    const fn = isRemove ? removeModule : installModule

    fn(
      app.config,
      module,
      version,
      (output: string) => {
        modulesInstalledSinceStartup[module].output.push(output)
        console.log(`stdout: ${output}`)
      },
      (output: string) => {
        modulesInstalledSinceStartup[module].output.push(output)
        console.error(`stderr: ${output}`)
      },
      (code: number) => {
        debug('close: ' + module)
        modulesInstalledSinceStartup[module].code = code
        moduleInstalling = undefined
        debug(`child process exited with code ${code}`)

        if (moduleInstallQueue.length) {
          const next = moduleInstallQueue.splice(0, 1)[0]
          if (next.isRemove) {
            removeSKModule(next.name)
          } else if (next.version) {
            installSKModule(next.name, next.version)
          }
        }

        sendAppStoreChangedEvent()
      }
    )
  }
}

function packageNameIs(name: string) {
  return (x: RegistryModule) => x.package.name === name
}

export = appstore
