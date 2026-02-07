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

import * as cookie from 'cookie'
import { EventEmitter } from 'events'
import _ from 'lodash'
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken'
import PrimusModule from 'primus'

import { createDebug } from '../debug'
import * as ports from '../ports'
import { getSourceId, getMetadata } from '@signalk/signalk-schema'
import { requestAccess, InvalidTokenError } from '../security'
import { findRequest, updateRequest, queryRequest } from '../requestResponse'
import { putPath, deletePath } from '../put'
import { startEvents, startServerEvents } from '../events'
import {
  accumulateLatestValue,
  buildFlushDeltas
} from '../LatestValuesAccumulator'
import type { WithConfig } from '../app'

const cookieParser = cookie as {
  parse: (value: string) => Record<string, string>
}

type WsQuery = Record<string, string>

type WsRequest = {
  headers: Record<string, string | undefined>
  cookies?: Record<string, string>
  token?: string
  skPrincipal?: { identifier: string }
  source?: string
  connection: { remoteAddress: string }
  query: WsQuery
  socket: {
    bufferSize: number
    on: (event: string, handler: () => void) => void
  }
}

type DeltaValue = {
  path: string
  value: unknown
}

type DeltaUpdate = {
  $source?: string
  source?: unknown
  timestamp?: string
  values?: DeltaValue[]
  meta?: Array<{ path: string; value: unknown }>
}

type SignalKDelta = {
  context: string
  updates?: DeltaUpdate[]
  $backpressure?: { accumulated: number; duration: number }
}

type PutMessage = {
  path: string
  value?: unknown
}

type DeleteMessage = {
  path: string
}

type WsMessage = {
  token?: string
  updates?: DeltaUpdate[]
  subscribe?: unknown
  unsubscribe?: unknown
  accessRequest?: unknown
  login?: { username: string; password: string }
  put?: PutMessage
  delete?: DeleteMessage
  requestId?: string
  query?: unknown
  context?: string
}

type PutReply = {
  requestId?: string
  state: string
  statusCode?: number
  message?: string
}

type SecurityStrategy = {
  canAuthorizeWS: () => boolean
  authorizeWS?: (req: WsRequest) => void
  filterReadDelta: (
    principal: unknown,
    delta: SignalKDelta
  ) => SignalKDelta | null | undefined
  shouldAllowWrite: (req: WsRequest, msg: WsMessage) => boolean
  supportsLogin: () => boolean
  login?: (
    username: string,
    password: string
  ) => Promise<{ statusCode: number; token?: string }>
  verifyWS: (req: WsRequest) => void
}

type HistoryOptions = {
  startTime: Date
  playbackRate?: string | number
  subscribe?: unknown
}

type HistoryProvider = {
  hasAnyData: (
    options: HistoryOptions,
    cb: (hasResults: boolean) => void
  ) => void
  streamHistory: (
    spark: Spark,
    options: HistoryOptions,
    onChange: (delta: SignalKDelta) => void
  ) => () => void
}

type SubscriptionManager = {
  subscribe: (
    msg: WsMessage,
    unsubscribes: Array<() => void>,
    send: (message: SignalKDelta) => void,
    onDelta: (delta: SignalKDelta) => void,
    principal: unknown
  ) => void
  unsubscribe: (msg: WsMessage, unsubscribes: Array<() => void>) => void
}

type AppLike = EventEmitter & {
  server: unknown
  config: {
    settings: {
      ssl: boolean
      wsCompression?: boolean
      maxSendBufferSize?: number
      maxSendBufferCheckTime?: number
      trustProxy?: boolean | string
    }
    maxSendBufferSize?: number
    maxSendBufferCheckTime?: number
  }
  securityStrategy: SecurityStrategy
  signalk: EventEmitter
  deltaCache: {
    getCachedDeltas: (
      filter: (delta: SignalKDelta) => boolean,
      principal: unknown
    ) => SignalKDelta[]
  }
  subscriptionmanager: SubscriptionManager
  logging: { getLog: () => unknown[] }
  getHello: () => unknown
  handleMessage: (source: string, msg: unknown) => void
  setProviderError: (source: string, message: string) => void
  selfContext: string
  historyProvider?: HistoryProvider
}

