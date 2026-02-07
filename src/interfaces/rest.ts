/*
 * Copyright 2014-2015 Fabian Tollenaar <fabian@starting-point.nl>
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

import express from 'express'

import { createDebug } from '../debug'
import * as ports from '../ports'
import { getMetadata } from '@signalk/signalk-schema'
import type { WithConfig } from '../app'

const debug = createDebug('signalk-server:interfaces:rest')

type QueryLike = Record<string, string | undefined>

type RequestLike = {
  path?: string
  query?: QueryLike
  headers?: Record<string, string | undefined>
  skPrincipal?: unknown
}

type ResponseLike = {
  status: (code: number) => ResponseLike
  send: (payload: unknown) => ResponseLike
  json: (payload: unknown) => ResponseLike
}

type Handler = (req: RequestLike, res: ResponseLike, next: () => void) => void

type HistoryProvider = {
  getHistory: (
    date: Date,
    path: string[],
    cb: (deltas: unknown[]) => void
  ) => void
  registerHistoryApiRoute?: (router: express.Router) => void
}

type AppLike = {
  selfId: string
  config: { settings: { ssl?: boolean }; version: string }
  interfaces: { tcp?: { data?: { port: number | string } } }
  securityStrategy: { anyACLs: () => boolean }
  signalk: { retrieve: () => unknown }
  deltaCache: {
    buildFull: (principal: unknown, path: string[]) => unknown
    buildFullFromDeltas: (principal: unknown, deltas: unknown[]) => unknown
  }
  use: (...args: unknown[]) => void
  get: (path: string, handler: Handler) => void
  historyProvider?: HistoryProvider
}

const iso8601rexexp =
  /^(-?(?:[1-9][0-9]*)?[0-9]{4})-(1[0-2]|0[1-9])-(3[01]|0[1-9]|[12][0-9])T(2[0-3]|[01][0-9]):([0-5][0-9]):([0-5][0-9])(\.[0-9]+)?Z$/

const rest = (app: AppLike) => {
  'use strict'

  const pathPrefix = '/signalk'
  const versionPrefix = '/v1'
  const apiPathPrefix = pathPrefix + versionPrefix + '/api/'
  const streamPath = pathPrefix + versionPrefix + '/stream'

  const KNOWN_OTHER_PATH_PREFIXES = ['resources']

  return {
    start: () => {
      app.use('/', express.static(__dirname + '/../../public'))

      app.get(apiPathPrefix + '*', (req, res, next) => {
        let path = String(req.path || '').replace(apiPathPrefix, '')

        if (path === 'self') {
          return res.json(`vessels.${app.selfId}`)
        }

        const pathSegments =
          path.length > 0 ? path.replace(/\/$/, '').split('/') : []

        if (KNOWN_OTHER_PATH_PREFIXES.indexOf(pathSegments[0]) >= 0) {
          next()
          return
        }

        if (pathSegments.length > 4 && pathSegments.at(-1) === 'meta') {
          const meta = getMetadata(pathSegments.slice(0, -1).join('.'))

          if (meta) {
            res.json(meta)
            return
          }
        }
        if (pathSegments.length > 5 && pathSegments.at(-2) === 'meta') {
          const meta = getMetadata(pathSegments.slice(0, -2).join('.')) as
            | Record<string, unknown>
            | undefined
          const value = meta && meta[pathSegments[pathSegments.length - 1]]
          if (value) {
            res.json(value)
            return
          }
        }

        const resolvedPath = pathSegments.map((p) =>
          p === 'self' ? app.selfId : p
        )

        const sendResult = (last: unknown, aPath: string[]) => {
          if (!last) {
            next()
            return
          }
          let current: unknown = last
          for (const segment of aPath) {
            const value = (current as Record<string, unknown>)[segment]
            if (typeof value !== 'undefined') {
              current = value
            } else {
              next()
              return
            }
          }
          res.json(current)
          return
        }

        if (resolvedPath[0] === 'snapshot') {
          const queryTime = req.query?.time
          if (!queryTime) {
            res.status(400).send('Snapshot api requires time query parameter')
          } else if (!iso8601rexexp.test(queryTime)) {
            res
              .status(400)
              .send(
                'Time query parameter must be a valid ISO 8601 UTC time value like 2018-12-11T18:40:03.246'
              )
          } else if (!app.historyProvider) {
            res.status(501).send('No history provider')
          } else {
            const realPath = resolvedPath.slice(1)
            app.historyProvider.getHistory(
              new Date(queryTime),
              realPath,
              (deltas) => {
                if (deltas.length === 0) {
                  res.status(404).send('No data found for the given time')
                  return
                }
                const last = app.deltaCache.buildFullFromDeltas(
                  req.skPrincipal,
                  deltas
                )
                sendResult(last, realPath)
              }
            )
          }
        } else {
          let last
          if (app.securityStrategy.anyACLs()) {
            last = app.deltaCache.buildFull(req.skPrincipal, resolvedPath)
          } else {
            last = app.signalk.retrieve()
          }
          sendResult(last, resolvedPath)
        }
      })

      app.get(pathPrefix, (req, res) => {
        const host = req.headers?.host || ''
        const splitHost = host.split(':')

        let httpProtocol = 'http://'
        let wsProtocol = 'ws://'
        if (
          app.config.settings.ssl ||
          req.headers?.['x-forwarded-proto'] === 'https'
        ) {
          httpProtocol = 'https://'
          wsProtocol = 'wss://'
        }

        const services: Record<string, string> = {
          version: getVersion(),
          'signalk-http': httpProtocol + host + apiPathPrefix,
          'signalk-ws': wsProtocol + host + streamPath
        }

        if (app.interfaces.tcp?.data) {
          services['signalk-tcp'] =
            `tcp://${splitHost[0]}:${app.interfaces.tcp.data.port}`
        }

        res.json({
          endpoints: {
            v1: services
          },
          server: {
            id: 'signalk-server-node',
            version: app.config.version
          }
        })
      })

      if (app.historyProvider?.registerHistoryApiRoute) {
        debug('Adding history api route')
        const historyApiRouter = express.Router()
        app.historyProvider.registerHistoryApiRoute(historyApiRouter)
        app.use(pathPrefix + versionPrefix + '/history', historyApiRouter)
      }
    },

    mdns: {
      name: app.config.settings.ssl ? '_signalk-https' : '_signalk-http',
      type: 'tcp',
      port: ports.getExternalPort(app as unknown as WithConfig)
    }
  }
}

const getVersion = () =>
  (require('../../package.json') as { version: string }).version

export = rest
