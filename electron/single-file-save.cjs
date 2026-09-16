'use strict'
const fs = require('node:fs')

// A user-approved single file may change inode through OUR atomic save. Only
// the verified staging-file identity may inherit the exact-path grant; never
// bless an arbitrary post-save path or grant its parent directory for writing.
const saveSingleFile = async ({ target, data, grant, capabilities, authorize, saveDocument }) => {
  authorize()
  if (typeof data !== 'string') {
    const error = new Error('write payload must be a string')
    error.code = 'INVALID_WRITE_PAYLOAD'
    throw error
  }
  const previous = fs.existsSync(target) ? capabilities.snapshot('file', target) : null
  const receipt = await saveDocument(target, data, {
    label: 'save',
    beforeCommit: () => {
      authorize()
      if (previous ? !capabilities.matches('file', previous) : fs.existsSync(target)) throw new Error('open target destination changed')
    }
  })
  const current = capabilities.snapshot('file', target)
  const committed = receipt?.committedStat
  if (!committed || current.dev !== String(committed.dev) || current.ino !== String(committed.ino)) {
    const error = new Error('saved file was replaced before grant renewal')
    error.code = 'WRITE_COMMIT_UNCERTAIN'
    throw error
  }
  // The caller validates the frozen parent independently of the old inode.
  authorize({ committed: true })
  if (!capabilities.matches('file', current)) throw new Error('open target destination changed')
  grant.expected = current
  return capabilities.issueSnapshot('file', current)
}

module.exports = { saveSingleFile }
