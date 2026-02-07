/*
 * Copyright 2014-2015 Fabian Tollenaar <fabian@starting-point.nl>
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

import * as dnssdModule from 'dnssd2'
import { hostname } from 'os'
import _ from 'lodash'

import { createDebug } from './debug'
import { WithConfig } from './app'
import * as ports from './ports'

const debug = createDebug('signalk-server:mdns')

const dnssd = dnssdModule as unknown as MdnsModule

type MdnsService = {
  name: string
}

type MdnsOptions = {
  txtRecord: TxtRecord
  txt: TxtRecord
  host?: string
}

type MdnsAdvertisement = {
  on: (event: 'error', cb: (err: Error) => void) => void
  start: () => void
  stop: () => void
}

type MdnsModule = {
  tcp: (name: string) => MdnsService
  Advertisement: new (
    type: MdnsService,
    port: number,
    options: MdnsOptions
  ) => MdnsAdvertisement
}

type MdnsInterface = {
  type: string
  name: string
  port: number
}

type App = WithConfig & {
  selfId: string
  interfaces: Record<string, { mdns?: MdnsInterface }>
}

type TxtRecord = {
  txtvers?: string
  swname?: string
  swvers?: string
  roles?: string
  self?: string
  vname?: string
  vmmsi?: string
  vuuid?: string
}

type MdnsResponder = {
  stop: () => void
}

const mdnsResponder = (app: App): MdnsResponder | undefined => {
  const config = app.config

  let mdns: MdnsModule = dnssd

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mdns = require('mdns') as MdnsModule
    debug('using  mdns')
  } catch (ex) {
    debug(ex)
    debug('mdns not found, using dnssd2')
  }

  if (typeof config.settings.mdns !== 'undefined' && !config.settings.mdns) {
    debug('Mdns disabled by configuration')
    return
  }

  let txtRecord: TxtRecord = {
    txtvers: '1',
    swname: config.name,
    swvers: config.version,
    // hardcoded out of master/slave, main/aux
    roles: 'master, main',
    self: app.selfId,
    vname: config.vesselName,
    vmmsi: config.vesselMMSI,
    vuuid: config.vesselUUID
  }

  // Strip all the null or empty props in txtRecord
  txtRecord = _.pickBy(txtRecord, _.identity) as TxtRecord

  const types: Array<{ type: MdnsService; port: number }> = []
  types.push({
    type: app.config.settings.ssl ? mdns.tcp('https') : mdns.tcp('http'),
    port: ports.getExternalPort(app)
  })

  for (const key in app.interfaces) {
    if (
      _.isObject(app.interfaces[key]) &&
      _.isObject(app.interfaces[key].mdns)
    ) {
      const service = app.interfaces[key].mdns as MdnsInterface

      if (
        'tcp'.indexOf(service.type) !== -1 &&
        service.name.charAt(0) === '_'
      ) {
        const typeFactory = mdns[service.type as keyof MdnsModule] as (
          name: string
        ) => MdnsService
        types.push({
          type: typeFactory(service.name),
          port: service.port
        })
      } else {
        debug('Not advertising mDNS service for interface: ' + key)
        debug(
          'mDNS service type should be TCP or HTTP, and the name should start with "_".'
        )
      }
    }
  }

  const options: MdnsOptions = {
    txtRecord,
    txt: txtRecord
  }

  const host = app.config.getExternalHostname()

  if (host !== hostname()) {
    options.host = host
  }

  debug(options)

  const ads: MdnsAdvertisement[] = []

  for (const type of types) {
    debug(
      'Starting mDNS ad: ' +
        type.type +
        ' ' +
        app.config.getExternalHostname() +
        ':' +
        type.port
    )
    const ad = new mdns.Advertisement(type.type, type.port, options)
    ad.on('error', (err) => {
      console.log(type.type.name)
      console.error(err)
    })
    ad.start()
    ads.push(ad)
  }

  return {
    stop: () => {
      ads.forEach((ad) => {
        debug('Stopping mDNS advertisement...')
        ad.stop()
      })
    }
  }
}

export = mdnsResponder