type Accumulator = Parameters<typeof accumulateLatestValue>[0]

type Spark = EventEmitter & {
  id: string
  query: WsQuery
  request: WsRequest
  sendMetaDeltas?: boolean
  sentMetaData: Record<string, boolean>
  backpressure: {
    active: boolean
    accumulator: Accumulator
    since: number | null
  }
  logUnsubscribe?: () => void
  onDisconnects: Array<() => void>
  hasServerEvents?: boolean
  isHistory?: boolean
  bufferSizeExceeded?: number
  skPendingAccessRequest?: boolean
  write: (payload: unknown) => void
  end: (payload?: unknown, options?: unknown) => void
}

type PrimusInstance = {
  authorize: (
    handler: (req: WsRequest, cb: (error?: unknown) => void) => void
  ) => void
  on: (
    event: 'connection' | 'disconnection',
    handler: (spark: Spark) => void
  ) => void
  forEach: (handler: (spark: Spark) => void) => void
  destroy: (opts: { close: boolean; timeout: number }) => void
}

type PrimusCtor = new (server: unknown, options: unknown) => PrimusInstance

type AccessRequestResult = {
  state: string
  accessRequest?: { token?: string }
}

type RequestRecord = {
  requestId: string
  state: string
}

type RequestResponseApi = {
  findRequest: (
    predicate: (req: RequestRecord) => boolean
  ) => RequestRecord | undefined
  updateRequest: (
    requestId: string,
    state: string,
    reply: Partial<PutReply> & { statusCode?: number }
  ) => Promise<PutReply>
  queryRequest: (requestId: string) => Promise<PutReply>
}

type PutPath = (
  app: AppLike,
  context: string,
  path: string,
  put: PutMessage,
  req: WsRequest,
  requestId: string | undefined,
  cb: (reply: PutReply) => void
) => Promise<unknown>

type DeletePath = (
  app: AppLike,
  context: string,
  path: string,
  req: WsRequest,
  requestId: string | undefined,
  cb: (reply: PutReply) => void
) => Promise<unknown>

const Primus = PrimusModule as unknown as PrimusCtor

const debug = createDebug('signalk-server:interfaces:ws')
const debugConnection = createDebug('signalk-server:interfaces:ws:connections')

const requestResponseApi = {
  findRequest,
  updateRequest,
  queryRequest
} as RequestResponseApi

const {
  findRequest: findWsRequest,
  updateRequest: updateWsRequest,
  queryRequest: queryWsRequest
} = requestResponseApi

const { putPath: putPathFn, deletePath: deletePathFn } = {
  putPath,
  deletePath
} as unknown as { putPath: PutPath; deletePath: DeletePath }

const requestAccessFn = requestAccess as unknown as (
  app: AppLike,
  msg: WsMessage,
  ipAddress: string,
  cb: (res: AccessRequestResult) => void
) => Promise<AccessRequestResult>

// Backpressure thresholds - enter at 512KB, exit at ~0 (near-empty buffer)
// Draining fully before flush ensures user sees near-real-time data periodically
// Can override via env vars for testing: BACKPRESSURE_ENTER=1 BACKPRESSURE_EXIT=0
const BACKPRESSURE_ENTER_THRESHOLD = process.env.BACKPRESSURE_ENTER
  ? parseInt(process.env.BACKPRESSURE_ENTER, 10)
  : 512 * 1024
const BACKPRESSURE_EXIT_THRESHOLD = process.env.BACKPRESSURE_EXIT
  ? parseInt(process.env.BACKPRESSURE_EXIT, 10)
  : 1024

