import 'dotenv/config'
import { Hono, Context } from 'hono'
import { serve } from '@hono/node-server'
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAccessToken } from './auth/oauth-manager'
import {
  login as oauthLogin,
  logout as oauthLogout,
  generateAuthSession,
  handleOAuthCallback,
} from './auth/oauth-flow'
import {
  createConverterState,
  processChunk,
  convertNonStreamingResponse,
  getThinkingBlockFromState,
  getAccumulatedText,
  getUsageFromState,
} from './utils/anthropic-to-openai-converter'
import {
  cacheThinkingBlockSync,
  injectCachedThinkingBlocks,
  isRedisAvailable,
  type ContentBlock,
  type AnthropicMessage,
  type InjectResult,
} from './utils/thinking-cache'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'
import {
  extractContext,
  extractUsage,
  formatContextLog,
  formatUsageLog,
  type ContextSummary,
  type UsageInfo,
} from './utils/context-extractor'
import type {
  AnthropicRequestBody,
  AnthropicResponse,
  ErrorResponse,
  SuccessResponse,
  ModelsListResponse,
  ModelInfo,
} from './types'

// Static files are served by Vercel, not needed here

const app = new Hono()

// Handle CORS preflight requests for all routes
app.options('*', corsPreflightHandler)

// Also add CORS headers to all responses
app.use('*', corsMiddleware)

const indexHtmlPath = join(process.cwd(), 'public', 'index.html')
let cachedIndexHtml: string | null = null

const getIndexHtml = async () => {
  if (!cachedIndexHtml) {
    cachedIndexHtml = await readFile(indexHtmlPath, 'utf-8')
  }
  return cachedIndexHtml
}

