const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const handler = require('../api/tmdb.js');

// ---- 测试用的假上游 ----
let upstream;
let upstreamBase;
const seen = [];

function startUpstream() {
    return new Promise((resolve) => {
        upstream = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                seen.push({ method: req.method, url: req.url, body, headers: req.headers });

                if (req.url.startsWith('/3/err')) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status_code: 7,
                        status_message: 'Invalid API key: You must be granted a valid key.',
                        success: false
                    }));
                    return;
                }
                if (req.url.startsWith('/3/text')) {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('plain text body');
                    return;
                }
                if (req.url.startsWith('/3/slow')) {
                    setTimeout(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end('{}');
                    }, 3000);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    method: req.method,
                    url: req.url,
                    body,
                    authorization: req.headers.authorization || null
                }));
            });
        });
        upstream.listen(0, '127.0.0.1', () => {
            upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
            resolve();
        });
    });
}

// ---- 模拟 Vercel 的 req/res ----
function invoke({ method = 'GET', url = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
            end(payload) {
                resolve({
                    status: this.statusCode,
                    headers: this.headers,
                    body: payload === undefined ? '' : Buffer.from(payload).toString()
                });
            }
        };
        Promise.resolve(handler({ method, url, headers, body }, res)).catch(reject);
    });
}

test.before(async () => {
    await startUpstream();
    process.env.TMDB_API_BASE = upstreamBase;
});

test.after(() => {
    upstream.close();
});

