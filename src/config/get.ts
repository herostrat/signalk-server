import path from 'path'
import { flow, get, partialRight } from 'lodash/fp'

type AppLike = {
  config: {
    appPath: string
  }
}

const appPath = path.normalize(__dirname + '/../../')
const addModules = partialRight(path.join, ['node_modules/']) as (
  base: string
) => string
const appModules = addModules(appPath)

// Return the appPath from an app object.
const getAppPath = get('config.appPath') as (app: AppLike) => string

// Build path to the public dir of a module. getInstalledPathSync(moduleName, { local: true })
const getModulePublic = (moduleName: string) => {
  const joinModule = partialRight(path.join, [moduleName, 'public']) as (
    base: string
  ) => string
  return flow(getAppPath, addModules, joinModule) as (app: AppLike) => string
}

export { appModules, appPath, getAppPath, getModulePublic }
