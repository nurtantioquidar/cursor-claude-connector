/**
 * Context Extractor for Cursor IDE Integration
 * 
 * Extracts and analyzes context information from Cursor requests to provide
 * better visibility into what files and data are being sent to the API.
 * 
 * Cursor embeds context in the message content itself, including:
 * - File contents with path references
 * - Code snippets with line numbers
 * - @ mentions (files, symbols, folders)
 * - System prompts with tool definitions
 */

export interface FileContext {
  path: string
  lineCount?: number
  lineRange?: { start: number; end: number }
  type: 'full' | 'partial' | 'reference'
}

export interface ContextSummary {
  files: FileContext[]
  totalFiles: number
  estimatedTokens: {
    system: number
    messages: number
    total: number
  }
  hasTools: boolean
  toolCount: number
  messageCount: number
  systemPromptLength: number
  // @ mentions detected
  mentions: {
    files: string[]
    folders: string[]
    symbols: string[]
  }
}

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cacheHitRate?: number
}

// Rough token estimation (4 chars ~= 1 token for English text)
const CHARS_PER_TOKEN = 4

/**
 * Extract file references from content using common patterns
 */
function extractFileReferences(content: string): FileContext[] {
  const files: FileContext[] = []
  const seenPaths = new Set<string>()

  // Pattern 1: Explicit file path references like `/path/to/file.ts`
  // Common in Cursor's context format: "File: /path/to/file.ts" or just paths
  const pathPatterns = [
    // Unix-style absolute paths
    /(?:^|\s|["'`])(\/?(?:[\w.-]+\/)+[\w.-]+\.\w+)(?:["'`]|\s|$|:|\()/gm,
    // File references with labels
    /(?:File|Path|Source|Reference):\s*[`"']?([^\s`"'\n]+\.\w+)[`"']?/gi,
    // Line number references like "file.ts:123" or "file.ts (lines 1-50)"
    /([^\s`"'\n]+\.\w+)(?::(\d+)(?:-(\d+))?|\s*\(lines?\s*(\d+)(?:-(\d+))?\))/gi,
  ]

  for (const pattern of pathPatterns) {
    let match
    while ((match = pattern.exec(content)) !== null) {
      const path = match[1]
      if (path && !seenPaths.has(path) && isValidFilePath(path)) {
        seenPaths.add(path)
        
        // Check for line range
        const startLine = match[2] || match[4]
        const endLine = match[3] || match[5]
        
        const fileContext: FileContext = {
          path,
          type: startLine ? 'partial' : 'full',
        }
        
        if (startLine) {
          fileContext.lineRange = {
            start: parseInt(startLine, 10),
            end: endLine ? parseInt(endLine, 10) : parseInt(startLine, 10),
          }
        }
        
        files.push(fileContext)
      }
    }
  }

  // Pattern 2: Code blocks with file indicators
  // ```typescript:src/file.ts or ```ts // src/file.ts
  const codeBlockPattern = /```\w*(?::([^\s\n]+)|[^\n]*\/\/\s*([^\n]+))/g
  let match
  while ((match = codeBlockPattern.exec(content)) !== null) {
    const path = match[1] || match[2]
    if (path && !seenPaths.has(path) && isValidFilePath(path.trim())) {
      seenPaths.add(path.trim())
      files.push({
        path: path.trim(),
        type: 'partial',
      })
    }
  }

  return files
}

/**
 * Check if a string looks like a valid file path
 */
function isValidFilePath(path: string): boolean {
  // Must have an extension
  if (!/\.\w+$/.test(path)) return false
  
  // Filter out common false positives
  const falsePositives = [
    /^https?:\/\//i,
    /^www\./i,
    /^@/,
    /^\d+\.\d+\.\d+/, // version numbers
    /^node_modules/,
    /^\.git/,
  ]
  
  for (const pattern of falsePositives) {
    if (pattern.test(path)) return false
  }
  
  // Common code file extensions
  const codeExtensions = /\.(ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|php|vue|svelte|astro|md|json|yaml|yml|toml|xml|html|css|scss|sass|less|sql|sh|bash|zsh|fish|ps1|bat|cmd)$/i
  return codeExtensions.test(path)
}

/**
 * Extract @ mentions from content
 */
function extractMentions(content: string): ContextSummary['mentions'] {
  const mentions: ContextSummary['mentions'] = {
    files: [],
    folders: [],
    symbols: [],
  }

  // @file mentions
  const fileMentionPattern = /@([^\s@]+\.\w+)/g
  let match
  while ((match = fileMentionPattern.exec(content)) !== null) {
    if (isValidFilePath(match[1])) {
      mentions.files.push(match[1])
    }
  }

  // @folder/ mentions (ends with /)
  const folderMentionPattern = /@([^\s@]+\/)/g
  while ((match = folderMentionPattern.exec(content)) !== null) {
    mentions.folders.push(match[1])
  }

  // @symbol mentions (PascalCase or camelCase identifiers)
  const symbolMentionPattern = /@([A-Z][a-zA-Z0-9]+|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)/g
  while ((match = symbolMentionPattern.exec(content)) !== null) {
    // Filter out common words that might be capitalized
    const symbol = match[1]
    if (!['The', 'This', 'That', 'What', 'How', 'Why', 'When', 'Where'].includes(symbol)) {
      mentions.symbols.push(symbol)
    }
  }

  return mentions
}

/**
 * Estimate token count from text
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Extract context summary from an Anthropic request body
 */
export function extractContext(body: {
  system?: string | Array<{ type: string; text?: string }>
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
  tools?: Array<unknown>
  model?: string
}): ContextSummary {
  const files: FileContext[] = []
  const seenPaths = new Set<string>()
  let systemTokens = 0
  let messageTokens = 0
  const allMentions: ContextSummary['mentions'] = {
    files: [],
    folders: [],
    symbols: [],
  }

  // Process system prompt
  let systemText = ''
  if (body.system) {
    if (typeof body.system === 'string') {
      systemText = body.system
    } else if (Array.isArray(body.system)) {
      systemText = body.system
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n')
    }
    systemTokens = estimateTokens(systemText)
    
    // Extract file references from system prompt
    const systemFiles = extractFileReferences(systemText)
    for (const file of systemFiles) {
      if (!seenPaths.has(file.path)) {
        seenPaths.add(file.path)
        files.push(file)
      }
    }
    
    // Extract mentions from system
    const systemMentions = extractMentions(systemText)
    allMentions.files.push(...systemMentions.files)
    allMentions.folders.push(...systemMentions.folders)
    allMentions.symbols.push(...systemMentions.symbols)
  }

  // Process messages
  if (body.messages) {
    for (const msg of body.messages) {
      let msgText = ''
      
      if (typeof msg.content === 'string') {
        msgText = msg.content
      } else if (Array.isArray(msg.content)) {
        msgText = msg.content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
      }
      
      messageTokens += estimateTokens(msgText)
      
      // Extract file references from message
      const msgFiles = extractFileReferences(msgText)
      for (const file of msgFiles) {
        if (!seenPaths.has(file.path)) {
          seenPaths.add(file.path)
          files.push(file)
        }
      }
      
      // Extract mentions from user messages
      if (msg.role === 'user') {
        const msgMentions = extractMentions(msgText)
        allMentions.files.push(...msgMentions.files)
        allMentions.folders.push(...msgMentions.folders)
        allMentions.symbols.push(...msgMentions.symbols)
      }
    }
  }

  // Deduplicate mentions
  allMentions.files = [...new Set(allMentions.files)]
  allMentions.folders = [...new Set(allMentions.folders)]
  allMentions.symbols = [...new Set(allMentions.symbols)]

  return {
    files,
    totalFiles: files.length,
    estimatedTokens: {
      system: systemTokens,
      messages: messageTokens,
      total: systemTokens + messageTokens,
    },
    hasTools: !!body.tools && body.tools.length > 0,
    toolCount: body.tools?.length || 0,
    messageCount: body.messages?.length || 0,
    systemPromptLength: systemText.length,
    mentions: allMentions,
  }
}

/**
 * Extract usage information from an Anthropic response
 */
export function extractUsage(response: {
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}): UsageInfo | null {
  if (!response.usage) return null

  const inputTokens = response.usage.input_tokens || 0
  const outputTokens = response.usage.output_tokens || 0
  const cacheCreationTokens = response.usage.cache_creation_input_tokens || 0
  const cacheReadTokens = response.usage.cache_read_input_tokens || 0

  // Calculate cache hit rate
  let cacheHitRate: number | undefined
  if (inputTokens > 0 && cacheReadTokens > 0) {
    cacheHitRate = Math.round((cacheReadTokens / inputTokens) * 100)
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheCreationTokens: cacheCreationTokens || undefined,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheHitRate,
  }
}

/**
 * Format context summary for logging
 */
export function formatContextLog(context: ContextSummary): string {
  const lines: string[] = []

  lines.push(`📊 Context Summary:`)
  lines.push(`   Messages: ${context.messageCount} | Tools: ${context.toolCount}`)
  lines.push(`   Estimated tokens: ~${context.estimatedTokens.total.toLocaleString()} (system: ${context.estimatedTokens.system.toLocaleString()}, messages: ${context.estimatedTokens.messages.toLocaleString()})`)

  if (context.files.length > 0) {
    lines.push(`   📁 Files referenced (${context.files.length}):`)
    // Show first 10 files
    const displayFiles = context.files.slice(0, 10)
    for (const file of displayFiles) {
      const rangeStr = file.lineRange 
        ? ` (lines ${file.lineRange.start}-${file.lineRange.end})`
        : ''
      lines.push(`      - ${file.path}${rangeStr}`)
    }
    if (context.files.length > 10) {
      lines.push(`      ... and ${context.files.length - 10} more`)
    }
  }

  const totalMentions = context.mentions.files.length + context.mentions.folders.length + context.mentions.symbols.length
  if (totalMentions > 0) {
    lines.push(`   @ Mentions:`)
    if (context.mentions.files.length > 0) {
      lines.push(`      Files: ${context.mentions.files.slice(0, 5).join(', ')}${context.mentions.files.length > 5 ? '...' : ''}`)
    }
    if (context.mentions.folders.length > 0) {
      lines.push(`      Folders: ${context.mentions.folders.slice(0, 5).join(', ')}${context.mentions.folders.length > 5 ? '...' : ''}`)
    }
    if (context.mentions.symbols.length > 0) {
      lines.push(`      Symbols: ${context.mentions.symbols.slice(0, 5).join(', ')}${context.mentions.symbols.length > 5 ? '...' : ''}`)
    }
  }

  return lines.join('\n')
}

/**
 * Format usage info for logging
 */
export function formatUsageLog(usage: UsageInfo): string {
  const lines: string[] = []

  lines.push(`📈 Token Usage:`)
  lines.push(`   Input: ${usage.inputTokens.toLocaleString()} | Output: ${usage.outputTokens.toLocaleString()} | Total: ${usage.totalTokens.toLocaleString()}`)

  if (usage.cacheReadTokens || usage.cacheCreationTokens) {
    const cacheInfo: string[] = []
    if (usage.cacheReadTokens) {
      cacheInfo.push(`cache read: ${usage.cacheReadTokens.toLocaleString()}`)
    }
    if (usage.cacheCreationTokens) {
      cacheInfo.push(`cache created: ${usage.cacheCreationTokens.toLocaleString()}`)
    }
    if (usage.cacheHitRate !== undefined) {
      cacheInfo.push(`hit rate: ${usage.cacheHitRate}%`)
    }
    lines.push(`   Cache: ${cacheInfo.join(' | ')}`)
  }

  return lines.join('\n')
}
