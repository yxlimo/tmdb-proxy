const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const handler = require('../api/docker.js');
const {
    parseRegistryPath,
    normalizeAccept,
    isDigestReference
} = require('../api/docker-registry.js');

// ---- 假上游：同时扮演 registry 与 auth ----
let upstream;
let upstreamBase;
const upstreamHits = [];
const authHits = [];
let tokenSerial = 0;

function startUpstream() {
    return new Promise((resolve) => {
        upstream = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                const url = new URL(req.url, 'http://localhost');

                if (url.pathname === '/token') {
                    authHits.push({ url: req.url, authorization: req.headers.authorization || null });
                    tokenSerial += 1;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        token: `token-${tokenSerial}`,
                        access_token: `token-${tokenSerial}`,
                        expires_in: 300
                    }));
                    return;
                }

                upstreamHits.push({
                    method: req.method,
                    path: url.pathname,
                    accept: req.headers.accept || null,
                    authorization: req.headers.authorization || null
                });

                // blob：上游用 307 指向 CDN
                if (url.pathname.includes('/blobs/')) {
                    res.writeHead(307, {
                        Location: `https://cdn.example.com/data?sig=abc~def&Expires=123&Key-Pair-Id=K1`,
                        'Docker-Content-Digest': 'sha256:blobdigest'
                    });
                    res.end();
                    return;
                }

                if (url.pathname === '/v2/' || url.pathname === '/v2') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{}');
                    return;
                }

                if (url.pathname.endsWith('/manifests/missing')) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
                    return;
                }

                if (url.pathname.endsWith('/manifests/expired')) {
                    // 第一次请求返回 401，模拟令牌过期
                    if (upstreamHits.filter((h) => h.path === url.pathname).length === 1) {
                        res.writeHead(401, {
                            'WWW-Authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
                        return;
                    }
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
                        'Docker-Content-Digest': 'sha256:manifestdigest'
                    });
                    res.end(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json' }));
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
                    'Docker-Content-Digest': 'sha256:manifestdigest',
                    'Docker-Distribution-Api-Version': 'registry/2.0',
                    'Ratelimit-Limit': '100;w=3600',
                    'Ratelimit-Remaining': '99;w=3600'
                });
                res.end(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json' }));
            });
        });
        upstream.listen(0, '127.0.0.1', () => {
            upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
            resolve();
        });
    });
}

// ---- 模拟 Vercel 的 req/res ----
// res 需要支持流式写入（write），因为 blob 的 proxy 模式用 pipe 转发
function invoke({ method = 'GET', url = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
            write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
            end(payload) {
                if (payload !== undefined && payload !== null) chunks.push(Buffer.from(payload));
                resolve({
                    status: this.statusCode,
                    headers: this.headers,
                    body: Buffer.concat(chunks).toString()
                });
            }
        };
        Promise.resolve(handler({ method, url, headers }, res)).catch(reject);
    });
}

test.before(async () => {
    await startUpstream();
    process.env.DOCKER_REGISTRY_BASE = upstreamBase;
    process.env.DOCKER_AUTH_BASE = upstreamBase;
    process.env.DOCKERHUB_TOKEN = 'test-token';
    process.env.DOCKERHUB_USERNAME = 'tester';
});

test.after(() => {
    if (upstream) upstream.close();
});

// ---- 路径解析 ----

test('parseRegistryPath 解析仓库名含斜杠的情况', () => {
    const parsed = parseRegistryPath('/v2/library/nginx/manifests/latest');
    assert.equal(parsed.kind, 'manifests');
    assert.equal(parsed.name, 'library/nginx');
    assert.equal(parsed.reference, 'latest');
    assert.equal(parsed.scope, 'repository:library/nginx:pull');
});

test('parseRegistryPath 解析 blob 路径', () => {
    const parsed = parseRegistryPath('/v2/bitnami/redis/blobs/sha256:abc');
    assert.equal(parsed.kind, 'blobs');
    assert.equal(parsed.name, 'bitnami/redis');
    assert.equal(parsed.reference, 'sha256:abc');
});

test('parseRegistryPath 拒绝非资源路径', () => {
    assert.equal(parseRegistryPath('/v2/'), null);
    assert.equal(parseRegistryPath('/v2/library/nginx'), null);
    assert.equal(parseRegistryPath('/v2/library/nginx/unknown/x'), null);
    assert.equal(parseRegistryPath('/other'), null);
});

test('normalizeAccept 保留顺序但清理空白', () => {
    assert.equal(normalizeAccept('  a ,  b '), 'a, b');
    // 顺序影响 Docker Hub 的 manifest 类型协商，不能排序
    assert.equal(normalizeAccept('b, a'), 'b, a');
    assert.equal(normalizeAccept(undefined), '');
});

test('isDigestReference 区分 digest 与 tag', () => {
    assert.equal(isDigestReference('sha256:' + 'a'.repeat(64)), true);
    assert.equal(isDigestReference('latest'), false);
    assert.equal(isDigestReference('v1.27'), false);
});

// ---- /v2/ 探测 ----

test('/v2/ 返回 200 与 API 版本头，客户端因此不会自行换令牌', async () => {
    const result = await invoke({ url: '/v2/' });
    assert.equal(result.status, 200);
    assert.equal(result.headers['docker-distribution-api-version'], 'registry/2.0');
    assert.equal(result.body, '{}');
});

// ---- manifest ----

