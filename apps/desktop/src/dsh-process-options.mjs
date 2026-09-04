export function buildDshChildEnvironment({ environment, dshHome, packaged }) {
  const result = {}
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value === 'string') result[name] = value
  }
  result.DSH_HOME = dshHome
  if (packaged) result.DSH_DISABLE_HMR = '1'
  return result
}
