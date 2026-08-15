import { estimateAgentTokens } from './tokenEstimate.js'

const BATCH_SOURCE_RE = /(?:\.(?:md|markdown|txt|csv|rtf|js|mjs|cjs|jsx|ts|tsx|vue|css|scss|sass|less|html?|json|jsonc|ya?ml|toml|ini|conf|config|xml|py|java|kt|kts|c|h|cc|cpp|cxx|hpp|cs|go|rs|rb|php|swift|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|gql|proto|gradle|properties|env|docx|pptx|xlsx|odt|ods|odp)|(?:^|\/)(?:Dockerfile|Makefile|CMakeLists\.txt|Podfile|Gemfile|Rakefile|README|LICENSE|NOTICE|CHANGELOG)|(?:^|\/)\.(?:gitignore|gitattributes|editorconfig|npmrc|nvmrc|prettierrc|eslintrc))$/i

export { estimateAgentTokens }

export const isSupportedBatchSource = (path) => BATCH_SOURCE_RE.test(String(path || '').replace(/\\/g, '/'))

const batchFailure = (code, message) => Object.assign(new Error(message), { code })

export const validateBatchWorkerInput = ({ system, user, ctxWindow }) => {
  const inputTokens = estimateAgentTokens(system) + estimateAgentTokens(user) + 128
  const context = Math.max(0, Number(ctxWindow) || 0)
  const outputReserve = context
    ? Math.min(4096, Math.max(1024, Math.floor(context * 0.25)))
    : 4096
  const inputLimit = context ? Math.max(0, context - outputReserve) : 24000
  if (inputTokens > inputLimit) {
    throw batchFailure(
      'CONTEXT_LIMIT',
      `源文件与批处理指令预计需要 ${inputTokens} tokens，超过本次安全输入上限 ${inputLimit}；未调用模型，也未创建输出文件。`
    )
  }
  return { inputTokens, inputLimit, outputReserve }
}

export const validateBatchWorkerResponse = (response) => {
  if (response?.refusal) throw batchFailure('MODEL_REFUSED', '工作 Agent 拒绝了该文件，未创建输出文件。')
  if (response?.truncated) throw batchFailure('OUTPUT_TRUNCATED', '工作 Agent 的输出因长度限制被截断，未写入不完整结果。')
  if (response?.terminalComplete !== true) {
    throw batchFailure('MODEL_RESPONSE_INCOMPLETE', '工作 Agent 未返回可验证的完整终止状态，未写入其不完整文本。')
  }
  const text = String(response?.text || '')
  if (!text.trim()) throw batchFailure('EMPTY_OUTPUT', '工作 Agent 返回空结果，未创建输出文件。')
  return text
}
