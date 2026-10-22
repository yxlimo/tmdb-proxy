const axios = require('axios');
const crypto = require('crypto');
const {
    isPrivateRequest,
    getSharedTtl,
    getLocalTtl,
    STALE_WHILE_REVALIDATE
} = require('./cache-policy.js');

// 上游 API 根地址（可用环境变量覆盖，便于自建镜像或本地测试）
function getUpstreamBase() {
    return (process.env.TMDB_API_BASE || 'https://api.themoviedb.org').replace(/\/+$/, '');
}

// 上游请求超时（毫秒）
function getTimeout() {
    return Number(process.env.TMDB_TIMEOUT_MS || 15000);
}

// 进程内缓存 TTL 的上限：即便策略给出更长的 TTL，
// 实例内存里的条目也只保留一小段时间（实例随时可能被回收，且内存有限）。
function getLocalCacheTtlCap() {
    return Number(process.env.TMDB_LOCAL_CACHE_TTL_CAP_MS || 30 * 60 * 1000);
}

// 最大缓存条目数
function getMaxCacheSize() {
    return Number(process.env.TMDB_CACHE_MAX_SIZE || 1000);
}

// 服务端凭据：v4 read access token 优先于 v3 api key
function getServerToken() {
    return process.env.TMDB_BEARER_TOKEN || '';
}

function getServerKey() {
    return process.env.TMDB_API_KEY || '';
}

// 创建缓存对象
const cache = new Map();

// 只缓存这些方法的成功响应
const CACHEABLE_METHODS = new Set(['GET', 'HEAD']);

// 允许代理的方法
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// 缓存键需要区分凭据：v4 的 /4/account/... 属于用户私有数据，
// 不同的 Authorization 必须互相隔离，否则会把 A 用户的收藏返回给 B 用户
function fingerprint(value) {
    if (!value) return '-';
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// 清理过期条目并限制缓存大小（Map 保持插入顺序，最早插入的先淘汰）
function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now >= entry.expiry) {
            cache.delete(key);
        }
    }
    while (cache.size > getMaxCacheSize()) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
}

// 把请求体转成可转发的形式
function normalizeBody(body) {
    if (body === undefined || body === null) return undefined;
    if (Buffer.isBuffer(body)) return body.length ? body : undefined;
    if (typeof body === 'string') return body.length ? body : undefined;
    return body; // 对象交给 axios 自行序列化
}

/**
 * 设置缓存相关的响应头。
 *
 * Vercel 的缓存头优先级：
 *   Vercel-CDN-Cache-Control > CDN-Cache-Control > Cache-Control
 * 三个都设上，前两个分别控制 Vercel 边缘缓存和下游 CDN，
 * Cache-Control 只用于告诉浏览器端可以短暂复用。
 *
 * 注意：本地缓存命中时也必须调用本函数，
 * 否则边缘拿到的响应没有 s-maxage，这份内容就永远进不了边缘缓存。
 */
function applyCacheHeaders(res, { pathname, method, status, isV4, isPrivate }) {
    const sharedTtl = getSharedTtl(pathname, method, status, isV4, isPrivate);
    if (sharedTtl > 0) {
        res.setHeader(
            'Vercel-CDN-Cache-Control',
            `public, s-maxage=${sharedTtl}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`
        );
        res.setHeader('CDN-Cache-Control', `public, s-maxage=${sharedTtl}`);
        // 浏览器端缓存时间压得很短：客户端（Emby 等）自己管缓存，
        // 我们只负责让 Vercel 边缘缓存住内容。
        res.setHeader('Cache-Control', 'public, max-age=60');
    } else {
        // 私有数据与错误响应：明确禁止任何中间缓存
        res.setHeader('Cache-Control', 'private, no-store');
    }
}