const ws = (app: AppLike) => {
  'use strict'

  debug(
    'Backpressure thresholds: enter=%d, exit=%d',
    BACKPRESSURE_ENTER_THRESHOLD,
    BACKPRESSURE_EXIT_THRESHOLD
  )

  const api: {
    mdns: { name: string; type: string; port: number | string }
    numClients: () => number
    canHandlePut: (path: string, source?: string) => boolean
    handlePut: (
      requestId: string,
      context: string,
      path: string,
      source: string | undefined,
      value: unknown
    ) => Promise<PutReply>
    start: () => void
    stop: () => void
  } = {
    mdns: {
      name: app.config.settings.ssl ? '_signalk-wss' : '_signalk-ws',
      type: 'tcp',
      port: ports.getExternalPort(app as unknown as WithConfig)
    },
    numClients: () => 0,
    canHandlePut: () => false,
    handlePut: () => Promise.resolve({ state: 'COMPLETED' }),
    start: () => undefined,
    stop: () => undefined
  }

  let primuses: PrimusInstance[] = []
  const pathSources: Record<string, Record<string, Spark>> = {}

  api.numClients = function () {
    let count = 0
    primuses.forEach((primus) =>
      primus.forEach(() => {
        count++
      })
    )
    return count
  }

  api.canHandlePut = function (path, source) {
    const sources = pathSources[path]
    return Boolean(sources && (!source || sources[source]))
  }

  api.handlePut = function (requestId, context, path, source, value) {
    return new Promise((resolve, reject) => {
      const sources = pathSources[path]
      if (sources) {
        let spark: Spark | undefined
        if (source) {
          spark = sources[source]
        } else if (_.keys(sources).length === 1) {
          spark = _.values(sources)[0]
        } else {
          updateWsRequest(requestId, 'COMPLETED', {
            statusCode: 400,
            message:
              'there are multiple sources for the given path, but no source was specified in the request'
          })
            .then(resolve)
            .catch(reject)
          return
        }

        if (!spark) {
          reject(new Error('no spark found'))
          return
        }

        const listener = (msg: PutReply) => {
          if (msg.requestId === requestId) {
            updateWsRequest(requestId, msg.state, msg)
              .then((reply) => {
                if (reply.state !== 'PENDING') {
                  spark?.removeListener('data', listener)
                }
              })
              .catch(() => {
                console.error(`could not update requestId ${requestId}`)
              })
          }
        }
        spark.on('data', listener)
        setTimeout(() => {
          const request = findWsRequest((r) => r.requestId === requestId)
          if (request && request.state === 'PENDING') {
            spark?.removeListener('data', listener)
            updateWsRequest(requestId, 'COMPLETED', { statusCode: 504 })
          }
        }, 60 * 1000)

        spark.write({
          requestId: requestId,
          context: context,
          put: [{ path: path, value: value }]
        })

        updateWsRequest(requestId, 'PENDING', { statusCode: 202 })
          .then(resolve)
          .catch(reject)
      } else {
        reject(new Error('no source found'))
      }
    })
  }

  api.start = function () {
    debug('Starting Primus/WS interface')

    let baseOptions: Record<string, unknown> = {
      transformer: 'websockets',
      pingInterval: false
    }
    if (app.config.settings.wsCompression) {
      baseOptions = {
        ...baseOptions,
        compression: true,
        transport: {
          perMessageDeflate: { threshold: 0 }
        }
      }
    }

    const allWsOptions = [
      {
        ...baseOptions,
        pathname: '/signalk/v1/stream',
        isPlayback: false
      },
      {
        ...baseOptions,
        pathname: '/signalk/v1/playback',
        isPlayback: true
      }
    ]

    const assertBufferSize = getAssertBufferSize(app.config)

    primuses = allWsOptions.map((primusOptions) => {
      const primus = new Primus(app.server, primusOptions)

      if (app.securityStrategy.canAuthorizeWS()) {
        primus.authorize(
          createPrimusAuthorize(app.securityStrategy.authorizeWS)
        )
      }

      primus.on('connection', function (spark) {
        let principalId: string | undefined
        if (spark.request.skPrincipal) {
          principalId = spark.request.skPrincipal.identifier
        }

        debugConnection(
          `${spark.id} connected ${JSON.stringify(spark.query)} ${
            spark.request.connection.remoteAddress
          }:${principalId}`
        )

        spark.sendMetaDeltas = spark.query.sendMeta === 'all'
        spark.sentMetaData = {}

        // Initialize backpressure state for graceful degradation on slow connections
        spark.backpressure = {
          active: false,
          accumulator: new Map(),
          since: null
        }

        // Listen for buffer drain to flush accumulated values
        spark.request.socket.on('drain', () => {
          if (
            spark.backpressure.active &&
            spark.backpressure.accumulator.size > 0
          ) {
            const bufferSize = spark.request.socket.bufferSize
            if (bufferSize <= BACKPRESSURE_EXIT_THRESHOLD) {
              flushAccumulator(app, spark)
            }
          }
        })

        let onChange = (delta: SignalKDelta) => {
          const filtered = app.securityStrategy.filterReadDelta(
            spark.request.skPrincipal,
            delta
          )
          if (!filtered) return

          const bufferSize = spark.request.socket.bufferSize

          if (bufferSize > BACKPRESSURE_ENTER_THRESHOLD) {
            // Enter/stay in backpressure mode - accumulate latest values only
            if (!spark.backpressure.active) {
              spark.backpressure.active = true
              spark.backpressure.since = Date.now()
              debug(
                'Entering backpressure mode for spark %s (buffer: %d)',
                spark.id,
                bufferSize
              )
            }
            accumulateLatestValue(spark.backpressure.accumulator, filtered)
          } else {
            // Normal mode - send immediately
            sendMetaData(app, spark, filtered)
            spark.write(filtered)
          }

          assertBufferSize(spark)
        }

        const unsubscribes: Array<() => void> = []

        if (primusOptions.isPlayback) {
          spark.on('data', () => {
            console.error('Playback does not support ws upstream messages')
            spark.end('Playback does not support ws upstream messages')
          })
        } else {
          spark.on('data', function (msg: Buffer) {
            let parsed: WsMessage
            try {
              parsed = JSON.parse(msg.toString()) as WsMessage
            } catch (e) {
              const error = e as Error
              debug('Failed to parse message: ' + error.message)
              return
            }
            debug('<' + JSON.stringify(parsed))

            try {
              if (parsed.token) {
                spark.request.token = parsed.token
              }

              if (parsed.updates) {
                processUpdates(app, pathSources, spark, parsed)
              }

              if (parsed.subscribe) {
                processSubscribe(
                  app,
                  unsubscribes,
                  spark,
                  assertBufferSize,
                  parsed
                )
              }

              if (parsed.unsubscribe) {
                processUnsubscribe(app, unsubscribes, parsed, onChange, spark)
              }

              if (parsed.accessRequest) {
                processAccessRequest(spark, parsed)
              }

              if (parsed.login && app.securityStrategy.supportsLogin()) {
                processLoginRequest(spark, parsed)
              }

              if (parsed.put) {
                processPutRequest(spark, parsed)
              }

              if (parsed.delete) {
                processDeleteRequest(spark, parsed)
              }

              if (parsed.requestId && parsed.query) {
                processReuestQuery(spark, parsed)
              }
            } catch (e) {
              console.error(e)
            }
          })
        }

        spark.on('end', function () {
          debugConnection(
            `${spark.id} end ${JSON.stringify(spark.query)} ${
              spark.request.connection.remoteAddress
            }:${principalId}`
          )

          unsubscribes.forEach((unsubscribe) => unsubscribe())

          _.keys(pathSources).forEach((path) => {
            _.keys(pathSources[path]).forEach((source) => {
              if (pathSources[path][source] === spark) {
                debug('removing source for %s', path)
                delete pathSources[path][source]
              }
            })
          })
        })

        if (isSelfSubscription(spark.query)) {
          const realOnChange = onChange
          onChange = function (msg: SignalKDelta) {
            if (!msg.context || msg.context === app.selfContext) {
              realOnChange(msg)
            }
          }
        }

        if (spark.query.subscribe === 'none') {
          onChange = () => undefined
        }

        onChange = wrapWithverifyWS(app.securityStrategy, spark, onChange)

        spark.onDisconnects = []

        if (primusOptions.isPlayback) {
          if (!spark.query.startTime) {
            spark.end(
              'startTime is a required query parameter for playback connections'
            )
          } else {
            handlePlaybackConnection(app, spark, onChange)
          }
        } else {
          handleRealtimeConnection(app, spark, onChange)
        }
      })

      primus.on('disconnection', function (spark) {
        spark.onDisconnects.forEach((f) => f())
        debug(spark.id + ' disconnected')
      })

      return primus
    })
  }

  api.stop = function () {
    debug('Destroying primuses...')
    primuses.forEach((primus) =>
      primus.destroy({
        close: false,
        timeout: 500
      })
    )
  }

  function processReuestQuery(spark: Spark, msg: WsMessage) {
    if (!msg.requestId) {
      return
    }
    queryWsRequest(msg.requestId)
      .then((reply) => {
        spark.write(reply)
      })
      .catch(() => {
        spark.write({
          requestId: msg.requestId,
          statusCode: 404
        })
      })
  }

  function processPutRequest(spark: Spark, msg: WsMessage) {
    if (!msg.put) {
      return
    }
    putPathFn(
      app,
      msg.context || '',
      msg.put.path,
      msg.put,
      spark.request,
      msg.requestId,
      (reply) => {
        debug('sending put update %j', reply)
        spark.write(reply)
      }
    ).catch((err: Error) => {
      console.error(err)
      spark.write({
        requestId: msg.requestId,
        state: 'COMPLETED',
        statusCode: 502,
        message: err.message
      })
    })
  }

  function processDeleteRequest(spark: Spark, msg: WsMessage) {
    if (!msg.delete) {
      return
    }
    deletePathFn(
      app,
      msg.context || '',
      msg.delete.path,
      spark.request,
      msg.requestId,
      (reply) => {
        debug('sending put update %j', reply)
        spark.write(reply)
      }
    ).catch((err: Error) => {
      console.error(err)
      spark.write({
        requestId: msg.requestId,
        state: 'COMPLETED',
        statusCode: 502,
        message: err.message
      })
    })
  }

  function processAccessRequest(spark: Spark, msg: WsMessage) {
    if (spark.skPendingAccessRequest) {
      spark.write({
        requestId: msg.requestId,
        state: 'COMPLETED',
        statusCode: 400,
        message: 'A request has already been submitted'
      })
    } else {
      const forwardedFor = spark.request.headers['x-forwarded-for']
      const remoteAddress = spark.request.connection.remoteAddress
      const ipAddress =
        (app.config.settings.trustProxy &&
          app.config.settings.trustProxy !== 'false' &&
          forwardedFor) ||
        remoteAddress

      requestAccessFn(app, msg, ipAddress, (res) => {
        if (res.state === 'COMPLETED') {
          spark.skPendingAccessRequest = false

          if (res.accessRequest && res.accessRequest.token) {
            spark.request.token = res.accessRequest.token
            app.securityStrategy.authorizeWS?.(spark.request)
            if (spark.request.skPrincipal?.identifier) {
              spark.request.source =
                'ws.' + spark.request.skPrincipal.identifier.replace(/\./g, '_')
            }
          }
        }
        spark.write(res)
      })
        .then((res) => {
          if (res.state === 'PENDING') {
            spark.skPendingAccessRequest = true
          }
          // nothing, callback above will get called
        })
        .catch((err: Error) => {
          console.log(err.stack)
          spark.write({
            requestId: msg.requestId,
            state: 'COMPLETED',
            statusCode: 502,
            message: err.message
          })
        })
    }
  }

  function processLoginRequest(spark: Spark, msg: WsMessage) {
    const login = app.securityStrategy.login
    if (!login || !msg.login) {
      return
    }
    login(msg.login.username, msg.login.password)
      .then((reply) => {
        if (reply.token) {
          spark.request.token = reply.token
          app.securityStrategy.authorizeWS?.(spark.request)
        }
        spark.write({
          requestId: msg.requestId,
          state: 'COMPLETED',
          statusCode: reply.statusCode,
          login: {
            token: reply.token
          }
        })
      })
      .catch((err: Error) => {
        console.error(err)
        spark.write({
          requestId: msg.requestId,
          state: 'COMPLETED',
          statusCode: 502,
          message: err.message
        })
      })
  }

  return api
}

