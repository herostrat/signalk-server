/*
 * Copyright 2020 Scott Bender <scott@scottbender.net>
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

import * as canboatjsModule from '@canboat/canboatjs'
import * as n2kSignalkModule from '@signalk/n2k-signalk'
import * as nmea0183Module from '@signalk/nmea0183-signalk'
import { EventEmitter } from 'events'

import { deletePath, putPath } from '../put'

type AppLike = EventEmitter & {
  propertyValues?: unknown
  post: (path: string, handler: Handler) => void
  securityStrategy: {
    isDummy: () => boolean
    allowConfigure: (req: RequestLike) => boolean
  }
  handleMessage: (source: string, msg: unknown) => void
}

type RequestLike = {
  body: {
    value: string
    sendToServer?: boolean
    sendToN2K?: boolean
  }
}

type ResponseLike = {
  status: (code: number) => ResponseLike
  json: (payload: unknown) => ResponseLike
}

type Handler = (req: RequestLike, res: ResponseLike) => void

type PutReply = {
  state: string
  statusCode?: number
}

type SignalKDelta = {
  updates: Array<{
    values?: Array<{
      path?: string
      value?: unknown
    }>
  }>
}

type ParsedN2k = {
  pgn: number
}

type Parser0183 = {
  parse: (value: string) => SignalKDelta
}

type N2kMapper = {
  toDelta: (value: ParsedN2k) => SignalKDelta
}

type FromPgn = {
  parseString: (value: string) => ParsedN2k | null
}

type CanboatApi = {
  isN2KString?: (value: string) => boolean
  FromPgn: new (
    options: { useCamelCompat: boolean },
    propertyValues?: unknown
  ) => FromPgn
  pgnToActisenseSerialFormat: (value: string) => string
}

type N2kMapperCtor = new (
  options: { app: AppLike },
  propertyValues?: unknown
) => N2kMapper

type Parser0183Ctor = new (options: { app: AppLike }) => Parser0183

type SignalkPut = {
  path: string
  value?: unknown
  [key: string]: unknown
}

type SignalkDelete = {
  path: string
}

type SignalkMessage = {
  context?: string
  requestId?: string
  put?: SignalkPut
  delete?: SignalkDelete
  updates?: SignalKDelta['updates']
}

type DetectResult = {
  type?: 'n2k-json' | 'signalk' | 'n2k' | '0183'
  msgs?: SignalkMessage[] | string[]
  error?: string
}

type PutApp = Parameters<typeof putPath>[0]
type PutRequestBody = Parameters<typeof putPath>[3]
type PutRequest = Parameters<typeof putPath>[4]
type DeleteApp = Parameters<typeof deletePath>[0]
type DeleteRequest = Parameters<typeof deletePath>[3]

const Parser0183 = nmea0183Module as unknown as Parser0183Ctor
const { N2kMapper } = n2kSignalkModule as unknown as {
  N2kMapper: N2kMapperCtor
}
const { isN2KString, FromPgn, pgnToActisenseSerialFormat } =
  canboatjsModule as unknown as CanboatApi

const serverRoutesPrefix = '/skServer'

let n2kOutAvailable = false

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isSignalkMessage = (value: unknown): value is SignalkMessage =>
  isRecord(value)

const playground = (app: AppLike) => {
  const n2kMapper = new N2kMapper({ app }, app.propertyValues)
  const pgnParser = new FromPgn({ useCamelCompat: true }, app.propertyValues)

  app.on('nmea2000OutAvailable', () => {
    n2kOutAvailable = true
  })

  const processors = {
    n2k: (msgs: string[], sendToServer?: boolean) => {
      const n2kJson: ParsedN2k[] = []
      const deltas = msgs.map((msg) => {
        const n2k = pgnParser.parseString(msg)
        if (n2k) {
          if (sendToServer) {
            app.emit('N2KAnalyzerOut', n2k)
          }
          n2kJson.push(n2k)
          return n2kMapper.toDelta(n2k)
        }
        return undefined
      })
      return { deltas, n2kJson: n2kJson, n2kOutAvailable }
    },
    '0183': (msgs: string[]) => {
      const parser = new Parser0183({ app })
      return { deltas: msgs.map(parser.parse.bind(parser)) }
    },
    'n2k-json': (msgs: string[]) => {
      return processors.n2k(msgs.map(pgnToActisenseSerialFormat))
    }
  }

  function detectType(message: string): DetectResult {
    let type: DetectResult['type']
    const msg = message.trim()
    if (msg.charAt(0) === '{' || msg.charAt(0) === '[') {
      try {
        const parsed = JSON.parse(msg) as unknown
        const first = Array.isArray(parsed) ? parsed[0] : parsed

        if (isRecord(first) && 'pgn' in first) {
          type = 'n2k-json'
        } else if (
          isRecord(first) &&
          ('updates' in first || 'put' in first || 'delete' in first)
        ) {
          type = 'signalk'
        } else {
          return { error: 'unknown JSON format' }
        }
        const msgs = (
          Array.isArray(parsed) ? parsed : [parsed]
        ) as SignalkMessage[]
        return { type, msgs }
      } catch (ex) {
        const error = ex as Error
        console.error(error)
        return { error: error.message }
      }
    } else if (isN2KString) {
      // temporary until new canboatjs is released
      if (isN2KString(msg)) {
        type = 'n2k'
      } else if (msg.charAt(0) === '$' || msg.charAt(0) === '!') {
        type = '0183'
      } else {
        return { error: 'unable to determine message type' }
      }
    } else if (msg.charAt(0) === '$' || msg.charAt(0) === '!') {
      type = '0183'
    } else {
      type = 'n2k'
    }
    return { type, msgs: msg.split('\n').filter((s) => s.length > 0) }
  }

  app.post(`${serverRoutesPrefix}/inputTest`, (req, res) => {
    const sendToServer = req.body.sendToServer
    const sendToN2K = req.body.sendToN2K

    if (
      (sendToServer || sendToN2K) &&
      !app.securityStrategy.isDummy() &&
      !app.securityStrategy.allowConfigure(req)
    ) {
      res.status(400).json({ error: 'permission denied' })
      return
    }

    const { type, msgs, error } = detectType(req.body.value)

    if (error) {
      res.status(400).json({ error: error })
      return
    }

    if (sendToN2K && type !== 'n2k-json' && type !== 'n2k') {
      res.status(400).json({
        error: 'Please enter NMEA 2000 json format or Actisense format'
      })
      return
    }

    if (type === 'signalk') {
      const puts: Array<Promise<PutReply | string>> = []
      const signalkMsgs = (msgs ?? []).filter(isSignalkMessage)
      if (sendToServer) {
        signalkMsgs.forEach((msg) => {
          const put = msg.put
          const del = msg.delete
          if (put) {
            puts.push(
              new Promise((resolve) => {
                setTimeout(() => {
                  resolve('Timed out waiting for put result')
                }, 5000)
                putPath(
                  app as unknown as PutApp,
                  msg.context || '',
                  put.path || '',
                  put as PutRequestBody,
                  req as unknown as PutRequest,
                  msg.requestId,
                  (reply) => {
                    if (reply.state !== 'PENDING') {
                      resolve(reply)
                    }
                  }
                )
              })
            )
          } else if (del) {
            puts.push(
              new Promise((resolve) => {
                setTimeout(() => {
                  resolve('Timed out waiting for put result')
                }, 5000)
                deletePath(
                  app as unknown as DeleteApp,
                  msg.context || '',
                  del.path || '',
                  req as unknown as DeleteRequest,
                  msg.requestId,
                  (reply) => {
                    if (reply.state !== 'PENDING') {
                      resolve(reply)
                    }
                  }
                )
              })
            )
          } else {
            app.handleMessage('input-test', msg)
          }
        })
      }
      if (puts.length > 0) {
        Promise.all(puts).then((results) => {
          res.json({ deltas: signalkMsgs, putResults: results })
        })
      } else {
        res.json({ deltas: signalkMsgs })
      }
    } else if (sendToN2K && msgs) {
      const event = type === 'n2k' ? 'nmea2000out' : 'nmea2000JsonOut'
      msgs.forEach((msg) => {
        app.emit(event, msg)
      })
      res.json({ deltas: [] })
    } else if (msgs && type) {
      try {
        const data = processors[type](msgs as string[], sendToServer)

        if (data.deltas) {
          data.deltas = data.deltas.filter((m): m is SignalKDelta => {
            if (!m) {
              return false
            }
            const updates = m.updates
            const values = updates[0]?.values
            return (
              updates.length > 0 && Array.isArray(values) && values.length > 0
            )
          })
        }
        res.json(data)

        if (sendToServer) {
          data.deltas.forEach((msg) => {
            app.handleMessage('input-test', msg)
          })
        }
      } catch (ex) {
        const error = ex as Error
        console.error(error)
        res.status(400).json({ error: error.message })
      }
    }
  })
}

export = playground
