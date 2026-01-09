# 🚀 Cursor-Claude Connector

> **Maximize your Claude subscription**: Use Claude's full power in your favorite IDE (like Cursor)

## 🚀 Why use your Claude subscription in an IDE?

Get the best of both worlds by combining Claude's capabilities with a professional development environment:

### 💡 **Claude's Full Capabilities**

- Direct access to Claude's latest models and features
- No token limits from your Claude Max subscription
- Full context understanding without compression
- Handle large files and complex projects seamlessly
- **Extended Thinking support** with multi-turn caching

### 🛠️ **Professional IDE Experience**

- **Code-first interface**: Built specifically for development workflows
- **File management**: Navigate and edit multiple files effortlessly
- **Version control**: Full git integration and change tracking
- **Extensions & tools**: Access to your IDE's ecosystem

### 💰 **Maximize Your Investment**

- Already paying for Claude Max? Use it everywhere
- No additional API costs or usage limits
- One subscription, multiple environments
- Full value from your Claude subscription

### 🎯 **Perfect for Complex Projects**

- Maintain context across entire codebases
- Work with large files without restrictions
- Extended coding sessions without interruptions
- Professional development workflow

## ⚠️ **Important: Cursor Requirements**

> **Note**: Cursor requires at least the $20/month plan to use agent mode with custom API keys (BYOK - Bring Your Own Key). The free tier only supports basic completions.

## 🔧 How does this project work?

This proxy enables you to use your Claude Max subscription directly in IDEs that support OpenAI-compatible APIs:

- ✅ Your favorite IDE's interface and features
- ✅ Claude's full capabilities from your subscription
- ✅ No additional costs beyond your Claude Max subscription

### Architecture

```mermaid
graph LR
    A[Your IDE] -->|Requests| B[Proxy Server]
    B -->|Authenticated| C[Claude Fixed Subscription]
    C -->|Response| B
    B -->|Full Context| A
```

## 🚀 Quick Installation

### 🔥 One-Click Deploy to Vercel

Deploy instantly with Upstash Redis integration:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Maol-1997/cursor-claude-connector&env=API_KEY&envDescription=Custom%20optional%20key%20for%20enhanced%20security%20protection&envLink=https://github.com/Maol-1997/cursor-claude-connector%23api-key&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17)

<!-- The integration-ids parameter includes Upstash's official Vercel integration ID for automatic Redis setup -->

This will:

- ✅ Deploy the proxy to Vercel
- ✅ Automatically create an Upstash Redis database
- ✅ Configure all environment variables (including optional API_KEY)
- ✅ Get you running in under 2 minutes!

### 📖 Manual Setup Guide

For detailed instructions or alternative deployment methods, see our **[Deployment Guide](DEPLOYMENT.md)**.

### Local Development

1. **Clone the repository**

   ```bash
   git clone https://github.com/Maol-1997/cursor-claude-connector.git
   cd cursor-claude-connector
   ```

2. **Set up Upstash Redis**

   - Create a free Redis database at [Upstash Console](https://console.upstash.com/)
   - Copy your REST URL and REST Token
   - Copy `env.example` to `.env` and update with your values:

   ```bash
   cp env.example .env
   # Edit .env with your Upstash credentials
   ```

3. **Run the start script**

   ```bash
   ./start.sh
   ```

4. **Authenticate with Claude**

   - Open `http://localhost:9095/` in your browser
   - Follow the authentication process

5. **Configure Cursor**
   - Go to Settings → Models
   - Enable "Override OpenAI Base URL"
   - Enter: `http://localhost:9095/v1` (for local) or `https://your-app.vercel.app/v1` (for Vercel)
   - If you set an API_KEY during deployment, add it to your API key field in Cursor

## 🎉 Advantages of this solution

| Feature                 | Claude Web | Claude Code | **This Project**        |
| ----------------------- | ---------- | ----------- | ----------------------- |
| IDE Integration         | ❌         | ❌ Terminal | ✅ Full IDE             |
| File Management         | ❌         | ✅          | ✅ IDE Native           |
| Claude Max Usage Limits | ✅         | ✅          | ✅ No Additional Limits |
| Version Control         | ❌         | ⚠️          | ✅ Full Git Integration |
| Development Extensions  | ❌         | ❌          | ✅ IDE Ecosystem        |
| Extended Thinking       | ✅         | ✅          | ✅ Multi-turn Support   |
| Cost                    | Claude Max | Claude Max  | Claude Max Only         |

## 🔐 API Key (Optional)

You can optionally set an `API_KEY` environment variable for additional security:

- If set, Cursor must provide this key in the API key field
- Adds an extra layer of authentication to your proxy
- Useful when deploying to public URLs
- Leave empty to use without additional authentication

## 📊 Context Tracking & Visibility

The proxy now provides detailed visibility into what Cursor sends to Claude, including:

### Request Context Logging

Every request logs:
- **File references** extracted from context (paths, line ranges)
- **Estimated token counts** (system prompt, messages, total)
- **@ mentions** detected (files, folders, symbols)
- **Tool definitions** count

Example output:
```
📊 Context Summary:
   Messages: 5 | Tools: 12
   Estimated tokens: ~15,234 (system: 3,456, messages: 11,778)
   📁 Files referenced (3):
      - src/server.ts (lines 100-200)
      - src/utils/context-extractor.ts
      - package.json
   @ Mentions:
      Files: server.ts, config.ts
      Symbols: extractContext, formatLog
```

### Token Usage Tracking

After each response, the proxy logs actual token usage:
```
📈 Token Usage:
   Input: 15,234 | Output: 2,156 | Total: 17,390
   Cache: cache read: 12,000 | cache created: 3,234 | hit rate: 78%
```

This helps you understand:
- How much context Cursor is sending
- Which files are being included
- Cache efficiency for cost optimization

## 🧠 Extended Thinking Support

This proxy supports Claude's **Extended Thinking** feature, which enables deeper reasoning for complex tasks. The key challenge is that Anthropic's API requires cryptographic signatures in thinking blocks for multi-turn conversations, but Cursor strips these from conversation history.

### How It Works

The proxy implements a **Thinking Cache** that:

1. **Captures** thinking blocks (with cryptographic signatures) when Claude responds
2. **Stores** them in Upstash Redis (persistent) with content-based keys
3. **Re-injects** them into conversation history on subsequent turns
4. **Falls back** gracefully - if cache misses, thinking is disabled for that turn only

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `UPSTASH_REDIS_REST_URL` | (required) | Your Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | (required) | Your Upstash Redis REST token |
| `THINKING_CACHE_TTL_DAYS` | `10` | How long thinking blocks are cached |
| `DEBUG` | `false` | Enable verbose cache logging |

### Using Thinking-Enabled Models

To use Extended Thinking in Cursor:
1. Select a thinking-enabled model (e.g., `claude-opus-4-5` with thinking)
2. The proxy automatically handles thinking block caching
3. Multi-turn conversations maintain thinking context

> **Note**: Extended Thinking requires Upstash Redis to be configured. Without Redis, thinking blocks are cached in-memory only (won't persist across serverless invocations).

## 🛡️ Security

- Uses your existing Claude session for authentication
- Optional API key for additional security
- Local connection between Cursor and the proxy
- Open source code for auditing

## 🤝 Contributions

Contributions are welcome! If you find any issues or have suggestions, please open an issue or PR.

## 📄 License

MIT - Use this project however you want

---

**Note**: This project is not affiliated with Anthropic or Cursor. It's a community tool to improve the development experience.