function createPrimusAuthorize(authorizeWS?: (req: WsRequest) => void) {
  return function (req: WsRequest, authorized: (error?: unknown) => void) {
    try {
      // can't do primus.use for cookies because it will come after authorized
      if (req.headers.cookie) {
        req.cookies = cookieParser.parse(req.headers.cookie)
      }

      authorizeWS?.(req)
      authorized()

      const identifier = _.get(req, 'skPrincipal.identifier') as
        | string
        | undefined
      if (identifier) {
        debug(`authorized username: ${identifier}`)
        req.source = 'ws.' + identifier.replace(/\./g, '_')
      }
    } catch (error) {
      // To be able to login or request access via WS with security in place
      // only clearly invalid tokens result in 401 response, so that we can inform
      // the client that the credentials do not work.
      if (
        error instanceof InvalidTokenError ||
        error instanceof JsonWebTokenError ||
        error instanceof TokenExpiredError
      ) {
        authorized(error)
      } else {
        authorized()
      }
    }
  }
}

function processUpdates(
  app: AppLike,
  pathSources: Record<string, Record<string, Spark>>,
  spark: Spark,
  msg: WsMessage
) {
  if (!app.securityStrategy.shouldAllowWrite(spark.request, msg)) {
    debug('security disallowed update')
    app.setProviderError(
      'ws',
      spark.request.connection.remoteAddress + ' needs authentication'
    )
    return
  }
  app.handleMessage(spark.request.source || 'ws', msg)

  msg.updates?.forEach((update) => {
    if (update.values) {
      let source = update.$source
      if (!source && update.source) {
        source = getSourceId(update.source)
      }

      if (source) {
        update.values.forEach((valuePath) => {
          if (!pathSources[valuePath.path]) {
            pathSources[valuePath.path] = {}
          }
          if (
            !pathSources[valuePath.path][source] ||
            pathSources[valuePath.path][source] !== spark
          ) {
            if (pathSources[valuePath.path][source]) {
              console.log(
                `WARNING: got a new ws client for path ${valuePath.path} source ${source}`
              )
            }
            debug(
              'registered spark for source %s path %s = %s',
              source,
              valuePath.path,
              spark.id
            )

            pathSources[valuePath.path][source] = spark
          }
        })
      }
    }
  })
}

