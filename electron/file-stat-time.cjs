'use strict'

const NS_PER_MS = 1_000_000n

const statMtimeMs = (stat) => {
  if (typeof stat?.mtimeNs === 'bigint') {
    return Number(stat.mtimeNs / NS_PER_MS) + Number(stat.mtimeNs % NS_PER_MS) / Number(NS_PER_MS)
  }
  return Number(stat?.mtimeMs)
}

module.exports = { statMtimeMs }
