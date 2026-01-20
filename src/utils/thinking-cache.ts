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
 * Normalize content for cache key generation.
 * Handles various content formats and normalizes for reliable matching.
 */
function normalizeContent(content: string | ContentBlock[]): string {
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
        // Normalize tool inputs by sorting keys for consistent hashing
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

  // Aggressive normalization for reliable matching:
  // 1. Collapse all whitespace (newlines, tabs, multiple spaces) to single space
  // 2. Trim leading/trailing whitespace
  // 3. Remove common escape sequences that might differ
  return textContent
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Generate a hash from normalized content.
 * Uses FNV-1a hash for better distribution than simple addition.
 */
function hashContent(content: string): number {
  // FNV-1a hash parameters (32-bit)
  const FNV_PRIME = 0x01000193
  const FNV_OFFSET = 0x811c9dc5

  let hash = FNV_OFFSET

  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }

  return hash >>> 0 // Convert to unsigned
}

/**
 * Generate a cache key from assistant message content.
 * Uses normalized content with FNV-1a hash for reliable matching.
 */
function generateCacheKey(content: string | ContentBlock[]): string {
  const normalized = normalizeContent(content)
  const hash = hashContent(normalized)

  // Include content length as additional discriminator
  const key = `v3:${hash}:${normalized.length}`
  debugLog('Generated key:', key, 'from content length:', normalized.length)

  return key
}

/**
 * Generate a short key for fallback matching (first N chars + length).
 * This helps when content has minor differences at the end.
 */
function generateShortKey(content: string | ContentBlock[]): string {
  const normalized = normalizeContent(content)
  // Use first 200 chars for short key (handles truncation)
  const shortContent = normalized.substring(0, 200)
  const hash = hashContent(shortContent)

  return `v3short:${hash}:${shortContent.length}`
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
 * Uses both full key and short key for better hit rate.
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
  const shortKey = generateShortKey(nonThinkingContent)
  const thinkingLen = thinkingBlock.thinking?.length || 0
  const sigLen = thinkingBlock.signature?.length || 0

  debugLog(`Caching thinking block: ${thinkingLen} chars, signature: ${sigLen} chars`)
  debugLog(`Keys: full=${key}, short=${shortKey}`)

  const cacheData: CachedThinkingBlock = {
    thinkingBlock,
    timestamp: Date.now(),
  }

  // Store in memory cache (both keys)
  cleanupMemoryCache()
  memoryCache.set(key, cacheData)
  memoryCache.set(shortKey, cacheData)

  // Store in Redis (persistent)
  const redis = getRedis()
  if (redis) {
    try {
      // Store with both keys for fallback matching
      await Promise.all([
        redis.set(`${CACHE_KEY_PREFIX}${key}`, JSON.stringify(cacheData), {
          ex: CACHE_TTL_SECONDS,
        }),
        redis.set(`${CACHE_KEY_PREFIX}${shortKey}`, JSON.stringify(cacheData), {
          ex: CACHE_TTL_SECONDS,
        }),
      ])
      console.log(`[ThinkingCache] Cached thinking block (${thinkingLen} chars)`)
    } catch (error) {
      console.error('[ThinkingCache] Redis write failed:', error)
    }
  } else {
    // Memory-only mode
    console.log(`[ThinkingCache] Cached in memory (${thinkingLen} chars) - no Redis configured`)
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
 * Uses fallback to short key if full key misses.
 */
export async function getCachedThinkingBlock(
  content: string | ContentBlock[],
): Promise<ContentBlock | null> {
  const key = generateCacheKey(content)
  const shortKey = generateShortKey(content)

  debugLog(`Looking up keys: full=${key}, short=${shortKey}`)

  // Check memory cache first (fast path) - try both keys
  const memoryCached = memoryCache.get(key) || memoryCache.get(shortKey)
  if (memoryCached) {
    console.log('[ThinkingCache] HIT (memory)')
    return memoryCached.thinkingBlock
  }

  // Check Redis (persistent storage)
  const redis = getRedis()
  if (redis) {
    try {
      // Try full key first, then short key as fallback
      let cached = await redis.get<string>(`${CACHE_KEY_PREFIX}${key}`)
      let hitType = 'full key'

      if (!cached) {
        cached = await redis.get<string>(`${CACHE_KEY_PREFIX}${shortKey}`)
        hitType = 'short key'
      }

      if (cached) {
        const parsed =
          typeof cached === 'string' ? (JSON.parse(cached) as CachedThinkingBlock) : null
        if (parsed?.thinkingBlock) {
          // Store in memory cache for faster subsequent access
          memoryCache.set(key, parsed)
          memoryCache.set(shortKey, parsed)
          console.log(`[ThinkingCache] HIT (Redis, ${hitType})`)
          return parsed.thinkingBlock
        }
      }
    } catch (error) {
      console.error('[ThinkingCache] Redis read failed:', error)
    }
  }

  // Cache miss
  console.log('[ThinkingCache] MISS (thinking will be disabled for this turn)')
  return null
}

/**
 * Result of injecting cached thinking blocks
 */
export interface InjectResult {
  injectedCount: number
  missingCount: number
  canUseThinking: boolean
}

/**
 * Inject cached thinking blocks into conversation messages.
 * Modifies the messages array in place.
 * 
 * Returns info about injection results including whether thinking can be enabled.
 * When thinking is enabled, ALL assistant messages must have thinking blocks.
 * If any are missing, thinking must be disabled for the request.
 */
export async function injectCachedThinkingBlocks(messages: AnthropicMessage[]): Promise<InjectResult> {
  let injectedCount = 0
  let missingCount = 0
  let totalAssistantMessages = 0

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    totalAssistantMessages++

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
      } else {
        missingCount++
      }
    } else if (typeof msg.content === 'string') {
      // String content - try to find cached thinking block
      const cachedThinking = await getCachedThinkingBlock(msg.content)
      if (cachedThinking) {
        // Convert to array with thinking block first
        msg.content = [cachedThinking, { type: 'text' as const, text: msg.content }]
        injectedCount++
      } else {
        missingCount++
      }
    }
  }

  if (injectedCount > 0) {
    console.log(`[ThinkingCache] Injected ${injectedCount} cached thinking block(s)`)
  }
  if (missingCount > 0) {
    console.log(`[ThinkingCache] Missing ${missingCount} thinking block(s) - thinking will be disabled`)
  }

  // Thinking can only be used if we have ALL thinking blocks
  // (or if there are no prior assistant messages)
  const canUseThinking = missingCount === 0

  return {
    injectedCount,
    missingCount,
    canUseThinking,
  }
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