/*
  Keep a list of shared context-path strings that is shared across ws connections.
  This way the string values are shared across ws connections and not recreated
  for each context-path-ws combination. This reduces memory consumption for
  multiple ws clients.
  Nevertheless we need to purge this data eventually, otherwise the strings for
  AIS targets will stay forever, so implement a simple total purge. This may cause
  some thrashing, but is better than not sharing the values.
*/
let canonical_meta_contextpath_values: Record<
  string,
  Record<string, string>
> = {}
const getContextPathMetaKey = (context: string, path: string) => {
  const contextPaths =
    canonical_meta_contextpath_values[context] ||
    (canonical_meta_contextpath_values[context] = {})
  const result =
    contextPaths[path] || (contextPaths[path] = `${context}.${path}`)
  return result
}
setInterval(
  () => {
    canonical_meta_contextpath_values = {}
  },
  30 * 60 * 1000
)

function handleValuesMeta(
  this: { context: string; spark: Spark; timestamp?: string },
  kp: { path?: string }
) {
  const fullContextPathKey = getContextPathMetaKey(this.context, kp.path || '')
  if (kp.path && !this.spark.sentMetaData[fullContextPathKey]) {
    const split = kp.path.split('.')
    for (let i = split.length; i > 1; i--) {
      const path = split.slice(0, i).join('.')
      const partialContextPathKey = getContextPathMetaKey(this.context, path)
      if (this.spark.sentMetaData[partialContextPathKey]) {
        //stop backing up the path with first prefix that has already been handled
        break
      } else {
        //always set to true, even if there is no meta for the path
        this.spark.sentMetaData[partialContextPathKey] = true
        const meta = getMetadata(partialContextPathKey)
        if (meta) {
          this.spark.write({
            context: this.context,
            updates: [
              {
                timestamp: this.timestamp,
                meta: [
                  {
                    path: path,
                    value: meta
                  }
                ]
              }
            ]
          })
        }
      }
    }
  }
}

