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
  // Vision capability never triggers eager page rendering. Non-native models
  // receive the complete PDF text layer; page pixels are produced only by an
  // explicit page-scoped Agent tool call.
  void vision
  return 'text'
}

export const pdfDeliveryModeLabel = (mode) => ({
  native: 'native PDF',
  text: 'parsed text'
}[mode] || 'parsed text')
