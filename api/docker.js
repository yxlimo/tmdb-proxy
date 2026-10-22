const axios = require('axios');
const {
    parseRegistryPath,
    normalizeAccept,
    isDigestReference,
    isCacheableStatus
} = require('./docker-registry.js');

// Docker Hub 上游
function getRegistryBase() {
    return (process.env.DOCKER_REGISTRY_BASE || 'https://registry-1.docker.io').replace(/\/+$/, '');
}

function getAuthBase() {
    return (process.env.DOCKER_AUTH_BASE || 'https://auth.docker.io').replace(/\/+$/, '');
}

// 上游请求超时（毫秒）
function getTimeout() {
    return Number(process.env.DOCKER_TIMEOUT_MS || 15000);
}

// 进程内缓存条目上限
function getMaxCacheSize() {
    return Number(process.env.DOCKER_CACHE_MAX_SIZE || 500);
}

// manifest 缓存时长：digest 内容寻址，永久有效；tag 可能被重新指向，缓存时间短
function getManifestTtl(reference) {
    if (isDigestReference(reference)) {
        return Number(process.env.DOCKER_MANIFEST_TTL_DIGEST_MS || 24 * 3600 * 1000);
    }
    return Number(process.env.DOCKER_MANIFEST_TTL_TAG_MS || 5 * 60 * 1000);
}

// 服务端 Docker Hub 凭据：username + personal access token。
//
// 配了之后由代理代为换取令牌，客户端无需 docker login。
// 配额归属从「出口 IP」变成「账号」——实测匿名上限 100 次/6 小时且按源 IP 计，
// 而共享出口 IP 的配额会被其他 Vercel 租户消耗；账号级上限是 200 次/6 小时。
// 代价是：能访问该账号的私有仓库，等于把私有仓库开放给所有能访问代理的人。
// 代理务必配合访问控制（Vercel WAF IP 白名单）使用。
function getServerCredentials() {
    const token = process.env.DOCKERHUB_TOKEN || '';
    const username = process.env.DOCKERHUB_USERNAME || '';
    if (!token || !username) return null;
    return { username, token };
}

// blob 的处理方式：
//   redirect（默认）——把上游的 307 跳转原样交给客户端，客户端直连 CDN。
//       省 Vercel 流量，但 production.cloudfront.docker.com 在国内的 TLS 握手
//       有约 43% 的概率被拦截（实测 30 次采样 13 次成功），依赖客户端重试。
//   proxy——代理自己跟随跳转并流式转发。可靠性更高，代价是占用 Vercel 流量
//       （Hobby 每月 100GB），且需要用流式响应绕开 4.5MB 响应体上限。
function getBlobMode() {
    return process.env.DOCKER_BLOB_MODE === 'proxy' ? 'proxy' : 'redirect';
}

const manifestCache = new Map();
const tokenCache = new Map();

// 清理过期条目并限制缓存大小（Map 保持插入顺序，最早插入的先淘汰）
function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of manifestCache) {
        if (now >= entry.expiry) manifestCache.delete(key);
    }
    while (manifestCache.size > getMaxCacheSize()) {
        const oldestKey = manifestCache.keys().next().value;
        if (oldestKey === undefined) break;
        manifestCache.delete(oldestKey);
    }
}

/**
 * 换取上游访问令牌。
 *
 * 令牌按 scope 缓存：上游签发的令牌有效期为 300 秒（expires_in），
 * 缓存到接近过期才重新换取，避免每次请求都打一次 auth.docker.io。
 */
