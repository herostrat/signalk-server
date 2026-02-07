import _ from 'lodash'
import { createDebug } from './debug'
import { createRequest, updateRequest, RequestState, Reply } from './requestResponse'
import {
  readDefaultsFile,
  writeDefaultsFile,
  writeBaseDeltasFile,
  ConfigApp
} from './config/config'
import { getMetadata } from '@signalk/signalk-schema'
import type { Request, Response } from 'express'
import type { SignalKMessageHub } from './app'
import type {
  ActionHandler as ServerActionHandler,
  ActionResult,
  Context,
  Delta,
  Path,
  SourceRef
} from '@signalk/server-api'

const debug = createDebug('signalk-server:put')

const pathPrefix = '/signalk'
const versionPrefix = '/v1'
const apiPathPrefix = pathPrefix + versionPrefix + '/api/'

type ActionReplyState = ActionResult['state'] | 'SUCCESS' | 'FAILURE'

type ActionReply = {
  state: ActionReplyState
  statusCode?: number
  message?: string
  href?: string
  action?: { href: string }
}

type ActionCallback = (reply: ActionResult | ActionReply) => void

type MetaHandler = (
  context: string,
  path: string,
  value: unknown,
  cb: ActionCallback
) => ActionReply

type DeleteHandler = (context: string, path: string, cb: ActionCallback) => ActionReply

type PutRequestBody = {
  value: unknown
  source?: string
}

type RequestWithPrincipal = Request & { skPrincipal?: { identifier: string } }

type WsPutHandler = {
  canHandlePut: (path: string, source?: string) => boolean
  handlePut: (
    requestId: string,
    context: string,
    path: string,
    source: string | undefined,
    value: unknown
  ) => Promise<Reply>
}

type PutApp = ConfigApp &
  SignalKMessageHub & {
    interfaces: { ws?: WsPutHandler; [key: string]: unknown }
    registerActionHandler?: typeof registerActionHandler
    deRegisterActionHandler?: typeof deRegisterActionHandler
  }

const actionHandlers: Record<string, Record<string, Record<string, ServerActionHandler>>> = {}
let putMetaHandler: MetaHandler
let deleteMetaHandler: DeleteHandler
let putNotificationHandler: MetaHandler