function handleUpdatesMeta(
  this: { context: string; spark: Spark; timestamp?: string },
  update: DeltaUpdate
) {
  if (update.values) {
    this.timestamp = update.timestamp
    update.values.forEach(handleValuesMeta, this)
  }
}

function sendMetaData(app: AppLike, spark: Spark, delta: SignalKDelta) {
  if (spark.sendMetaDeltas && delta.updates) {
    const thisContext = {
      context: delta.context,
      spark
    }
    delta.updates.forEach(handleUpdatesMeta, thisContext)
  }
}

function processSubscribe(
  app: AppLike,
  unsubscribes: Array<() => void>,
  spark: Spark,
  assertBufferSize: (spark: Spark) => void,
  msg: WsMessage
) {
  const subscribe = msg.subscribe as Array<{ path?: string }> | undefined
  if (
    Array.isArray(subscribe) &&
    subscribe.length > 0 &&
    subscribe[0].path === 'log'
  ) {
    if (!spark.logUnsubscribe) {
      spark.logUnsubscribe = startServerLog(app, spark)
    }
  } else {
    app.subscriptionmanager.subscribe(
      msg,
      unsubscribes,
      spark.write.bind(spark),
      (message) => {
        const filtered = app.securityStrategy.filterReadDelta(
          spark.request.skPrincipal,
          message
        )
        if (!filtered) return

        const bufferSize = spark.request.socket.bufferSize

        if (bufferSize > BACKPRESSURE_ENTER_THRESHOLD) {
          // Enter/stay in backpressure mode - accumulate latest values only
          if (!spark.backpressure.active) {
            spark.backpressure.active = true
            spark.backpressure.since = Date.now()
            debug(
              'Entering backpressure mode for spark %s (buffer: %d)',
              spark.id,
              bufferSize
            )
          }
          accumulateLatestValue(spark.backpressure.accumulator, filtered)
        } else {
          // Normal mode - send immediately
          sendMetaData(app, spark, filtered)
          spark.write(filtered)
        }

        assertBufferSize(spark)
      },
      spark.request.skPrincipal
    )
  }
}