// Root route is handled by serving public/index.html directly
app.get('/', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

app.get('/index.html', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

// New OAuth start endpoint for UI
app.post('/auth/oauth/start', async (c: Context) => {
  try {
    const { authUrl, sessionId } = await generateAuthSession()

    return c.json({
      success: true,
      authUrl,
      sessionId,
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Failed to start OAuth flow',
        message: (error as Error).message,
      },
      500,
    )
  }
})

// New OAuth callback endpoint for UI
app.post('/auth/oauth/callback', async (c: Context) => {
  try {
    const body = await c.req.json()
    const { code } = body

    if (!code) {
      return c.json<ErrorResponse>(
        {
          error: 'Missing OAuth code',
          message: 'OAuth code is required',
        },
        400,
      )
    }

    // Extract verifier from code if it contains #
    const splits = code.split('#')
    const verifier = splits[1] || ''

    await handleOAuthCallback(code, verifier)

    return c.json<SuccessResponse>({
      success: true,
      message: 'OAuth authentication successful',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'OAuth callback failed',
        message: (error as Error).message,
      },
      500,
    )
  }
})

app.post('/auth/login/start', async (c: Context) => {
  try {
    console.log('\n Starting OAuth authentication flow...')
    const result = await oauthLogin()
    if (result) {
      return c.json<SuccessResponse>({
        success: true,
        message: 'OAuth authentication successful',
      })
    } else {
      return c.json<SuccessResponse>(
        { success: false, message: 'OAuth authentication failed' },
        401,
      )
    }
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/logout', async (c: Context) => {
  try {
    await oauthLogout()
    return c.json<SuccessResponse>({
      success: true,
      message: 'Logged out successfully',
    })
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/status', async (c: Context) => {
  try {
    const token = await getAccessToken()
    return c.json({ authenticated: !!token })
  } catch (error) {
    return c.json({ authenticated: false })
  }
})

app.get('/v1', (c) => {
  return c.json({
    status: 'running',
    message: 'Anthropic to OpenAI Proxy is active',
    endpoints: {
      models: '/v1/models',
      chat: '/v1/chat/completions',
      messages: '/v1/messages'
    },
    thinkingCache: {
      enabled: true,
      redisAvailable: isRedisAvailable(),
    }
  })
})

// Global logger to see every single hit to the server
app.use('*', async (c, next) => {
  console.log(`🌐 [CONNECTION] ${c.req.method} ${c.req.path}`)
  await next()
})

app.get('/v1/models', async (c: Context) => {
  const fallbackModels: ModelInfo[] = [
    // Cursor-compatible model variants (these match what Cursor expects)
    { id: 'claude-4-opus-high', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    { id: 'claude-4-opus-high-thinking', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    { id: 'claude-4-sonnet-high', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    { id: 'claude-4-sonnet-high-thinking', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    // Base Anthropic models
    { id: 'claude-opus-4-5', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    { id: 'claude-sonnet-4-5', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    // Legacy format
    { id: 'claude-4.5-sonnet', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    { id: 'claude-4.5-opus', object: 'model', created: 1730000000, owned_by: 'anthropic' },
    // Cursor/Composer Models (Catch-all to keep proxy active)
    { id: 'composer-1', object: 'model', created: 1730000000, owned_by: 'cursor' },
  ]

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 2000)

    const response = await fetch('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId))

    if (!response.ok) {
      return c.json<ModelsListResponse>({ object: 'list', data: fallbackModels })
    }

    const modelsData = (await response.json()) as any
    const anthropicProvider = modelsData.anthropic

    if (!anthropicProvider || !anthropicProvider.models) {
      return c.json<ModelsListResponse>({ object: 'list', data: fallbackModels })
    }

    // Convert models to OpenAI's format
    const fetchedModels: ModelInfo[] = Object.entries(anthropicProvider.models).map(
      ([modelId, modelData]: [string, any]) => {
        const releaseDate = modelData.release_date || '1970-01-01'
        const created = Math.floor(new Date(releaseDate).getTime() / 1000)
        return {
          id: modelId,
          object: 'model' as const,
          created: created,
          owned_by: 'anthropic',
        }
      },
    )

    // Merge with fallback to ensure we always have common models
    const allModelsMap = new Map();
    [...fallbackModels, ...fetchedModels].forEach(m => allModelsMap.set(m.id, m));
    const finalModels = Array.from(allModelsMap.values());

    finalModels.sort((a, b) => b.created - a.created)

    return c.json<ModelsListResponse>({
      object: 'list',
      data: finalModels,
    })
  } catch (error) {
    console.log('Using fallback models list due to fetch error')
    return c.json<ModelsListResponse>({
      object: 'list',
      data: fallbackModels,
    })
  }
})

// Model variant configurations for Cursor
// Maps Cursor model names to Anthropic API parameters
interface ModelVariantConfig {
  model: string
  maxTokens: number
  thinking: { type: 'enabled'; budget_tokens: number } | null
}

// Thinking configuration for models
const THINKING_CONFIG = { type: 'enabled' as const, budget_tokens: 32000 }

const MODEL_VARIANTS: Record<string, ModelVariantConfig> = {
  // Opus variants - ccproxy compatible format (claude-4-*)
  'claude-4-opus-high-thinking': {
    model: 'claude-opus-4-5',
    maxTokens: 64000,
    thinking: THINKING_CONFIG,
  },
  'claude-4-opus-high': {
    model: 'claude-opus-4-5',
    maxTokens: 32000,
    thinking: null,
  },
  // Sonnet variants - ccproxy compatible format (claude-4-*)
  'claude-4-sonnet-high-thinking': {
    model: 'claude-sonnet-4-5',
    maxTokens: 64000,
    thinking: THINKING_CONFIG,
  },
  'claude-4-sonnet-high': {
    model: 'claude-sonnet-4-5',
    maxTokens: 32000,
    thinking: null,
  },
  // Legacy format (claude-4.5-*)
  'claude-4.5-opus-high-thinking': {
    model: 'claude-opus-4-5',
    maxTokens: 64000,
    thinking: THINKING_CONFIG,
  },
  'claude-4.5-opus-high': {
    model: 'claude-opus-4-5',
    maxTokens: 32000,
    thinking: null,
  },
  'claude-4.5-sonnet-high-thinking': {
    model: 'claude-sonnet-4-5',
    maxTokens: 64000,
    thinking: THINKING_CONFIG,
  },
  'claude-4.5-sonnet-high': {
    model: 'claude-sonnet-4-5',
    maxTokens: 32000,
    thinking: null,
  },
}

const resolveModelVariant = (model: string): ModelVariantConfig & { originalModel: string } => {
  const normalizedModel = model.toLowerCase().trim()
  
  // Check if it's a known Cursor variant (case-insensitive)
  for (const [key, config] of Object.entries(MODEL_VARIANTS)) {
    if (key.toLowerCase() === normalizedModel) {
      return { ...config, originalModel: model }
    }
  }

  // Check if model name contains 'thinking' - enable thinking for any thinking variant
  if (normalizedModel.includes('thinking')) {
    // Determine base model
    let baseModel = 'claude-sonnet-4-5' // default
    if (normalizedModel.includes('opus')) {
      baseModel = 'claude-opus-4-5'
    } else if (normalizedModel.includes('haiku')) {
      baseModel = 'claude-haiku-4-5'
    }
    
    console.log(`🔍 [MODEL] Detected thinking variant: ${model} -> ${baseModel} with thinking`)
    return {
      model: baseModel,
      maxTokens: 64000,
      thinking: THINKING_CONFIG,
      originalModel: model,
    }
  }

  // Handle Anthropic format directly (passthrough with defaults)
  if (normalizedModel.startsWith('claude-')) {
    return {
      model,
      maxTokens: 8192,
      thinking: null,
      originalModel: model,
    }
  }

  // Unknown format, passthrough with defaults
  return {
    model,
    maxTokens: 8192,
    thinking: null,
    originalModel: model,
  }
}

const messagesFn = async (c: Context) => {
  let headers: Record<string, string> = c.req.header() as Record<string, string>
  headers.host = 'api.anthropic.com'
  const body: AnthropicRequestBody = await c.req.json()

  // Resolve model variant to get model name, max tokens, and thinking config
  const variant = resolveModelVariant(body.model)
  const originalModel = body.model
  body.model = variant.model

  const isStreaming = body.stream === true

  console.log(`\n📥 [REQUEST] ${c.req.method} ${c.req.path}`)
  console.log(`🤖 Model: ${originalModel}${originalModel !== body.model ? ` -> ${body.model}` : ''}`)
  console.log(`📡 Streaming: ${isStreaming}`)
  if (variant.thinking) {
    console.log(`🧠 Thinking: enabled, budget_tokens=${variant.thinking.budget_tokens}`)
  }

  // Extract and log context information from Cursor request
  const contextSummary = extractContext(body)
  console.log(formatContextLog(contextSummary))

  const apiKey = c.req.header('authorization')?.split(' ')?.[1]

  // Accept any key starting with 'sk-' or 'dummy' or the actual API_KEY
  // This allows the user to put a "dummy" key in Cursor to keep the override active
  // without breaking Cursor's own model routing logic.
  // if (process.env.API_KEY && apiKey) {
  //   const isAcceptedKey = apiKey === process.env.API_KEY ||
  //     apiKey.startsWith('sk-') ||
  //     apiKey.includes('proxy') ||
  //     apiKey === 'dummy'

  //   if (!isAcceptedKey) {
  //     console.log(`⚠️ Warning: Non-standard Key mismatch (Received: ${apiKey.substring(0, 8)}...), but proceeding to OAuth check.`)
  //   }
  // }

  if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
    return c.json(
      {
        error: 'Authentication required',
        message: 'Please authenticate use the API key from the .env file',
      },
      401,
    )
  }

  // Selective Gateway: Only handle Claude models.
  // If Cursor sends a non-Claude model (like gpt-4o or deepseek) to this proxy,
  // we return a 404 to force Cursor to try its next available provider (usually Cursor Cloud).
  const isClaudeModel = body.model.toLowerCase().includes('claude') ||
    body.model.toLowerCase().includes('sonnet') ||
    body.model.toLowerCase().includes('opus') ||
    body.model.toLowerCase().includes('haiku')

  if (!isClaudeModel && !isCursorKeyCheck(body)) {
    console.log(`🚫 [SELECTIVE 404] Model ${body.model} not handled by proxy. Forcing Cursor internal fallback.`)
    return c.json(
      {
        error: {
          message: `The model ${body.model} is not supported by this Claude Proxy. Requesting fallback to Cursor Pro servers.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_supported_by_proxy'
        }
      },
      404
    )
  }

  // Bypass cursor enable openai key check
  if (isCursorKeyCheck(body)) {
    if (isStreaming) {
      return stream(c, async (stream) => {
        const bypass = createCursorBypassResponse()
        const chunk = {
          id: bypass.id,
          object: 'chat.completion.chunk',
          created: bypass.created,
          model: bypass.model,
          choices: [
            {
              index: 0,
              delta: { content: bypass.choices[0].message.content },
              finish_reason: null,
            },
          ],
        }
        await stream.write(`data: ${JSON.stringify(chunk)}\n\n`)

        const finalChunk = JSON.parse(JSON.stringify(chunk))
        finalChunk.choices[0].delta = {}
        finalChunk.choices[0].finish_reason = 'stop'
        await stream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
        await stream.write('data: [DONE]\n\n')
      })
    }
    return c.json(createCursorBypassResponse())
  }

  try {
    let transformToOpenAIFormat = c.req.path.includes('/v1/chat/completions') || c.req.path.includes('/v1/models')

    if (
      !body.system?.[0]?.text?.includes(
        "You are Claude Code",
      ) && body.messages
    ) {
      const systemMessages = body.messages.filter((msg: any) => msg.role === 'system')
      body.messages = body.messages?.filter((msg: any) => msg.role !== 'system')
      transformToOpenAIFormat = true // not claude-code, need to transform to openai format
      if (!body.system) {
        body.system = []
      }

      // Check if system is a string and convert to array if needed
      if (typeof body.system === 'string') {
        const sysText = body.system;
        body.system = [{ type: 'text', text: sysText }];
      }

      // Inject basic Claude Code Persona
      body.system.unshift({
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      })

      for (const sysMsg of systemMessages) {
        body.system.push({
          type: 'text',
          text: sysMsg.content || ''
        })
      }

      // Use variant's maxTokens if available
      body.max_tokens = variant.maxTokens
    }

    const oauthToken = await getAccessToken()

    if (!oauthToken) {
      return c.json<ErrorResponse>(
        {
          error: 'Authentication required',
          message:
            'Please authenticate using OAuth first. Visit /auth/login for instructions.',
        },
        401,
      )
    }

    // Build anthropic-beta header - add interleaved-thinking when thinking is enabled
    const betaFeatures = ['oauth-2025-04-20', 'fine-grained-tool-streaming-2025-05-14', 'prompt-caching-2024-07-31']
    if (variant.thinking) {
      betaFeatures.push('interleaved-thinking-2025-05-14')
    }

    headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${oauthToken}`,
      'anthropic-beta': betaFeatures.join(','),
      'anthropic-version': '2023-06-01',
      'user-agent': 'anthropic-cli/0.2.29',
      'anthropic-client': 'anthropic-cli/0.2.29',
      accept: isStreaming ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'gzip, deflate',
    }

    // Clean body for Anthropic
    const anthropicBody: any = {
      model: body.model,
      messages: body.messages,
      system: body.system,
      max_tokens: body.max_tokens || variant.maxTokens || 4096,
      stream: body.stream,
      stop_sequences: body.stop_sequences || body.stop,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      metadata: body.metadata,
      tools: body.tools,
      tool_choice: body.tool_choice,
    };

    // Add thinking parameter if enabled for this model variant
    if (variant.thinking) {
      anthropicBody.thinking = variant.thinking
      // Note: temperature must be 1 when thinking is enabled (Anthropic requirement)
      anthropicBody.temperature = 1
    }

    // Remove undefined fields
    Object.keys(anthropicBody).forEach(key => anthropicBody[key] === undefined && delete anthropicBody[key]);

    if (transformToOpenAIFormat) {
      if (!anthropicBody.metadata) {
        anthropicBody.metadata = {}
      }

      if (!anthropicBody.system) {
        anthropicBody.system = []
      }
    }

    // Try to inject cached thinking blocks for multi-turn conversations
    let thinkingEnabled = !!variant.thinking
    if (anthropicBody.messages && anthropicBody.messages.length > 0) {
      const messagesWithThinking = anthropicBody.messages as AnthropicMessage[]
      const injectResult: InjectResult = await injectCachedThinkingBlocks(messagesWithThinking)
      
      if (injectResult.injectedCount > 0) {
        console.log(`🧠 [THINKING] Injected ${injectResult.injectedCount} cached thinking block(s)`)
      }
      
      // If we couldn't restore all thinking blocks, we must disable thinking
      // Anthropic requires ALL assistant messages to have thinking blocks when thinking is enabled
      if (variant.thinking && !injectResult.canUseThinking) {
        console.log(`⚠️ [THINKING] Disabling thinking - missing ${injectResult.missingCount} cached block(s)`)
        delete anthropicBody.thinking
        anthropicBody.temperature = body.temperature // Restore original temperature
        thinkingEnabled = false
        
        // Remove interleaved-thinking from beta headers
        const currentBeta = headers['anthropic-beta'] || ''
        headers['anthropic-beta'] = currentBeta
          .split(',')
          .filter((h: string) => !h.includes('interleaved-thinking'))
          .join(',')
      }
    }

    console.log(`📤 [FORWARD] Sending to Anthropic: ${anthropicBody.model}${thinkingEnabled ? ' (thinking enabled)' : ''}`)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(anthropicBody),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)

      if (response.status === 401) {
        return c.json<ErrorResponse>(
          {
            error: 'Authentication failed',
            message:
              'OAuth token may be expired. Please re-authenticate using /auth/login/start',
            details: error,
          },
          401,
        )
      }
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    if (isStreaming) {
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== 'content-encoding' &&
          key.toLowerCase() !== 'content-length' &&
          key.toLowerCase() !== 'transfer-encoding'
        ) {
          c.header(key, value)
        }
      })

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      return stream(c, async (stream) => {
        // Pass original model name for Cursor's context window tracking
        const converterState = createConverterState(originalModel)
        const enableLogging = false

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })

            if (transformToOpenAIFormat) {
              if (enableLogging) {
                console.log('🔄 [TRANSFORM MODE] Converting to OpenAI format')
              }

              const results = processChunk(converterState, chunk, enableLogging)

              for (const result of results) {
                if (result.type === 'chunk') {
                  const dataToSend = `data: ${JSON.stringify(result.data)}\n\n`
                  if (enableLogging) {
                    console.log('✅ [SENDING] OpenAI Chunk:', dataToSend)
                  }
                  await stream.write(dataToSend)
                } else if (result.type === 'done') {
                  await stream.write('data: [DONE]\n\n')
                }
              }
            } else {
              await stream.write(chunk)
            }
          }

          // Cache thinking block for future multi-turn conversations
          const thinkingBlock = getThinkingBlockFromState(converterState)
          const accumulatedText = getAccumulatedText(converterState)
          if (thinkingBlock && accumulatedText) {
            const contentBlocks: ContentBlock[] = [
              thinkingBlock,
              { type: 'text', text: accumulatedText },
            ]
            cacheThinkingBlockSync(contentBlocks, thinkingBlock)
          }

          // Log token usage from streaming response
          const streamUsage = getUsageFromState(converterState)
          if (streamUsage) {
            console.log(formatUsageLog(streamUsage))
          }
        } catch (error) {
          console.error('Stream error:', error)
        } finally {
          reader.releaseLock()
        }
      })
    } else {
      const responseData = (await response.json()) as AnthropicResponse

      // Log token usage from response
      const usageInfo = extractUsage(responseData)
      if (usageInfo) {
        console.log(formatUsageLog(usageInfo))
      }

      if (transformToOpenAIFormat) {
        // Pass original model name for Cursor's context window tracking
        const openAIResponse = convertNonStreamingResponse(responseData, originalModel)

        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-encoding') {
            c.header(key, value)
          }
        })

        return c.json(openAIResponse)
      }

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          c.header(key, value)
        }
      })

      return c.json(responseData)
    }
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
}

app.post('/v1/chat/completions', messagesFn)
app.post('/v1/messages', messagesFn)

// Add GET handlers for easier browser testing/confirmation
app.get('/v1/chat/completions', (c) => c.json({ error: 'Method Not Allowed', message: 'This endpoint requires a POST request with a JSON body.' }, 405))
app.get('/v1/messages', (c) => c.json({ error: 'Method Not Allowed', message: 'This endpoint requires a POST request with a JSON body.' }, 405))

// Helpful 404 handler for debugging
app.notFound((c) => {
  return c.json({
    error: 'Not Found',
    path: c.req.path,
    message: 'The requested endpoint does not exist. Please check the URL and HTTP method.',
    available_endpoints: [
      'GET /v1',
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/messages'
    ]
  }, 404)
})

const port = process.env.PORT || 9095

// Export app for Vercel
export default app

// Server is started differently for local development vs Vercel
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  console.log(`🚀 Server is running on http://localhost:${port}`)
  serve({
    fetch: app.fetch,
    port: Number(port),
    hostname: '0.0.0.0',
  })
}