export function start(app: PutApp): void {
  app.registerActionHandler = registerActionHandler
  app.deRegisterActionHandler = deRegisterActionHandler

  app.delete(apiPathPrefix + '*', function (req: Request, res: Response) {
    let path = String(req.path).replace(apiPathPrefix, '')

    path = path.replace(/\/$/, '').replace(/\//g, '.')

    const parts = path.length > 0 ? path.split('.') : []

    if (parts.length < 3) {
      res.status(400).send('invalid path')
      return
    }

    const context = `${parts[0]}.${parts[1]}`
    const skpath = parts.slice(2).join('.')

    deletePath(app, context, skpath, req)
      .then((reply) => {
        res.status(reply.statusCode)
        res.json(reply)
      })
      .catch((err) => {
        console.error(err)
        res.status(500).send(err.message)
      })
  })

  app.put(apiPathPrefix + '*', function (req: Request, res: Response) {
    let path = String(req.path).replace(apiPathPrefix, '')

    const value = req.body as PutRequestBody

    if (_.isUndefined(value.value)) {
      res.status(400).send('input is missing a value')
      return
    }

    path = path.replace(/\/$/, '').replace(/\//g, '.')

    const parts = path.length > 0 ? path.split('.') : []

    if (parts.length < 3) {
      res.status(400).send('invalid path')
      return
    }

    const context = `${parts[0]}.${parts[1]}`
    const skpath = parts.slice(2).join('.')

    putPath(app, context, skpath, value, req)
      .then((reply) => {
        res.status(reply.statusCode)
        res.json(reply)
      })
      .catch((err) => {
        console.error(err)
        res.status(500).send(err.message)
      })
  })

  putMetaHandler = (context, path, value, cb) => {
    const parts = path.split('.')
    let metaPath = path
    let metaValue = value as Record<string, unknown>

    if (parts[parts.length - 1] !== 'meta') {
      const name = parts[parts.length - 1]
      metaPath = parts.slice(0, parts.length - 2).join('.')

      metaValue = {
        ...app.config.baseDeltaEditor.getMeta(context, metaPath),
        [name]: value
      }
    } else {
      metaPath = parts.slice(0, parts.length - 1).join('.')
    }

    // set empty zones array explicitly to null
    for (const prop in metaValue) {
      if (Array.isArray(metaValue[prop]) && metaValue[prop].length === 0) {
        metaValue[prop] = null
      }
    }

    app.config.baseDeltaEditor.setMeta(context, metaPath, metaValue)

    const fullMeta =
      (getMetadata(`vessels.self.${metaPath}`) as Record<string, unknown>) ?? {}

    app.handleMessage('defaults', {
      context: 'vessels.self' as Context,
      updates: [
        {
          meta: [
            {
              path: metaPath as Path,
              value: { ...fullMeta, ...metaValue }
            }
          ]
        }
      ]
    })

    if (app.config.hasOldDefaults) {
      let data: Record<string, unknown>

      try {
        data = readDefaultsFile(app) as Record<string, unknown>
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code && err.code === 'ENOENT') {
          data = {}
        } else {
          console.error(err)
          cb({ state: 'FAILURE', message: 'Unable to read defaults file' })
          return { state: 'PENDING' }
        }
      }

      const pathWithContext = `${context}.${path}`
      _.set(data, pathWithContext, value)

      writeDefaultsFile(app, data, (err: Error) => {
        if (err) {
          cb({ state: 'FAILURE', message: 'Unable to save to defaults file' })
        } else {
          cb({ state: 'SUCCESS' })
        }
      })
    } else {
      writeBaseDeltasFile(app)
        .then(() => {
          cb({ state: 'SUCCESS' })
        })
        .catch(() => {
          cb({ state: 'FAILURE', message: 'Unable to save to defaults file' })
        })
    }

    return { state: 'PENDING' }
  }

  deleteMetaHandler = (context, path, cb) => {
    const parts = path.split('.')
    let metaPath = path
    let fullMeta: Record<string, unknown>

    if (parts[parts.length - 1] !== 'meta') {
      const name = parts[parts.length - 1]
      metaPath = parts.slice(0, parts.length - 2).join('.')

      const metaValue = {
        ...app.config.baseDeltaEditor.getMeta(context, metaPath)
      } as Record<string, unknown>

      if (typeof metaValue[name] === 'undefined') {
        return { state: 'COMPLETED', statusCode: 404 }
      }

      delete metaValue[name]

      fullMeta =
        (getMetadata(`vessels.self.${metaPath}`) as Record<string, unknown>) ?? {}
      delete fullMeta[name]

      app.config.baseDeltaEditor.setMeta(context, metaPath, metaValue)

      if (Object.keys(metaValue).length === 0) {
        app.config.baseDeltaEditor.removeMeta(context, metaPath)
      }
    } else {
      metaPath = parts.slice(0, parts.length - 1).join('.')

      fullMeta =
        (getMetadata(`vessels.self.${metaPath}`) as Record<string, unknown>) ?? {}
      const metaValue = app.config.baseDeltaEditor.getMeta(context, metaPath)

      if (!metaValue) {
        return { state: 'COMPLETED', statusCode: 404 }
      }

      Object.keys(metaValue).forEach((key) => {
        delete fullMeta[key]
      })

      app.config.baseDeltaEditor.removeMeta(context, metaPath)
    }

    app.handleMessage('defaults', {
      context: 'vessels.self' as Context,
      updates: [
        {
          meta: [
            {
              path: metaPath as Path,
              value: fullMeta
            }
          ]
        }
      ]
    })

    writeBaseDeltasFile(app)
      .then(() => {
        cb({ state: 'COMPLETED', statusCode: 200 })
      })
      .catch(() => {
        cb({
          state: 'COMPLETED',
          statusCode: 502,
          message: 'Unable to save to defaults file'
        })
      })

    return { state: 'PENDING' }
  }

  putNotificationHandler = (context, path, value, _cb): ActionReply => {
    return putNotification(app, context, path, value)
  }
}

export function registerActionHandler(
  context: string,
  path: string,
  callback: ServerActionHandler,
  source?: string
): () => void
export function registerActionHandler(
  context: string,
  path: string,
  source: string,
  callback: ServerActionHandler
): () => void
export function registerActionHandler(
  context: string,
  path: string,
  sourceOrCallback: string | ServerActionHandler,
  callback?: ServerActionHandler | string
): () => void {
  const source =
    typeof sourceOrCallback === 'string'
      ? sourceOrCallback
      : typeof callback === 'string'
        ? callback
        : 'default'
  const handler =
    typeof sourceOrCallback === 'function'
      ? sourceOrCallback
      : (callback as ServerActionHandler)

  debug(`registered action handler for ${context} ${path} ${source}`)

  if (_.isUndefined(actionHandlers[context])) {
    actionHandlers[context] = {}
  }
  if (_.isUndefined(actionHandlers[context][path])) {
    actionHandlers[context][path] = {}
  }
  actionHandlers[context][path][source] = handler

  return () => {
    deRegisterActionHandler(context, path, source, handler)
  }
}

export function deRegisterActionHandler(
  context: string,
  path: string,
  source: string,
  callback: ServerActionHandler
): void {
  if (
    actionHandlers[context] &&
    actionHandlers[context][path][source] === callback
  ) {
    delete actionHandlers[context][path][source]
    debug(`de-registered action handler for ${context} ${path} ${source}`)
  }
}

export function deletePath(
  app: PutApp,
  contextParam: string,
  path: string,
  req?: RequestWithPrincipal,
  requestId?: string,
  updateCb?: (reply: Reply) => void
): Promise<Reply> {
  const context = contextParam || 'vessels.self'
  debug('received delete %s %s', context, path)
  return new Promise((resolve, reject) => {
    createRequest(
      app,
      'delete',
      {
        context: context,
        requestId: requestId,
        delete: { path: path }
      },
      req?.skPrincipal?.identifier,
      undefined,
      updateCb
    )
      .then((request) => {
        if (req && app.securityStrategy.shouldAllowPut(req, context, null, path) === false) {
          updateRequest(request.requestId, 'COMPLETED', { statusCode: 403 })
            .then(resolve)
            .catch(reject)
          return
        }

        const parts = path.split('.')
        let handler: DeleteHandler | undefined

        if (
          (parts.length > 1 && parts[parts.length - 1] === 'meta') ||
          (parts.length > 1 && parts[parts.length - 2] === 'meta')
        ) {
          handler = deleteMetaHandler
        }

        if (handler) {
          const actionResult = handler(context, path, (reply) => {
            debug('got result: %j', reply)
            updateRequest(request.requestId, toRequestState(reply.state), reply)
              .then(() => undefined)
              .catch((err) => {
                console.error(err)
              })
          })

          Promise.resolve(actionResult)
            .then((result) => {
              debug('got result: %j', result)
              updateRequest(request.requestId, toRequestState(result.state), result)
                .then((reply) => {
                  if (reply.state === 'PENDING') {
                    // backwards compatibility
                    const replyWithAction = reply as Reply & {
                      action?: { href: string }
                    }
                    replyWithAction.action = { href: reply.href }
                  }
                  resolve(reply)
                })
                .catch(reject)
            })
            .catch((err) => {
              updateRequest(request.requestId, 'COMPLETED', {
                statusCode: 500,
                message: err.message
              })
                .then(resolve)
                .catch(reject)
            })
        } else {
          updateRequest(request.requestId, 'COMPLETED', {
            statusCode: 405,
            message: `DELTETE not supported for ${path}`
          })
            .then(resolve)
            .catch(reject)
        }
      })
      .catch(reject)
  })
}

export function putPath(
  app: PutApp,
  contextParam: string,
  path: string,
  body: PutRequestBody,
  req?: RequestWithPrincipal,
  requestId?: string,
  updateCb?: (reply: Reply) => void
): Promise<Reply> {
  const context = contextParam || 'vessels.self'
  debug('received put %s %s %j', context, path, body)
  return new Promise((resolve, reject) => {
    createRequest(
      app,
      'put',
      {
        context: context,
        requestId: requestId,
        put: { path: path, value: body.value }
      },
      req?.skPrincipal?.identifier,
      undefined,
      updateCb
    )
      .then((request) => {
        if (req && app.securityStrategy.shouldAllowPut(req, context, null, path) === false) {
          updateRequest(request.requestId, 'COMPLETED', { statusCode: 403 })
            .then(resolve)
            .catch(reject)
          return
        }

        let handler: ServerActionHandler | MetaHandler | undefined
        const parts = path.split('.')

        if (
          (parts.length > 1 && parts[parts.length - 1] === 'meta') ||
          (parts.length > 1 && parts[parts.length - 2] === 'meta')
        ) {
          handler = putMetaHandler
        } else {
          const handlers = actionHandlers[context]
            ? actionHandlers[context][path]
            : null

          if (handlers && _.keys(handlers).length > 0) {
            if (body.source) {
              handler = handlers[body.source]
            } else if (_.keys(handlers).length === 1) {
              handler = _.values(handlers)[0]
            } else {
              updateRequest(request.requestId, 'COMPLETED', {
                statusCode: 400,
                message:
                  'there are multiple sources for the given path, but no source was specified in the request'
              })
                .then(resolve)
                .catch(reject)
              return
            }
          }

          if (!handler && parts[0] === 'notifications') {
            handler = putNotificationHandler
          }
        }

        if (handler) {
          function fixReply(reply: ActionResult | ActionReply) {
            if (reply.state === 'FAILURE' || reply.state === 'FAILED') {
              reply.state = 'COMPLETED'
              reply.statusCode = 502
            } else if (reply.state === 'SUCCESS') {
              reply.state = 'COMPLETED'
              reply.statusCode = 200
            }
          }

          const actionResult = handler(context, path, body.value, (reply) => {
            debug('got result: %j', reply)
            fixReply(reply)
            updateRequest(request.requestId, toRequestState(reply.state), reply)
              .then(() => undefined)
              .catch((err) => {
                console.error(err)
              })
          })

          Promise.resolve(actionResult)
            .then((result) => {
              debug('got result: %j', result)
              fixReply(result)
              updateRequest(request.requestId, toRequestState(result.state), result)
                .then((reply) => {
                  if (reply.state === 'PENDING') {
                    // backwards compatibility
                    const replyWithAction = reply as Reply & {
                      action?: { href: string }
                    }
                    replyWithAction.action = { href: reply.href }
                  }
                  resolve(reply)
                })
                .catch(reject)
            })
            .catch((err) => {
              updateRequest(request.requestId, 'COMPLETED', {
                statusCode: 500,
                message: err.message
              })
                .then(resolve)
                .catch(reject)
            })
        } else if (app.interfaces.ws && app.interfaces.ws.canHandlePut(path, body.source)) {
          app.interfaces.ws
            .handlePut(request.requestId, context, path, body.source, body.value)
            .then(resolve)
            .catch(reject)
        } else {
          updateRequest(request.requestId, 'COMPLETED', {
            statusCode: 405,
            message: `PUT not supported for ${path}`
          })
            .then(resolve)
            .catch(reject)
        }
      })
      .catch(reject)
  })
}

function putNotification(
  app: PutApp,
  context: string,
  path: string,
  value: unknown
): ActionReply {
  const parts = path.split('.')
  const notifPath = parts.slice(0, parts.length - 1).join('.')
  const key = parts[parts.length - 1]

  const signalkSelf = (app.signalk as unknown as { self?: unknown }).self
  const existing = _.get(signalkSelf, notifPath) as {
    value?: Record<string, unknown>
    $source?: string
    timestamp?: string
  } | null

  if (_.isUndefined(existing) || !existing?.value) {
    return { state: 'COMPLETED', statusCode: 404 }
  }

  if (key !== 'method' && key !== 'state') {
    return { state: 'COMPLETED', statusCode: 405 }
  }

  existing.value[key] = value
  existing.timestamp = new Date().toISOString()

  const delta: Partial<Delta> = {
    updates: [
      {
        $source: existing.$source as SourceRef | undefined,
        values: [
          {
            path: notifPath as Path,
            value: existing.value
          }
        ]
      }
    ]
  }
  app.handleMessage('server', delta)

  return { state: 'COMPLETED', statusCode: 200 }
}

function toRequestState(state: ActionReplyState): RequestState {
  return state === 'PENDING' ? 'PENDING' : 'COMPLETED'
}

export default {
  start,
  registerActionHandler,
  putPath,
  deletePath
}