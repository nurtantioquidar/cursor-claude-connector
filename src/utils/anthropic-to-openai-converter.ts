import type { AnthropicResponse } from '../types'

// Anthropic types
interface AnthropicMessage {
  id: string
  model: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  stop_reason?: string
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'redacted_thinking'
  id?: string
  name?: string
  text?: string
  input?: unknown
  thinking?: string
  signature?: string
  data?: string
}

interface AnthropicStreamEvent {
  type: string
  message?: AnthropicMessage
  content_block?: AnthropicContentBlock
  delta?: {
    text?: string
    partial_json?: string
    stop_reason?: string
    thinking?: string
    signature?: string
  }
  index?: number
  model?: string
  stop_reason?: string
  signature?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

interface AnthropicFullResponse {
  id: string
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// OpenAI types
interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface OpenAIResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    // OpenAI prompt_tokens_details for Cursor context panel integration
    prompt_tokens_details?: {
      cached_tokens: number
      audio_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens: number
      audio_tokens?: number
    }
  }
}

// Internal types
interface ToolCallTracker {
  id: string
  name: string
  arguments: string
}

interface MetricsData {
  model: string
  stop_reason: string | null
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  messageId: string | null
  openAIId: string | null
}

interface ProcessResult {
  type: 'chunk' | 'done'
  data?: OpenAIStreamChunk
}

// Thinking block tracking
interface ThinkingBlockData {
  thinking: string
  signature: string
}

// Converter state that needs to be maintained during streaming
export interface ConverterState {
  toolCallsTracker: Map<number, ToolCallTracker>
  metricsData: MetricsData
  lineBuffer: string
  // Thinking block tracking for cache
  thinkingBlock: ThinkingBlockData | null
  accumulatedText: string
  inThinkingBlock: boolean
  // Original model name from request (for Cursor context tracking)
  originalModel: string | null
}

// Create initial converter state
// originalModel: Pass the original model name from Cursor's request to preserve context tracking
export function createConverterState(originalModel?: string): ConverterState {
  return {
    toolCallsTracker: new Map(),
    metricsData: {
      model: originalModel || '',
      stop_reason: null,
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      messageId: null,
      openAIId: null,
    },
    lineBuffer: '',
    thinkingBlock: null,
    accumulatedText: '',
    inThinkingBlock: false,
    originalModel: originalModel || null,
  }
}

/**
 * Get the captured thinking block from the converter state.
 * Returns null if no thinking block was captured.
 */
export function getThinkingBlockFromState(state: ConverterState): {
  type: 'thinking'
  thinking: string
  signature: string
} | null {
  if (state.thinkingBlock && (state.thinkingBlock.thinking || state.thinkingBlock.signature)) {
    return {
      type: 'thinking',
      thinking: state.thinkingBlock.thinking,
      signature: state.thinkingBlock.signature,
    }
  }
  return null
}

/**
 * Get the accumulated text content from the converter state.
 */
export function getAccumulatedText(state: ConverterState): string {
  return state.accumulatedText
}

/**
 * Get usage metrics from the converter state (for streaming responses).
 */
export function getUsageFromState(state: ConverterState): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cacheHitRate?: number
} | null {
  const { metricsData } = state
  if (metricsData.input_tokens === 0 && metricsData.output_tokens === 0) {
    return null
  }

  const inputTokens = metricsData.input_tokens
  const outputTokens = metricsData.output_tokens
  const cacheCreationTokens = metricsData.cache_creation_input_tokens || undefined
  const cacheReadTokens = metricsData.cache_read_input_tokens || undefined

  // Calculate cache hit rate
  let cacheHitRate: number | undefined
  if (inputTokens > 0 && metricsData.cache_read_input_tokens > 0) {
    cacheHitRate = Math.round((metricsData.cache_read_input_tokens / inputTokens) * 100)
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    cacheHitRate,
  }
}

