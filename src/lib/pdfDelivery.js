// Decide how a PDF enters the model context. Keep this pure so capability
// routing can be adversarially tested without loading the Vue/DOM store.
export const selectPdfDeliveryMode = ({
  protocol = 'openai',
  pdf = false,
  vision = false,
  hasBinary = false,
  allowNative = true
} = {}) => {
  if (allowNative && protocol === 'anthropic' && pdf && hasBinary) return 'native'
  if (vision) return 'images'
  return 'text'
}

export const pdfDeliveryModeLabel = (mode) => ({
  native: 'native PDF',
  images: 'page images',
  text: 'parsed text'
}[mode] || 'parsed text')
