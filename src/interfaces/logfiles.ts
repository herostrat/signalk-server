/*
 * Copyright 2018 Teppo Kurki <teppo.kurki@iki.fi>
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

import moment from 'moment'
import path from 'path'
import { getFullLogDir, listLogFiles } from '@signalk/streams/logging'
import { SERVERROUTESPREFIX } from '../constants'
import { ServerApp } from '../app'

module.exports = function (app: ServerApp) {
  return {
    start() {
      mountApi(app)
    },

    stop() {}
  }
}

function mountApi(app: ServerApp) {
  app.securityStrategy.addAdminMiddleware(`${SERVERROUTESPREFIX}/logfiles/`)
  app.get(`${SERVERROUTESPREFIX}/logfiles/`, async function (_, res) {
    try {
      const files = await listLogFiles(app)
      res.json(files)
    } catch (err) {
      console.error(err)
      res.status(500)
      res.json('Error reading logfiles list')
    }
  })
  app.get(`${SERVERROUTESPREFIX}/logfiles/:filename`, function (req, res) {
    // Decode URL-encoded characters first, then sanitize
    let filename = req.params.filename
    try {
      filename = decodeURIComponent(filename)
    } catch (_e) {
      // Invalid encoding
      res.status(400).send('Invalid filename')
      return
    }

    // Only allow simple filenames: alphanumeric, dots, hyphens, underscores
    // This prevents all path traversal attempts including encoded ones
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).send('Invalid filename')
      return
    }

    const logDir = getFullLogDir(app)
    const requestedPath = path.join(logDir, filename)

    // Verify the resolved path is still within the log directory
    const resolvedPath = path.resolve(requestedPath)
    const resolvedLogDir = path.resolve(logDir)
    if (!resolvedPath.startsWith(resolvedLogDir + path.sep)) {
      res.status(400).send('Invalid filename')
      return
    }

    res.sendFile(resolvedPath)
  })
  app.get(`${SERVERROUTESPREFIX}/ziplogs`, function (req, res) {
    const boatName = app.config.vesselName
      ? app.config.vesselName
      : app.config.vesselMMSI
        ? app.config.vesselMMSI
        : ''
    const sanitizedBoatName = boatName.replace(/\W/g, '_')
    const zipFileName = `sk-logs-${sanitizedBoatName}-${moment().format('YYYY-MM-DD-HH-mm')}`

    res.zip({
      files: [{ path: getFullLogDir(app), name: zipFileName }],
      filename: zipFileName + '.zip'
    })
  })
}

// Add `res.zip` method to the Response interface
declare module 'express-serve-static-core' {
  type ZipOptions = {
    filename: string
    files: {
      path: string
      name: string
    }[]
  }

  interface Response {
    zip(opts: ZipOptions): void
  }
}
