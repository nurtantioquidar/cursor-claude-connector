import { Redis } from '@upstash/redis'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface OAuthCredentials {
    type: 'oauth'
    refresh: string
    access: string
    expires: number
}

export interface AuthData {
    [provider: string]: OAuthCredentials
}

export interface Storage {
    get(key: string): Promise<OAuthCredentials | null>
    set(key: string, value: OAuthCredentials): Promise<void>
    remove(key: string): Promise<void>
    getAll(key: string): Promise<AuthData>
}

export class RedisStorage implements Storage {
    private redis: Redis

    constructor(url: string, token: string) {
        this.redis = new Redis({ url, token })
    }

    async get(key: string): Promise<OAuthCredentials | null> {
        return await this.redis.get<OAuthCredentials>(key)
    }

    async set(key: string, value: OAuthCredentials): Promise<void> {
        await this.redis.set(key, value)
    }

    async remove(key: string): Promise<void> {
        await this.redis.del(key)
    }

    async getAll(key: string): Promise<AuthData> {
        const credentials = await this.get(key)
        if (credentials) {
            return { anthropic: credentials }
        }
        return {}
    }
}

export class FileStorage implements Storage {
    private filePath: string

    constructor() {
        this.filePath = join(process.cwd(), '.auth_data.json')
    }

    async get(key: string): Promise<OAuthCredentials | null> {
        if (!existsSync(this.filePath)) return null
        try {
            const data = await readFile(this.filePath, 'utf-8')
            const json = JSON.parse(data)
            return json[key] || null
        } catch (error) {
            console.error('Error reading from file storage:', error)
            return null
        }
    }

    async set(key: string, value: OAuthCredentials): Promise<void> {
        try {
            let json: any = {}
            if (existsSync(this.filePath)) {
                const data = await readFile(this.filePath, 'utf-8')
                json = JSON.parse(data)
            }
            json[key] = value
            await writeFile(this.filePath, JSON.stringify(json, null, 2))
        } catch (error) {
            console.error('Error writing to file storage:', error)
            throw error
        }
    }

    async remove(key: string): Promise<void> {
        try {
            if (!existsSync(this.filePath)) return
            const data = await readFile(this.filePath, 'utf-8')
            const json = JSON.parse(data)
            delete json[key]
            await writeFile(this.filePath, JSON.stringify(json, null, 2))
        } catch (error) {
            console.error('Error removing from file storage:', error)
            throw error
        }
    }

    async getAll(key: string): Promise<AuthData> {
        const credentials = await this.get(key)
        if (credentials) {
            return { anthropic: credentials }
        }
        return {}
    }
}

export function getStorage(): Storage {
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (url && token && url !== 'https://your-redis-instance.upstash.io' && token !== 'your-redis-rest-token') {
        console.log('✅ Using Upstash Redis for storage')
        return new RedisStorage(url, token)
    }

    console.log('⚠️ Using local file storage for auth data (fallback)')
    return new FileStorage()
}