module.exports = async (req, res) => {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Accept-Language');
    res.setHeader('Access-Control-Max-Age', '86400');

    // 处理 OPTIONS 请求
    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    const method = (req.method || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 405;
        res.end(JSON.stringify({ error: `Method ${method} not allowed` }));
        return;
    }

    // 解析请求路径与查询参数
    let parsed;
    try {
        parsed = new URL(req.url || '/', 'http://localhost');
    } catch (err) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Bad request URL' }));
        return;
    }
    const pathname = parsed.pathname;

    // 根路径：返回服务说明，避免直接透传到上游得到难懂的错误
    if (pathname === '/' || pathname === '') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        res.end(JSON.stringify({
            service: 'tmdb-proxy',
            endpoints: {
                api: '/{3|4}/...',
                image: '/t/{w|o|l|r|p}/{size}{poster_path}',
                health: '/health'
            }
        }));
        return;
    }

    // 健康检查
    if (pathname === '/health') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        res.end(JSON.stringify({
            status: 'ok',
            upstream: getUpstreamBase(),
            // 回显 Vercel 注入的地理位置头。
            // 配置 WAF 的 geo 条件时，需要用这里的实际取值
            // （Vercel 的城市名可能与预期不同，不要靠猜）。
            geo: {
                city: req.headers['x-vercel-ip-city'] || null,
                country: req.headers['x-vercel-ip-country'] || null,
                countryRegion: req.headers['x-vercel-ip-country-region'] || null,
                continent: req.headers['x-vercel-ip-continent'] || null,
                asNumber: req.headers['x-vercel-ip-as-number'] || null
            },
            cacheEntries: cache.size,
            timestamp: new Date().toISOString()
        }));
        return;
    }

    // 服务端凭据优先：配置了就不需要调用方带 key
    const query = new URLSearchParams(parsed.search);
    const clientAuth = req.headers.authorization || '';
    const serverToken = getServerToken();
    const serverKey = getServerKey();
    let effectiveAuth = clientAuth;

    if (serverToken) {
        effectiveAuth = `Bearer ${serverToken}`;
        query.delete('api_key');
    } else if (serverKey) {
        query.delete('api_key');
        query.set('api_key', serverKey);
    }

    const upstreamPath = pathname + (query.toString() ? `?${query.toString()}` : '');
    const tmdbUrl = `${getUpstreamBase()}${upstreamPath}`;

    // 该请求是否包含用户私有数据（v4 account / watchlist / favorite / rating，
    // 以及 v3 用 session_id 附加的用户状态）
    const isPrivate = isPrivateRequest(pathname, query);
    const isV4 = pathname.startsWith('/4/');

    // 缓存键：方法 + 路径 + 去掉 api_key 的查询串 + 凭据指纹
    //  - 去掉 api_key：v3 公共数据的响应与 key 无关（账号类路径已按私有排除），
    //    这样服务端注入 key 后所有调用方共享同一份缓存，key 也不会出现在键里。
    //  - 凭据指纹必须参与，否则会把 A 用户的收藏返回给 B 用户。
    const cacheQuery = new URLSearchParams(query);
    cacheQuery.delete('api_key');
    const credentialFingerprint = fingerprint(effectiveAuth || query.get('api_key') || '');
    const cacheKey = [
        method,
        pathname,
        cacheQuery.toString(),
        credentialFingerprint
    ].join('|');

    // 检查进程内缓存
    if (CACHEABLE_METHODS.has(method) && cache.has(cacheKey)) {
        const cachedData = cache.get(cacheKey);
        if (Date.now() < cachedData.expiry) {
            console.log('Cache hit:', upstreamPath);
            res.setHeader('Content-Type', cachedData.contentType);
            res.setHeader('X-Cache-Local', 'HIT');
            // 本地命中同样要让边缘能缓存这份内容
            applyCacheHeaders(res, {
                pathname,
                method,
                status: cachedData.status,
                isV4,
                isPrivate
            });
            res.statusCode = cachedData.status;
            res.end(cachedData.body);
            return;
        }
        cache.delete(cacheKey);
    }

    // 构建请求配置
    const config = {
        method: method === 'HEAD' ? 'get' : method.toLowerCase(),
        timeout: getTimeout(),
        responseType: 'arraybuffer',
        validateStatus: () => true,
        headers: {}
    };

    if (effectiveAuth) {
        config.headers['Authorization'] = effectiveAuth;
    }
    if (req.headers['accept-language']) {
        config.headers['Accept-Language'] = req.headers['accept-language'];
    }

    const body = normalizeBody(req.body);
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        config.data = body;
        if (req.headers['content-type']) {
            config.headers['Content-Type'] = req.headers['content-type'];
        }
    }

    try {
        // 发送请求到 TMDB
        const response = await axios.request(tmdbUrl, config);

        const status = response.status;
        const contentType = response.headers['content-type'] || 'application/json; charset=utf-8';
        const responseBody = Buffer.isBuffer(response.data)
            ? response.data
            : Buffer.from(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));

        // 进程内缓存：只缓存成功响应，TTL 按数据类别
        const localTtl = getLocalTtl(pathname, method, status, isPrivate);
        if (localTtl > 0) {
            pruneCache();
            cache.set(cacheKey, {
                status,
                contentType,
                body: responseBody,
                expiry: Date.now() + Math.min(localTtl * 1000, getLocalCacheTtlCap())
            });
            console.log('Cache miss and stored:', upstreamPath);
        } else if (status !== 200) {
            console.log('Response not cached due to non-200 status:', status, upstreamPath);
        }

        // 原样透传状态码与响应体（TMDB 客户端依赖 status_code / status_message 字段）
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Cache-Local', 'MISS');

        // 共享 CDN 缓存：只有 v3 公共接口能进。
        // 命中时请求根本不进函数，直接由最近的 PoP 返回，国内延迟最低。
        applyCacheHeaders(res, { pathname, method, status, isV4, isPrivate });

        res.statusCode = status;
        res.end(responseBody);
    } catch (error) {
        console.error('TMDB API error:', error && error.message);
        const isTimeout = error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = isTimeout ? 504 : 502;
        res.end(JSON.stringify({
            status_code: isTimeout ? 34 : 11,
            status_message: isTimeout ? 'Upstream request timed out' : 'Upstream request failed',
            success: false,
            error: error && error.message
        }));
    }
};
