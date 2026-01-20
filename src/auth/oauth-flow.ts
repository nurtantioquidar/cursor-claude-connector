import crypto from 'crypto'
import * as authManager from './oauth-manager'

const CLIENT_ID =
  process.env.ANTHROPIC_OAUTH_CLIENT_ID ||
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'

interface PKCE {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

function generatePKCE(): PKCE {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url')

  return { verifier, challenge }
}

export function getAuthorizationUrl(pkce: PKCE): string {
  const authUrl = new URL('https://claude.ai/oauth/authorize')
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set(
    'scope',
    'org:create_api_key user:profile user:inference',
  )
  authUrl.searchParams.set('code_challenge', pkce.challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', pkce.verifier)

  return authUrl.toString()
}

async function startAuthFlow(): Promise<TokenResponse> {
  const pkce = generatePKCE()
  const authUrl = getAuthorizationUrl(pkce)

  console.log('\n[AUTH] OAuth Authentication Required')
  console.log('Please visit the following URL to authenticate:')
  console.log(`\n${authUrl}\n`)
  console.log('After authentication, you will get a code.')
  console.log('Please paste the entire code here and press Enter:\n')

  // Read code from stdin
  const code = await readCodeFromStdin()

  if (!code) {
    throw new Error('No code provided')
  }

  // Exchange code for tokens
  return await exchangeCodeForTokens(code, pkce.verifier)
}

async function readCodeFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let code = ''
    process.stdin.setEncoding('utf8')
    process.stdin.resume()

    process.stdin.on('data', (chunk) => {
      code += chunk
      if (code.includes('\n')) {
        process.stdin.pause()
        resolve(code.trim())
      }
    })
  })
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const splits = code.split('#')

  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1] || verifier,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange code: ${error}`)
  }

  const data = (await response.json()) as TokenResponse

  // Save tokens
  await authManager.set({
    type: 'oauth',
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  })

  console.log('[AUTH] OAuth tokens saved successfully')

  return data
}

// New function to generate auth URL and store PKCE verifier
export async function generateAuthSession(): Promise<{
  authUrl: string
  sessionId: string
}> {
  const pkce = generatePKCE()
  const authUrl = getAuthorizationUrl(pkce)

  // Store PKCE verifier temporarily (in production, use a proper session store)
  // For now, we'll use the verifier as the session ID
  const sessionId = pkce.verifier

  return { authUrl, sessionId }
}

// New function to handle OAuth callback
export async function handleOAuthCallback(
  code: string,
  sessionId: string,
): Promise<TokenResponse> {
  // In production, retrieve the verifier from session store
  // For now, we use the sessionId as the verifier
  const verifier = sessionId

  return await exchangeCodeForTokens(code, verifier)
}

export async function login(): Promise<boolean> {
  try {
    // Check if we already have valid credentials
    const existing = await authManager.get()
    if (existing && existing.access && existing.expires > Date.now()) {
      console.log('[AUTH] Valid OAuth credentials already exist')
      return true
    }

    // Start OAuth flow
    await startAuthFlow()
    return true
  } catch (error) {
    console.error('OAuth login failed:', error)
    return false
  }
}

export async function logout(): Promise<boolean> {
  try {
    await authManager.remove()
    console.log('[AUTH] OAuth credentials removed')
    return true
  } catch (error) {
    console.error('Logout failed:', error)
    return false
  }
}
