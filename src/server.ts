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
} from './utils/anthropic-to-openai-converter'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'
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
    }
  })
})

app.get('/v1/models', async (c: Context) => {
  const fallbackModels: ModelInfo[] = [
    { id: 'claude-3-5-sonnet-20241022', object: 'model', created: 1729555200, owned_by: 'anthropic' },
    { id: 'claude-3-5-haiku-20241022', object: 'model', created: 1729555200, owned_by: 'anthropic' },
    { id: 'claude-3-opus-20240229', object: 'model', created: 1709164800, owned_by: 'anthropic' },
    { id: 'claude-3-sonnet-20240229', object: 'model', created: 1709164800, owned_by: 'anthropic' },
    { id: 'claude-3-haiku-20240307', object: 'model', created: 1709769600, owned_by: 'anthropic' },
    { id: 'gpt-4o', object: 'model', created: 1715558400, owned_by: 'openai' },
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

const messagesFn = async (c: Context) => {
  let headers: Record<string, string> = c.req.header() as Record<string, string>
  headers.host = 'api.anthropic.com'
  const body: AnthropicRequestBody = await c.req.json()

  const isStreaming = body.stream === true

  console.log(`\n📥 [REQUEST] ${c.req.method} ${c.req.path}`)
  console.log(`🤖 Model: ${body.model}`)
  console.log(`📡 Streaming: ${isStreaming}`)

  const apiKey = c.req.header('authorization')?.split(' ')?.[1]

  // Only enforce API_KEY if it is defined in .env
  if (process.env.API_KEY && apiKey && apiKey !== 'undefined' && apiKey !== 'null' && apiKey !== '') {
    if (apiKey !== process.env.API_KEY) {
      console.log('❌ Invalid API Key provided in request')
      return c.json(
        {
          error: 'Authentication required',
          message: 'The provided API key does not match the API_KEY in your .env file.',
        },
        401,
      )
    }
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

      if (body.model.includes('opus')) {
        body.max_tokens = 32_000
      }
      if (body.model.includes('sonnet')) {
        body.max_tokens = 64_000
      }
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

    headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${oauthToken}`,
      'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,prompt-caching-2024-07-31',
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
      max_tokens: body.max_tokens || 4096,
      stream: body.stream,
      stop_sequences: body.stop_sequences || body.stop,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      metadata: body.metadata,
      tools: body.tools,
      tool_choice: body.tool_choice,
    };

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

    console.log(`📤 [FORWARD] Sending to Anthropic: ${anthropicBody.model}`)

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
        const converterState = createConverterState()
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
        } catch (error) {
          console.error('Stream error:', error)
        } finally {
          reader.releaseLock()
        }
      })
    } else {
      const responseData = (await response.json()) as AnthropicResponse

      if (transformToOpenAIFormat) {
        const openAIResponse = convertNonStreamingResponse(responseData)

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