test('manifest 原样透传状态码、响应体与关键响应头', async () => {
    const result = await invoke({
        url: '/v2/library/nginx/manifests/latest',
        headers: { accept: 'application/vnd.oci.image.manifest.v1+json' }
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers['docker-content-digest'], 'sha256:manifestdigest');
    assert.equal(result.headers['docker-distribution-api-version'], 'registry/2.0');
    assert.equal(result.headers['ratelimit-limit'], '100;w=3600');
    assert.equal(result.headers['ratelimit-remaining'], '99;w=3600');
    assert.equal(result.headers['x-cache-local'], 'MISS');
    assert.match(result.body, /schemaVersion/);
});

test('manifest 第二次请求命中进程内缓存', async () => {
    const before = upstreamHits.length;
    const result = await invoke({
        url: '/v2/library/nginx/manifests/latest',
        headers: { accept: 'application/vnd.oci.image.manifest.v1+json' }
    });
    assert.equal(result.headers['x-cache-local'], 'HIT');
    assert.equal(upstreamHits.length, before, '命中缓存时不应再请求上游');
});

test('不同 Accept 视为不同缓存条目', async () => {
    const before = upstreamHits.length;
    await invoke({
        url: '/v2/library/nginx/manifests/latest',
        headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' }
    });
    assert.equal(upstreamHits.length, before + 1, 'Accept 变化时应回源');
});

test('上游 404 原样透传', async () => {
    const result = await invoke({ url: '/v2/library/nginx/manifests/missing' });
    assert.equal(result.status, 404);
    assert.match(result.body, /MANIFEST_UNKNOWN/);
});

// ---- token ----

test('换令牌时注入服务端凭据，且令牌按 scope 缓存', async () => {
    const before = authHits.length;
    await invoke({ url: '/v2/library/busybox/manifests/latest' });
    const added = authHits.length - before;
    assert.ok(added >= 1, '应当换过令牌');
    // Basic base64(tester:test-token)
    const expected = 'Basic ' + Buffer.from('tester:test-token').toString('base64');
    assert.equal(authHits[authHits.length - 1].authorization, expected);
});

test('上游返回 401 时强制换令牌并重试', async () => {
    const result = await invoke({ url: '/v2/library/nginx/manifests/expired' });
    assert.equal(result.status, 200, '应重试成功');
    assert.match(result.body, /schemaVersion/);
});

// ---- blob ----

test('blob 的 307 跳转原样透传 Location，且不缓存', async () => {
    const result = await invoke({ url: '/v2/library/nginx/blobs/sha256:abc' });
    assert.equal(result.status, 307);
    assert.equal(result.headers.location, 'https://cdn.example.com/data?sig=abc~def&Expires=123&Key-Pair-Id=K1');
    assert.equal(result.headers['docker-content-digest'], 'sha256:blobdigest');
    assert.equal(result.headers['cache-control'], 'no-store');
});

test('blob 的 proxy 模式改为跟随跳转并返回内容', async () => {
    // 单独起一个 CDN 上游，验证代理确实跟到了 Location
    const cdn = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' });
        res.end('BLOBX');
    });
    await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve));
    const cdnBase = `http://127.0.0.1:${cdn.address().port}`;

    // 让上游把 blob 指向这个 CDN
    const originalBlob = upstream.listeners('request')[0];
    const result = await new Promise((resolve, reject) => {
        const patched = (req, res) => {
            if (req.url.includes('/blobs/')) {
                res.writeHead(307, {
                    Location: `${cdnBase}/data`,
                    'Docker-Content-Digest': 'sha256:blobdigest'
                });
                res.end();
                return;
            }
            originalBlob(req, res);
        };
        upstream.removeAllListeners('request');
        upstream.on('request', patched);
        process.env.DOCKER_BLOB_MODE = 'proxy';
        invoke({ url: '/v2/library/nginx/blobs/sha256:abc' }).then(resolve, reject);
    });

    upstream.removeAllListeners('request');
    upstream.on('request', originalBlob);
    delete process.env.DOCKER_BLOB_MODE;
    cdn.close();

    assert.equal(result.status, 200);
    assert.equal(result.body, 'BLOBX');
    assert.equal(result.headers['cache-control'], 'no-store');
});

// ---- 其它 ----

test('非 GET/HEAD 方法返回 405', async () => {
    const result = await invoke({ method: 'POST', url: '/v2/library/nginx/manifests/latest' });
    assert.equal(result.status, 405);
});

test('未知路径返回 404', async () => {
    const result = await invoke({ url: '/v2/library/nginx' });
    assert.equal(result.status, 404);
});

test('健康检查返回服务状态', async () => {
    const result = await invoke({ url: '/docker-health' });
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.authenticated, true);
});

// ---- 客户端协议序列模拟 ----

test('模拟 docker 客户端的完整请求序列', async () => {
    // 1. 探测 registry
    const ping = await invoke({ url: '/v2/' });
    assert.equal(ping.status, 200);

    // 2. 客户端不携带 Authorization（服务端自行换取令牌）
    const manifest = await invoke({
        url: '/v2/library/nginx/manifests/latest',
        headers: { accept: 'application/vnd.oci.image.manifest.v1+json' }
    });
    assert.equal(manifest.status, 200);

    // 3. 拉 blob，收到 307 后由客户端自行跟随到 CDN
    const blob = await invoke({ url: '/v2/library/nginx/blobs/sha256:abc' });
    assert.equal(blob.status, 307);
    assert.ok(blob.headers.location.startsWith('https://cdn.example.com/'));
});