function processUnsubscribe(
  app: AppLike,
  unsubscribes: Array<() => void>,
  msg: WsMessage,
  onChange: (delta: SignalKDelta) => void,
  spark: Spark
) {
  try {
    const unsubscribe = msg.unsubscribe as Array<{ path?: string }> | undefined
    if (
      Array.isArray(unsubscribe) &&
      unsubscribe.length > 0 &&
      unsubscribe[0].path === 'log'
    ) {
      if (spark.logUnsubscribe) {
        spark.logUnsubscribe()
        spark.logUnsubscribe = undefined
      }
    } else {
      app.subscriptionmanager.unsubscribe(msg, unsubscribes)
      app.signalk.removeListener('delta', onChange)
      spark.sentMetaData = {}
    }
  } catch (e) {
    const error = e as Error
    console.log(error.message)
    spark.write(error.message)
    spark.end()
  }
}

const isSelfSubscription = (query: WsQuery) =>
  !query.subscribe || query.subscribe === 'self'

function wrapWithverifyWS<T>(
  securityStrategy: SecurityStrategy,
  spark: Spark,
  theFunction: (msg: T) => void
) {
  if (!securityStrategy.canAuthorizeWS()) {
    return theFunction
  }
  return (msg: T) => {
    try {
      securityStrategy.verifyWS(spark.request)
      theFunction(msg)
    } catch (error) {
      if (!spark.skPendingAccessRequest) {
        spark.end(
          '{message: "Connection disconnected by security constraint"}',
          {
            reconnect: true
          }
        )
      }
      console.error(error)
      return
    }
  }
}

function sendHello(
  app: AppLike,
  helloProps: Record<string, unknown>,
  spark: Spark
) {
  const hello = app.getHello() as Record<string, unknown>
  spark.write({
    ...hello,
    ...helloProps
  })
}

function handlePlaybackConnection(
  app: AppLike,
  spark: Spark,
  onChange: (delta: SignalKDelta) => void
) {
  const historyProvider = app.historyProvider
  if (!historyProvider) {
    spark.end('No history provider')
    return
  }

  const options: HistoryOptions = {
    startTime: new Date(spark.query.startTime),
    playbackRate: spark.query.playbackRate || 1
  }

  sendHello(app, options as Record<string, unknown>, spark)

  options.subscribe = spark.query.subscribe
  historyProvider.hasAnyData(options, (hasResults) => {
    if (hasResults) {
      spark.onDisconnects.push(
        historyProvider.streamHistory(spark, options, onChange)
      )
      spark.isHistory = true
    } else {
      spark.end('No data found')
    }
  })
}