// Convert non-streaming response to OpenAI format (stateless)
// Includes prompt_tokens_details.cached_tokens for Cursor's context panel integration
// originalModel: Pass the original model name from Cursor's request to preserve context tracking
export function convertNonStreamingResponse(
  anthropicResponse: AnthropicResponse | AnthropicFullResponse,
  originalModel?: string,
): OpenAIResponse {
  // Map Anthropic cache tokens to OpenAI format for Cursor integration
  const cachedTokens = anthropicResponse.usage?.cache_read_input_tokens || 0

  const openAIResponse: OpenAIResponse = {
    id:
      'chatcmpl-' +
      (anthropicResponse.id || Date.now()).toString().replace('msg_', ''),
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    // Use original model name from request for Cursor's context window calculation
    model: originalModel || anthropicResponse.model || 'claude-unknown',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [],
        },
        finish_reason:
          anthropicResponse.stop_reason === 'end_turn'
            ? 'stop'
            : anthropicResponse.stop_reason === 'tool_use'
              ? 'tool_calls'
              : anthropicResponse.stop_reason || null,
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) +
        (anthropicResponse.usage?.output_tokens || 0),
      prompt_tokens_details: {
        cached_tokens: cachedTokens,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
      },
    },
  }

  // Process content blocks
  let textContent = ''
  for (const block of anthropicResponse.content || []) {
    if (block.type === 'text') {
      textContent += block.text
    } else if (block.type === 'tool_use' && block.id && block.name) {
      openAIResponse.choices[0].message.tool_calls.push({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      })
    }
  }

  // Set content only if there's text
  if (textContent) {
    openAIResponse.choices[0].message.content = textContent
  }

  return openAIResponse
}

// Process a chunk and update the state
export function processChunk(
  state: ConverterState,
  chunk: string,
  enableLogging: boolean = false,
): ProcessResult[] {
  const results: ProcessResult[] = []

  // Combine with pending data from previous chunk
  const fullContent = state.lineBuffer + chunk
  state.lineBuffer = '' // Clear buffer after combining

  const lines = fullContent.split('\n')

  // If the last line doesn't end with a newline, it's incomplete
  // Buffer it for the next chunk
  if (!fullContent.endsWith('\n')) {
    const lastLine = lines.pop()
    if (lastLine !== undefined) {
      state.lineBuffer = lastLine
    }
  }

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (trimmedLine === '') continue

    // Skip event lines in OpenAI format
    if (trimmedLine.startsWith('event:')) {
      continue
    }

    if (trimmedLine.startsWith('data: ') && trimmedLine.includes('{')) {
      try {
        const data: AnthropicStreamEvent = JSON.parse(
          trimmedLine.replace(/^data: /, ''),
        )

        // Skip certain event types that OpenAI doesn't use
        if (data.type === 'ping') {
          continue
        }

        // Handle thinking block start
        if (
          data.type === 'content_block_start' &&
          (data.content_block?.type === 'thinking' || data.content_block?.type === 'redacted_thinking')
        ) {
          state.inThinkingBlock = true
          state.thinkingBlock = {
            thinking: data.content_block.thinking || '',
            signature: data.content_block.signature || '',
          }
          continue
        }

        // Handle thinking_delta events
        if (data.type === 'content_block_delta' && data.delta?.thinking) {
          if (state.thinkingBlock) {
            state.thinkingBlock.thinking += data.delta.thinking
          }
          continue
        }

        // Handle signature_delta events
        if (data.type === 'content_block_delta' && data.delta?.signature) {
          if (state.thinkingBlock) {
            state.thinkingBlock.signature += data.delta.signature
          }
          continue
        }

        // Handle content_block_stop - capture signature if present
        if (data.type === 'content_block_stop') {
          if (state.inThinkingBlock && data.signature && state.thinkingBlock) {
            state.thinkingBlock.signature = data.signature
          }
          state.inThinkingBlock = false
          continue
        }

        // Skip text content_block_start (we only care about tool_use blocks)
        if (
          data.type === 'content_block_start' &&
          data.content_block?.type === 'text'
        ) {
          continue
        }

        // Update metrics
        updateMetrics(state.metricsData, data)

        // Transform to OpenAI format
        const openAIChunk = transformToOpenAI(state, data, enableLogging)

        if (openAIChunk) {
          results.push({
            type: 'chunk',
            data: openAIChunk,
          })
        }

        // Send usage chunk and [DONE] when message stops
        if (data.type === 'message_stop') {
          // Send usage information chunk before [DONE]
          const usageChunk = createUsageChunk(state)
          if (usageChunk) {
            results.push({
              type: 'chunk',
              data: usageChunk,
            })
          }

          results.push({
            type: 'done',
          })
        }
      } catch (parseError) {
        if (enableLogging) {
          console.error('Parse error:', parseError)
        }
      }
    }
  }

  return results
}