async function fetchToken(scope, { force = false } = {}) {
    if (!force && tokenCache.has(scope)) {
        const entry = tokenCache.get(scope);
        if (Date.now() < entry.expiry) return entry.token;
        tokenCache.delete(scope);
    }

    const credentials = getServerCredentials();
    const headers = { 'user-agent': 'tmdb-proxy-docker/1.0' };

    if (credentials) {
        headers.authorization =
            'Basic ' + Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64');
    }

    const url = `${getAuthBase()}/token?service=registry.docker.io&scope=${encodeURIComponent(scope)}`;
    const response = await axios.get(url, { headers, timeout: getTimeout(), validateStatus: () => true });

    if (response.status !== 200 || !response.data || !response.data.token) {
        if (credentials) {
            // 凭据失效时退回匿名，避免整个代理不可用
            console.warn('Docker Hub token exchange failed, falling back to anonymous');
            const anonymous = await axios.get(url, {
                headers: { 'user-agent': 'tmdb-proxy-docker/1.0' },
                timeout: getTimeout(),
                validateStatus: () => true
            });
            if (anonymous.status === 200 && anonymous.data && anonymous.data.token) {
                return anonymous.data.token;
            }
        }
        return null;
    }

    // 提前 30 秒过期，避免边界情况拿到已失效的令牌
    const ttl = Math.max((Number(response.data.expires_in) || 300) - 30, 30) * 1000;
    tokenCache.set(scope, { token: response.data.token, expiry: Date.now() + ttl });
    return response.data.token;
}

/**
 * 流式转发 blob 内容。
 *
 * blob 普遍在几十 MB，Vercel 函数的响应体上限是 4.5MB（非流式），
 * 所以必须边收边发。同时要透传 Range 相关的头，支持断点续传。
 */
async function streamBlob(location, req, res) {
    const headers = { 'user-agent': 'tmdb-proxy-docker/1.0' };
    // 客户端的 Range 请求要原样传给 CDN，否则断点续传失效
    if (req.headers.range) headers.range = req.headers.range;

    const upstream = await axios.get(location, {
        headers,
        responseType: 'stream',
        timeout: getTimeout(),
        validateStatus: () => true
    });

    // 透传 CDN 响应头：Content-Length / Content-Range / Accept-Ranges 等
    const passthrough = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'docker-content-digest',
        'last-modified'
    ];
    for (const name of passthrough) {
        const value = upstream.headers[name];
        if (value !== undefined && value !== null) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'no-store');

    res.statusCode = upstream.status;

    // 边收边发，避免把整个 blob 读进内存。
    // 不用 pipe：pipe 要求目标实现完整的 EventEmitter 接口，
    // 而 Vercel 的 res 与测试 mock 的接口并不一致。
    await new Promise((resolve, reject) => {
        upstream.data.on('error', reject);
        upstream.data.on('data', (chunk) => {
            res.write(chunk);
        });
        upstream.data.on('end', () => {
            res.end();
            resolve();
        });
    });
}

/**
 * 透传上游响应头。
 *
 * 保留 Docker 客户端依赖的字段：ratelimit-*（客户端据此提示限速）、
 * docker-content-digest（完整性校验）、docker-distribution-api-version。
 */
function copyUpstreamHeaders(upstreamHeaders, res) {
    const passthrough = [
        'content-type',
        'docker-content-digest',
        'docker-distribution-api-version',
        'etag',
        'ratelimit-limit',
        'ratelimit-remaining',
        'ratelimit-reset',
        'docker-ratelimit-source',
        'last-modified'
    ];
    for (const name of passthrough) {
        const value = upstreamHeaders[name];
        if (value !== undefined && value !== null) res.setHeader(name, value);
    }
}

