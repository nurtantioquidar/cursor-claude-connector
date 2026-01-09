/**
 * Thinking Block Cache
 *
 * Caches thinking blocks from assistant responses so they can be re-injected
 * into conversation history when Cursor doesn't preserve them.
 *
 * The Anthropic API requires that when thinking is enabled, all prior assistant
 * messages must include valid thinking blocks with cryptographic signatures.
 * Cursor strips these, so we cache them and re-inject on subsequent requests.
 *
 * Storage: Upstash Redis (persistent, serverless-compatible)
 */

import { Redis } from '@upstash/redis'

// Debug mode
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1'

function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[ThinkingCache]', ...args)
  }
}

// Content block types
export interface ContentBlock {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result'
  text?: string
  thinking?: string
  signature?: string
  data?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ContentBlock[]
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

// Cache configuration
const CACHE_TTL_DAYS = parseInt(process.env.THINKING_CACHE_TTL_DAYS || '10', 10)
const CACHE_TTL_SECONDS = CACHE_TTL_DAYS * 24 * 60 * 60
const CACHE_KEY_PREFIX = 'thinking:'

// In-memory cache for fast lookups (session-level, not persistent across serverless invocations)
interface CachedThinkingBlock {
  thinkingBlock: ContentBlock
  timestamp: number
}
const memoryCache = new Map<string, CachedThinkingBlock>()
const MAX_MEMORY_CACHE_SIZE = 100 // Smaller for serverless

// Redis client (lazy initialized)
let redisClient: Redis | null = null

function getRedis(): Redis | null {
  if (redisClient) return redisClient

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (
    url &&
    token &&
    url !== 'https://your-redis-instance.upstash.io' &&
    token !== 'your-redis-rest-token'
  ) {
    redisClient = new Redis({ url, token })
    return redisClient
  }

  return null
}

/**
 * Generate a cache key from assistant message content.
 * Uses a simple hash of the normalized content for reliable matching.
 */
function generateCacheKey(content: string | ContentBlock[]): string {
  let textContent = ''

  if (typeof content === 'string') {
    textContent = content
  } else if (Array.isArray(content)) {
    // Extract text from content blocks, excluding thinking blocks
    const parts: string[] = []
    for (const block of content) {
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        continue // Skip thinking blocks
      }
      if (block.type === 'text') {
        parts.push(block.text || '')
      } else if (block.type === 'tool_use') {
        const inputStr = block.input
          ? JSON.stringify(block.input, Object.keys(block.input as object).sort())
          : '{}'
        parts.push(`tool:${block.name}:${inputStr}`)
      } else if (block.type === 'tool_result') {
        const contentStr =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        parts.push(`result:${block.tool_use_id}:${contentStr}`)
      }
    }
    textContent = parts.join('|')
  }

  // Normalize whitespace
  const normalized = textContent.replace(/\s+/g, ' ').trim()

  // Simple hash function (works in both Node and browser)
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }

  const key = `v2:${Math.abs(hash)}:${normalized.length}`
  debugLog('Generated key:', key, 'from content length:', normalized.length)

  return key
}

/**
 * Clean up memory cache - enforce size limit
 */
function cleanupMemoryCache(): void {
  if (memoryCache.size > MAX_MEMORY_CACHE_SIZE) {
    const entries = Array.from(memoryCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    )

    const toRemove = entries.slice(0, entries.length - MAX_MEMORY_CACHE_SIZE)
    for (const [key] of toRemove) {
      memoryCache.delete(key)
    }
  }
}

/**
 * Cache a thinking block for an assistant message.
 * Stores in both memory cache (fast) and Redis (persistent).
 */