// Update metrics data
function updateMetrics(
  metricsData: MetricsData,
  data: AnthropicStreamEvent,
): void {
  if (data.type === 'message_start' && data.message) {
    metricsData.messageId = data.message.id
    if (data.message.model) {
      metricsData.model = data.message.model
    }
  }

  if (data.model) {
    metricsData.model = data.model
  }

  if (data.stop_reason) {
    metricsData.stop_reason = data.stop_reason
  }

  if (data.type === 'message_delta' && data?.delta?.stop_reason) {
    metricsData.stop_reason = data.delta.stop_reason
  }

  if (data.usage) {
    metricsData.input_tokens += data.usage.input_tokens || 0
    metricsData.output_tokens += data.usage.output_tokens || 0
    metricsData.cache_creation_input_tokens +=
      data.usage.cache_creation_input_tokens || 0
    metricsData.cache_read_input_tokens +=
      data.usage.cache_read_input_tokens || 0
  }

  if (data?.message?.usage) {
    if (data?.message?.model) {
      metricsData.model = data.message.model
    }
    metricsData.input_tokens += data.message.usage.input_tokens || 0
    metricsData.output_tokens += data.message.usage.output_tokens || 0
    metricsData.cache_creation_input_tokens +=
      data.message.usage.cache_creation_input_tokens || 0
    metricsData.cache_read_input_tokens +=
      data.message.usage.cache_read_input_tokens || 0
  }

  if (data?.message?.stop_reason) {
    metricsData.stop_reason = data.message.stop_reason
  }
}

// Extended usage type with OpenAI prompt_tokens_details for Cursor integration
interface OpenAIUsageWithDetails {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens: number
    audio_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens: number
    audio_tokens?: number
  }
}

// Create usage chunk for OpenAI format
// Includes prompt_tokens_details.cached_tokens for Cursor's context panel integration
function createUsageChunk(state: ConverterState): OpenAIStreamChunk | null {
  // Only send usage if we have token data
  if (
    state.metricsData.input_tokens === 0 &&
    state.metricsData.output_tokens === 0
  ) {
    return null
  }

  // Map Anthropic cache tokens to OpenAI format for Cursor integration
  // Anthropic: cache_read_input_tokens (tokens read from cache)
  // OpenAI: prompt_tokens_details.cached_tokens
  const cachedTokens = state.metricsData.cache_read_input_tokens || 0

  const usage: OpenAIUsageWithDetails = {
    prompt_tokens: state.metricsData.input_tokens,
    completion_tokens: state.metricsData.output_tokens,
    total_tokens:
      state.metricsData.input_tokens + state.metricsData.output_tokens,
    prompt_tokens_details: {
      cached_tokens: cachedTokens,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
    },
  }

  return {
    id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: state.originalModel || state.metricsData.model || 'claude-unknown',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
      },
    ],
    usage,
  } as OpenAIStreamChunk
}