function handleRealtimeConnection(
  app: AppLike,
  spark: Spark,
  onChange: (delta: SignalKDelta) => void
) {
  sendHello(app, {}, spark)

  app.signalk.on('delta', onChange)
  spark.onDisconnects.push(() => {
    app.signalk.removeListener('delta', onChange)
  })

  if (!(spark.request.query.sendCachedValues === 'false')) {
    sendLatestDeltas(app, app.deltaCache, app.selfContext, spark)
  }

  if (spark.query.serverevents === 'all') {
    spark.hasServerEvents = true
    startServerEvents(
      app,
      spark,
      wrapWithverifyWS(app.securityStrategy, spark, spark.write.bind(spark))
    )
  }

  if (spark.query.events) {
    startEvents(
      app,
      spark,
      wrapWithverifyWS(app.securityStrategy, spark, spark.write.bind(spark)),
      spark.query.events
    )
  }
}

function sendLatestDeltas(
  app: AppLike,
  deltaCache: AppLike['deltaCache'],
  selfContext: string,
  spark: Spark
) {
  let deltaFilter: (delta: SignalKDelta) => boolean = () => false
  if (!spark.query.subscribe || spark.query.subscribe === 'self') {
    deltaFilter = (delta) => delta.context === selfContext
  } else if (spark.query.subscribe === 'all') {
    deltaFilter = () => true
  }

  deltaCache
    .getCachedDeltas(deltaFilter, spark.request.skPrincipal)
    .forEach((delta) => {
      sendMetaData(app, spark, delta)
      spark.write(delta)
    })
}

function startServerLog(app: AppLike, spark: Spark) {
  const onServerLogEvent = wrapWithverifyWS(
    app.securityStrategy,
    spark,
    spark.write.bind(spark)
  )
  app.on('serverlog', onServerLogEvent)
  spark.onDisconnects.push(() => {
    app.removeListener('serverlog', onServerLogEvent)
  })
  app.logging.getLog().forEach((log) => {
    spark.write({
      type: 'LOG',
      data: log
    })
  })
  return () => {
    app.removeListener('serverlog', onServerLogEvent)
  }
}

/**
 * Flush accumulated values as spec-compliant deltas.
 * Uses buildFlushDeltas from LatestValuesAccumulator to build the deltas.
 */
function flushAccumulator(app: AppLike, spark: Spark) {
  const map = spark.backpressure.accumulator
  if (map.size === 0) return

  const countBefore = map.size
  const duration = spark.backpressure.since
    ? Date.now() - spark.backpressure.since
    : 0

  const deltas = buildFlushDeltas(map, duration)
  for (const delta of deltas) {
    sendMetaData(app, spark, delta)
    spark.write(delta)
  }

  map.clear()
  spark.backpressure.active = false
  spark.backpressure.since = null
  debug('Flushed %d accumulated values for spark %s', countBefore, spark.id)
}

function getAssertBufferSize(config: AppLike['config']) {
  const MAXSENDBUFFERSIZE =
    process.env.MAXSENDBUFFERSIZE || config.maxSendBufferSize || 4 * 512 * 1024
  const MAXSENDBUFFERCHECKTIME =
    process.env.MAXSENDBUFFERCHECKTIME ||
    config.maxSendBufferCheckTime ||
    30 * 1000
  debug(`MAXSENDBUFFERSIZE:${MAXSENDBUFFERSIZE}`)

  if (MAXSENDBUFFERSIZE === 0) {
    return (_spark: Spark) => undefined
  }

  return (spark: Spark) => {
    if (spark.request.socket.bufferSize > Number(MAXSENDBUFFERSIZE)) {
      if (!spark.bufferSizeExceeded) {
        console.warn(
          `${spark.id} outgoing buffer > max:${spark.request.socket.bufferSize}`
        )
        spark.bufferSizeExceeded = Date.now()
      }
      if (
        Date.now() - spark.bufferSizeExceeded >
        Number(MAXSENDBUFFERCHECKTIME)
      ) {
        spark.end({
          errorMessage:
            'Server outgoing buffer overflow, terminating connection'
        })
        console.error(
          'Send buffer overflow, terminating connection ' + spark.id
        )
      }
    } else {
      spark.bufferSizeExceeded = undefined
    }
  }
}

export = ws