export async function cacheThinkingBlock(
  assistantContent: ContentBlock[],
  thinkingBlock: ContentBlock,
): Promise<void> {
  // Generate key from non-thinking content
  const nonThinkingContent = assistantContent.filter(
    (block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
  )

  if (nonThinkingContent.length === 0) {
    debugLog('SKIP: No non-thinking content to cache against')
    return
  }

  const key = generateCacheKey(nonThinkingContent)
  const thinkingLen = thinkingBlock.thinking?.length || 0
  const sigLen = thinkingBlock.signature?.length || 0

  debugLog(`Caching thinking block: ${thinkingLen} chars, signature: ${sigLen} chars`)

  const cacheData: CachedThinkingBlock = {
    thinkingBlock,
    timestamp: Date.now(),
  }

  // Store in memory cache
  cleanupMemoryCache()
  memoryCache.set(key, cacheData)

  // Store in Redis (persistent)
  const redis = getRedis()
  if (redis) {
    try {
      await redis.set(`${CACHE_KEY_PREFIX}${key}`, JSON.stringify(cacheData), {
        ex: CACHE_TTL_SECONDS,
      })
      console.log(`[ThinkingCache] ✓ Cached thinking block (${thinkingLen} chars)`)
    } catch (error) {
      console.error('[ThinkingCache] Redis write failed:', error)
    }
  } else {
    // Memory-only mode
    console.log(`[ThinkingCache] ✓ Cached in memory (${thinkingLen} chars) - no Redis configured`)
  }
}

/**
 * Synchronous cache for use in streaming context.
 * Fires and forgets the async Redis write.
 */
export function cacheThinkingBlockSync(
  assistantContent: ContentBlock[],
  thinkingBlock: ContentBlock,
): void {
  // Fire and forget - don't await
  cacheThinkingBlock(assistantContent, thinkingBlock).catch((err) => {
    console.error('[ThinkingCache] Background cache failed:', err)
  })
}

/**
 * Look up a cached thinking block for an assistant message.
 * Checks memory cache first (fast), then Redis (persistent).
 */
export async function getCachedThinkingBlock(
  content: string | ContentBlock[],
): Promise<ContentBlock | null> {
  const key = generateCacheKey(content)

  // Check memory cache first (fast path)
  const memoryCached = memoryCache.get(key)
  if (memoryCached) {
    console.log('[ThinkingCache] ✓ HIT (memory)')
    return memoryCached.thinkingBlock
  }

  // Check Redis (persistent storage)
  const redis = getRedis()
  if (redis) {
    try {
      const cached = await redis.get<string>(`${CACHE_KEY_PREFIX}${key}`)
      if (cached) {
        const parsed =
          typeof cached === 'string' ? (JSON.parse(cached) as CachedThinkingBlock) : null
        if (parsed?.thinkingBlock) {
          // Store in memory cache for faster subsequent access
          memoryCache.set(key, parsed)
          console.log('[ThinkingCache] ✓ HIT (Redis)')
          return parsed.thinkingBlock
        }
      }
    } catch (error) {
      console.error('[ThinkingCache] Redis read failed:', error)
    }
  }

  // Cache miss
  console.log('[ThinkingCache] ✗ MISS (thinking will be disabled for this turn)')
  return null
}

/**
 * Inject cached thinking blocks into conversation messages.
 * Modifies the messages array in place.
 * Returns the number of thinking blocks injected.
 */
export async function injectCachedThinkingBlocks(messages: AnthropicMessage[]): Promise<number> {
  let injectedCount = 0

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    // Check if this message already has a thinking block
    if (Array.isArray(msg.content)) {
      const hasThinking = msg.content.some(
        (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
      )

      if (hasThinking) {
        continue
      }

      // Try to find cached thinking block
      const cachedThinking = await getCachedThinkingBlock(msg.content)
      if (cachedThinking) {
        // Inject at the beginning (thinking must come first)
        msg.content = [cachedThinking, ...msg.content]
        injectedCount++
      }
    } else if (typeof msg.content === 'string') {
      // String content - try to find cached thinking block
      const cachedThinking = await getCachedThinkingBlock(msg.content)
      if (cachedThinking) {
        // Convert to array with thinking block first
        msg.content = [cachedThinking, { type: 'text' as const, text: msg.content }]
        injectedCount++
      }
    }
  }

  if (injectedCount > 0) {
    console.log(`[ThinkingCache] Injected ${injectedCount} cached thinking block(s)`)
  }

  return injectedCount
}

/**
 * Check if Redis storage is available
 */
export function isRedisAvailable(): boolean {
  return getRedis() !== null
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  memorySize: number
  redisAvailable: boolean
} {
  return {
    memorySize: memoryCache.size,
    redisAvailable: isRedisAvailable(),
  }
}

/**
 * Clear the memory cache (for testing)
 */
export function clearMemoryCache(): void {
  memoryCache.clear()
}