// Transform Anthropic event to OpenAI format
function transformToOpenAI(
  state: ConverterState,
  data: AnthropicStreamEvent,
  enableLogging: boolean = false,
): OpenAIStreamChunk | null {
  let openAIChunk = null

  if (data.type === 'message_start' && data.message) {
    // Generate OpenAI-style ID
    const openAIId = 'chatcmpl-' + data.message.id.replace('msg_', '')
    state.metricsData.openAIId = openAIId
    
    // Store Anthropic's model but prefer original model for responses (for Cursor context tracking)
    if (!state.originalModel) {
      state.metricsData.model = data.message.model
    }

    openAIChunk = {
      id: openAIId,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      // Use original model name from request for Cursor's context window calculation
      model: state.originalModel || data.message.model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        },
      ],
    }
  } else if (
    data.type === 'content_block_start' &&
    data.content_block?.type === 'tool_use'
  ) {
    // Start of tool call - store the tool info for tracking
    if (enableLogging) {
      console.log('🔧 [ANTHROPIC] Tool Start:', {
        type: data.type,
        index: data.index,
        id: data.content_block.id,
        name: data.content_block.name,
      })
    }

    state.toolCallsTracker.set(data.index ?? 0, {
      id: data.content_block.id ?? '',
      name: data.content_block.name ?? '',
      arguments: '',
    })

    openAIChunk = {
      id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: state.originalModel || state.metricsData.model || 'claude-unknown',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: data.index ?? 0,
                id: data.content_block.id,
                type: 'function' as const,
                function: {
                  name: data.content_block.name,
                  arguments: '',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }

    if (enableLogging) {
      console.log(
        '📤 [OPENAI] Tool Start Chunk:',
        JSON.stringify(openAIChunk, null, 2),
      )
    }
  } else if (data.type === 'content_block_delta' && data.delta?.partial_json) {
    // Tool call arguments - OpenAI expects incremental string chunks
    if (enableLogging) {
      console.log('🔨 [ANTHROPIC] Tool Arguments Delta:', {
        index: data.index,
        partial_json: data.delta.partial_json,
      })
    }

    const toolCall = state.toolCallsTracker.get(data.index ?? 0)
    if (toolCall) {
      // Anthropic sends partial_json which might be a fragment or accumulated
      let newPart = ''

      // Check if this is a continuation of previous arguments
      if (
        toolCall.arguments &&
        data.delta.partial_json.startsWith(toolCall.arguments)
      ) {
        // It's accumulated - calculate the delta
        newPart = data.delta.partial_json.substring(toolCall.arguments.length)
        toolCall.arguments = data.delta.partial_json
      } else {
        // It's a fragment - append it
        newPart = data.delta.partial_json
        toolCall.arguments += data.delta.partial_json
      }

      if (enableLogging) {
        console.log('📊 [DELTA] Calculation:', {
          index: data.index,
          partial_json: data.delta.partial_json,
          accumulated: toolCall.arguments,
          newPart: newPart,
        })
      }

      openAIChunk = {
        id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: state.originalModel || state.metricsData.model || 'claude-unknown',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: data.index ?? 0,
                  function: {
                    arguments: newPart,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }

      if (enableLogging) {
        console.log(
          '📤 [OPENAI] Tool Arguments Chunk:',
          JSON.stringify(openAIChunk, null, 2),
        )
      }
    }
  } else if (data.type === 'content_block_delta' && data.delta?.text) {
    // Accumulate text for thinking cache
    state.accumulatedText += data.delta.text

    openAIChunk = {
      id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: state.originalModel || state.metricsData.model || 'claude-unknown',
      choices: [
        {
          index: 0,
          delta: { content: data.delta.text },
          finish_reason: null,
        },
      ],
    }
  } else if (data.type === 'message_delta' && data.delta?.stop_reason) {
    openAIChunk = {
      id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: state.originalModel || state.metricsData.model || 'claude-unknown',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            data.delta.stop_reason === 'end_turn'
              ? 'stop'
              : data.delta.stop_reason === 'tool_use'
                ? 'tool_calls'
                : data.delta.stop_reason,
        },
      ],
    }
  }

  return openAIChunk as OpenAIStreamChunk | null
}