module.exports = async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();

    if (!['GET', 'HEAD'].includes(method)) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 405;
        res.end(JSON.stringify({ errors: [{ code: 'UNSUPPORTED', message: `Method ${method} not allowed` }] }));
        return;
    }

    let parsed;
    try {
        parsed = new URL(req.url || '/', 'http://localhost');
    } catch (err) {
        res.statusCode = 400;
        res.end();
        return;
    }

    const pathname = parsed.pathname;

    // 健康检查
    if (pathname === '/docker-health') {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({
            status: 'ok',
            registry: getRegistryBase(),
            authenticated: !!getServerCredentials(),
            manifestCacheEntries: manifestCache.size,
            tokenCacheEntries: tokenCache.size
        }));
        return;
    }

    // /v2/ 探测端点：返回 200，客户端就不会再向 auth.docker.io 换令牌，
    // 令牌由代理在服务端自行获取（客户端无需 docker login）。
    if (pathname === '/v2/' || pathname === '/v2') {
        res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end('{}');
        return;
    }

    const resource = parseRegistryPath(pathname);
    if (!resource) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 404;
        res.end(JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'Unknown registry path' }] }));
        return;
    }

    const { kind, name, reference, scope } = resource;
    const accept = normalizeAccept(req.headers.accept);

    // manifest 缓存：digest 引用内容不变可长期缓存；tag 缓存时间短。
    // 缓存键含 Accept——同一 URL 在不同 Accept 下返回不同内容。
    const cacheKey = `${kind}|${name}|${reference}|${accept}`;

    if (kind === 'manifests' && manifestCache.has(cacheKey)) {
        const entry = manifestCache.get(cacheKey);
        if (Date.now() < entry.expiry) {
            res.setHeader('Content-Type', entry.contentType);
            if (entry.digest) res.setHeader('Docker-Content-Digest', entry.digest);
            res.setHeader('X-Cache-Local', 'HIT');
            res.statusCode = entry.status;
            res.end(entry.body);
            return;
        }
        manifestCache.delete(cacheKey);
    }

    const headers = { 'user-agent': 'tmdb-proxy-docker/1.0' };
    if (accept) headers.accept = accept;

    const upstreamUrl = `${getRegistryBase()}${pathname}`;

    const request = async (token) => {
        const requestHeaders = { ...headers };
        if (token) requestHeaders.authorization = `Bearer ${token}`;
        return axios.request(upstreamUrl, {
            method: method.toLowerCase(),
            headers: requestHeaders,
            timeout: getTimeout(),
            responseType: 'arraybuffer',
            validateStatus: () => true,
            // blob 的 307 跳转要自己处理，不能让 axios 跟随
            maxRedirects: 0
        });
    };

    try {
        let token = await fetchToken(scope);
        let response = await request(token);

        // 令牌失效时上游返回 401，强制换一次令牌重试
        if (response.status === 401 && token) {
            token = await fetchToken(scope, { force: true });
            response = await request(token);
        }

        const status = response.status;

        // blob：上游返回 307 + Location（指向 cloudfront 的签名 URL）。
        //
        // redirect 模式：把跳转原样交给客户端，让它直连 CDN 下载。
        //     blob 体积大，走代理会吃掉 Vercel 流量额度。
        //     签名 URL 有效期约 50 分钟且每次签名不同，所以不能缓存这个响应。
        //
        // proxy 模式：代理自己跟随跳转并流式转发。客户端只与代理通信，
        //     避开国内对 cloudfront 的 TLS 拦截；代价是占用 Vercel 流量。
        if (kind === 'blobs' && (status === 307 || status === 302) && response.headers.location) {
            if (getBlobMode() === 'proxy') {
                await streamBlob(response.headers.location, req, res);
                return;
            }

            res.setHeader('Location', response.headers.location);
            if (response.headers['docker-content-digest']) {
                res.setHeader('Docker-Content-Digest', response.headers['docker-content-digest']);
            }
            res.setHeader('Cache-Control', 'no-store');
            res.statusCode = 307;
            res.end();
            return;
        }

        copyUpstreamHeaders(response.headers, res);
        res.setHeader('X-Cache-Local', 'MISS');

        const body = Buffer.isBuffer(response.data)
            ? response.data
            : Buffer.from(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));

        if (kind === 'manifests' && isCacheableStatus(status) && method === 'GET') {
            pruneCache();
            manifestCache.set(cacheKey, {
                status,
                contentType: response.headers['content-type'] || 'application/json',
                digest: response.headers['docker-content-digest'] || '',
                body,
                expiry: Date.now() + getManifestTtl(reference)
            });
        }

        res.statusCode = status;
        res.end(body);
    } catch (error) {
        console.error('Docker registry error:', error && error.message);
        const isTimeout = error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = isTimeout ? 504 : 502;
        res.end(JSON.stringify({
            errors: [{ code: 'UNAVAILABLE', message: isTimeout ? 'Upstream timed out' : 'Upstream request failed' }]
        }));
    }
};
