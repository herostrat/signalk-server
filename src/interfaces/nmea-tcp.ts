/*
 * Copyright 2015 Teppo Kurki <teppo.kurki@iki.fi>
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

import { EventEmitter } from 'events'
import _ from 'lodash'

import { createDebug } from '../debug'

const debug = createDebug('signalk-server:interfaces:tcp:nmea0183')

type AppLike = EventEmitter & {
  signalk: EventEmitter
}

type TcpSocket = import('net').Socket & {
  id: number
  name: string
}

type NmeaTcpApi = {
  start: () => void
  stop: () => void
  mdns: { name: string; type: string; port: string | number }
}

const nmeaTcp = (app: AppLike): NmeaTcpApi => {
  const net = require('net') as typeof import('net')
  const openSockets: Record<number, TcpSocket> = {}
  let idSequence = 0
  let server: import('net').Server | null = null
  const port = process.env.NMEA0183PORT || 10110
  const api = {} as NmeaTcpApi

  api.start = () => {
    debug('Starting tcp interface')

    server = net.createServer((socket) => {
      const tcpSocket = socket as TcpSocket
      tcpSocket.id = idSequence++
      tcpSocket.name = `${tcpSocket.remoteAddress}:${tcpSocket.remotePort}`
      debug(`Connected:${tcpSocket.id} ${tcpSocket.name}`)
      openSockets[tcpSocket.id] = tcpSocket
      tcpSocket.on('data', (data) => {
        app.emit('tcpserver0183data', data.toString())
      })
      tcpSocket.on('end', () => {
        // client disconnects
        debug(`Ended:${tcpSocket.id} ${tcpSocket.name}`)
        delete openSockets[tcpSocket.id]
      })
      tcpSocket.on('error', (err) => {
        debug(`Error:${err} ${tcpSocket.id} ${tcpSocket.name}`)
        delete openSockets[tcpSocket.id]
      })
    })
    const send = (data: string) => {
      _.values(openSockets).forEach((socket) => {
        try {
          socket.write(`${data}\r\n`)
        } catch (e) {
          console.error(`${e} ${socket}`)
        }
      })
    }
    app.signalk.on('nmea0183', send)
    app.on('nmea0183out', send)
    server.on('listening', () =>
      debug(`NMEA0138 tcp server listening on ${port}`)
    )
    server.on('error', (e) => {
      console.error(`NMEA0138 tcp server error: ${e.message}`)
    })
    server.listen(port)
  }

  api.stop = () => {
    if (server) {
      server.close()
      server = null
    }
  }

  api.mdns = {
    name: '_nmea-0183',
    type: 'tcp',
    port: port
  }

  return api
}

export = nmeaTcp
