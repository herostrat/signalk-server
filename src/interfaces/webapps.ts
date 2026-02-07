/*
 * Copyright 2017 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

import fs from 'fs'
import path from 'path'
import express from 'express'
import { uniqBy } from 'lodash'

import { createDebug } from '../debug'
import type { Config } from '../config/config'
import { SERVERROUTESPREFIX } from '../constants'
import { modulesWithKeyword } from '../modules'

type WebAppMeta = { name: string }

type AppLike = {
  config: Config
  webapps?: WebAppMeta[]
  embeddablewebapps?: WebAppMeta[]
  addons?: WebAppMeta[]
  pluginconfigurators?: WebAppMeta[]
  use: (path: string, handler: unknown) => void
  get: (
    path: string,
    handler: (req: unknown, res: { json: (payload: unknown) => void }) => void
  ) => void
}

const debug = createDebug('signalk-server:interfaces:webapps')

const webapps = (app: AppLike) => {
  return {
    start: () => {
      // Preserve any existing webapps (e.g., from WASM plugins loaded earlier)
      const existingWebapps = app.webapps || []
      const nodeWebapps = mountWebModules(app, 'signalk-webapp').map(
        (moduleData) => moduleData.metadata as WebAppMeta
      )
      // Merge Node.js webapps with existing WASM webapps, avoiding duplicates
      app.webapps = uniqBy([...nodeWebapps, ...existingWebapps], 'name')
      app.addons = mountWebModules(app, 'signalk-node-server-addon').map(
        (moduleData) => moduleData.metadata as WebAppMeta
      )
      const existingEmbeddableWebapps = app.embeddablewebapps || []
      const nodeEmbeddableWebapps = mountWebModules(
        app,
        'signalk-embeddable-webapp'
      ).map((moduleData) => moduleData.metadata as WebAppMeta)
      app.embeddablewebapps = uniqBy(
        [...nodeEmbeddableWebapps, ...existingEmbeddableWebapps],
        'name'
      )
      app.pluginconfigurators = mountWebModules(
        app,
        'signalk-plugin-configurator'
      ).map((moduleData) => moduleData.metadata as WebAppMeta)
      mountApis(app)
    },

    stop: () => {}
  }
}

function mountWebModules(
  app: AppLike,
  keyword: string
): ReturnType<typeof modulesWithKeyword> {
  debug(`mountWebModules:${keyword}`)
  const modules = modulesWithKeyword(app.config, keyword)
  modules.forEach((moduleData) => {
    let webappPath = path.join(moduleData.location, moduleData.module)
    if (fs.existsSync(webappPath + '/public/')) {
      webappPath += '/public/'
    }
    debug('Mounting web module /' + moduleData.module + ':' + webappPath)
    app.use('/' + moduleData.module, express.static(webappPath))
  })
  return modules
}

function mountApis(app: AppLike) {
  app.get(`${SERVERROUTESPREFIX}/webapps`, (_req, res) => {
    const allWebapps = ([] as Array<{ name: string }>)
      .concat(app.webapps || [])
      .concat(app.embeddablewebapps || [])
    res.json(uniqBy(allWebapps, 'name'))
  })
  app.get(`${SERVERROUTESPREFIX}/addons`, (_req, res) => {
    res.json(app.addons || [])
  })
}

export = webapps