test('GET 请求原样透传上游响应', async () => {
    const res = await invoke({ url: '/3/movie/550?language=zh-CN' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.url, '/3/movie/550?language=zh-CN');
    assert.equal(res.headers['x-cache-local'], 'MISS');
});

test('上游错误状态码与错误体原样透传', async () => {
    const res = await invoke({ url: '/3/err' });
    assert.equal(res.status, 401);
    const data = JSON.parse(res.body);
    assert.equal(data.status_code, 7);
    assert.match(data.status_message, /Invalid API key/);
    assert.equal(data.success, false);
});

test('非 JSON 响应体原样透传', async () => {
    const res = await invoke({ url: '/3/text' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.equal(res.body, 'plain text body');
});

test('相同请求命中缓存', async () => {
    const first = await invoke({ url: '/3/cache-me' });
    const second = await invoke({ url: '/3/cache-me' });
    assert.equal(first.headers['x-cache-local'], 'MISS');
    assert.equal(second.headers['x-cache-local'], 'HIT');
    assert.equal(first.body, second.body);
});

test('不同 Authorization 不共享缓存', async () => {
    const a = await invoke({ url: '/3/account/1/favorites', headers: { authorization: 'Bearer token-a' } });
    const b = await invoke({ url: '/3/account/1/favorites', headers: { authorization: 'Bearer token-b' } });
    assert.equal(a.headers['x-cache-local'], 'MISS');
    assert.equal(b.headers['x-cache-local'], 'MISS');
    assert.match(a.body, /token-a/);
    assert.match(b.body, /token-b/);
});

test('POST 请求会转发方法与请求体', async () => {
    const res = await invoke({
        method: 'POST',
        url: '/4/auth/token',
        headers: { 'content-type': 'application/json' },
        body: { username: 'demo' }
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.method, 'POST');
    assert.equal(data.body, '{"username":"demo"}');
});

test('服务端配置 api key 后调用方无需带 key', async () => {
    process.env.TMDB_API_KEY = 'server-key';
    const res = await invoke({ url: '/3/movie/550' });
    const data = JSON.parse(res.body);
    assert.match(data.url, /api_key=server-key/);
    delete process.env.TMDB_API_KEY;
});

test('服务端配置 bearer token 时覆盖调用方凭据', async () => {
    process.env.TMDB_BEARER_TOKEN = 'server-token';
    const res = await invoke({ url: '/3/movie/550?api_key=client-key', headers: { authorization: 'Bearer client-token' } });
    const data = JSON.parse(res.body);
    assert.equal(data.authorization, 'Bearer server-token');
    assert.doesNotMatch(data.url, /api_key/);
    delete process.env.TMDB_BEARER_TOKEN;
});

test('上游超时返回 504', async () => {
    process.env.TMDB_TIMEOUT_MS = '200';
    const res = await invoke({ url: '/3/slow' });
    assert.equal(res.status, 504);
    const data = JSON.parse(res.body);
    assert.equal(data.success, false);
    delete process.env.TMDB_TIMEOUT_MS;
});

test('/health 返回健康状态', async () => {
    const res = await invoke({ url: '/health' });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, 'ok');
    assert.equal(data.upstream, upstreamBase);
});

test('根路径返回服务说明而非透传到上游', async () => {
    const res = await invoke({ url: '/' });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.service, 'tmdb-proxy');
    assert.ok(data.endpoints.docker);
});

test('OPTIONS 预检直接放行', async () => {
    const res = await invoke({ method: 'OPTIONS', url: '/3/movie/550' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('v3 公共接口带共享 CDN 缓存头', async () => {
    const res = await invoke({ url: '/3/movie/550' });
    assert.match(res.headers['vercel-cdn-cache-control'], /s-maxage=\d+/);
    assert.match(res.headers['vercel-cdn-cache-control'], /stale-while-revalidate=\d+/);
    assert.match(res.headers['cdn-cache-control'], /s-maxage=\d+/);
    // 浏览器端只短暂复用
    assert.match(res.headers['cache-control'], /max-age=60/);
});

test('私有接口与错误响应禁止缓存', async () => {
    const priv = await invoke({ url: '/3/account/1/favorites' });
    assert.match(priv.headers['cache-control'], /no-store/);
    assert.equal(priv.headers['vercel-cdn-cache-control'], undefined);

    const err = await invoke({ url: '/3/err' });
    assert.equal(err.status, 401);
    assert.match(err.headers['cache-control'], /no-store/);
    assert.equal(err.headers['vercel-cdn-cache-control'], undefined);
});

test('v4 接口不进入共享缓存', async () => {
    const res = await invoke({ url: '/4/movie/550', headers: { authorization: 'Bearer tok' } });
    assert.equal(res.headers['vercel-cdn-cache-control'], undefined);
    assert.match(res.headers['cache-control'], /no-store/);
});

test('本地缓存命中时同样带共享缓存头', async () => {
    const first = await invoke({ url: '/3/movie/550/local-hit-check' });
    const second = await invoke({ url: '/3/movie/550/local-hit-check' });
    assert.equal(second.headers['x-cache-local'], 'HIT');
    // 关键：命中时也必须有 s-maxage，否则边缘永远缓存不住
    assert.match(second.headers['vercel-cdn-cache-control'], /s-maxage=\d+/);
    assert.equal(first.body, second.body);
});

test('客户端自带 api_key 时缓存键按 key 隔离', async () => {
    // 不同 key 的请求不能共享本地缓存条目
    const a = await invoke({ url: '/3/movie/550/key-test?api_key=key-a' });
    const b = await invoke({ url: '/3/movie/550/key-test?api_key=key-b' });
    assert.equal(a.headers['x-cache-local'], 'MISS');
    assert.equal(b.headers['x-cache-local'], 'MISS');
    // 上游确实收到了各自的 key
    assert.match(JSON.parse(a.body).url, /api_key=key-a/);
    assert.match(JSON.parse(b.body).url, /api_key=key-b/);

    // 相同 key 的请求命中缓存
    const a2 = await invoke({ url: '/3/movie/550/key-test?api_key=key-a' });
    assert.equal(a2.headers['x-cache-local'], 'HIT');
});

test('带 session_id 的公共路径不进缓存', async () => {
    const res = await invoke({ url: '/3/movie/550?session_id=abc123' });
    assert.equal(res.headers['vercel-cdn-cache-control'], undefined);
    assert.match(res.headers['cache-control'], /no-store/);
    // 同一路径再请求一次也不应命中本地缓存
    const again = await invoke({ url: '/3/movie/550?session_id=abc123' });
    assert.equal(again.headers['x-cache-local'], 'MISS');
});

test('append_to_response=account_states 不进缓存', async () => {
    const res = await invoke({ url: '/3/movie/550?append_to_response=account_states' });
    assert.equal(res.headers['vercel-cdn-cache-control'], undefined);
    assert.match(res.headers['cache-control'], /no-store/);
});
