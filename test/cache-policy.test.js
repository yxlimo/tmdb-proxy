const test = require('node:test');
const assert = require('node:assert');

const {
    isPrivateRequest,
    getSharedTtl,
    getLocalTtl,
    NON_CACHEABLE_STATUS
} = require('../api/cache-policy.js');

test('私有路径识别', () => {
    assert.equal(isPrivateRequest('/4/account/123/favorite/movies'), true);
    assert.equal(isPrivateRequest('/4/auth/token'), true);
    assert.equal(isPrivateRequest('/3/account/1/favorites'), true);
    assert.equal(isPrivateRequest('/3/list/42'), true);
    // v3 的用户状态接口虽然不在私有前缀里，但同样是用户私有数据
    assert.equal(isPrivateRequest('/3/movie/550/account_states'), true);
    assert.equal(isPrivateRequest('/3/list/42/item_status'), true);
    // 公共数据不应误判
    assert.equal(isPrivateRequest('/3/movie/550'), false);
    assert.equal(isPrivateRequest('/3/configuration'), false);
    assert.equal(isPrivateRequest('/3/trending/movie/day'), false);
});

test('带 session_id 的公共路径按私有处理', () => {
    // v3 用 session_id 把用户状态附加进响应，同一路径不同用户结果不同
    const q = new URLSearchParams('session_id=abc123');
    assert.equal(isPrivateRequest('/3/movie/550', q), true);
    const guest = new URLSearchParams('guest_session_id=g1');
    assert.equal(isPrivateRequest('/3/movie/550', guest), true);
    // 普通查询参数不影响
    const normal = new URLSearchParams('language=zh-CN&page=2');
    assert.equal(isPrivateRequest('/3/movie/550', normal), false);
});

test('append_to_response 带 account_states 时按私有处理', () => {
    const q = new URLSearchParams('append_to_response=account_states');
    assert.equal(isPrivateRequest('/3/movie/550', q), true);
    // 附加别的子资源不算私有
    const other = new URLSearchParams('append_to_response=videos');
    assert.equal(isPrivateRequest('/3/movie/550', other), false);
    // 混合列表里含 account_states 也算
    const mixed = new URLSearchParams('append_to_response=videos,account_states');
    assert.equal(isPrivateRequest('/3/movie/550', mixed), true);
});

test('共享缓存 TTL 按数据类别区分', () => {
    // 配置类最长
    const config = getSharedTtl('/3/configuration', 'GET', 200, false, false);
    // 剧集本体次之
    const media = getSharedTtl('/3/movie/550', 'GET', 200, false, false);
    // 榜单更短
    const list = getSharedTtl('/3/movie/popular', 'GET', 200, false, false);
    // 搜索最短
    const search = getSharedTtl('/3/search/movie', 'GET', 200, false, false);

    assert.ok(config > media, 'configuration 的 TTL 应长于 media');
    assert.ok(media > list, 'media 的 TTL 应长于榜单');
    assert.ok(list > search, '榜单的 TTL 应长于搜索');
});

test('v4 接口不进共享缓存', () => {
    assert.equal(getSharedTtl('/4/movie/550', 'GET', 200, true, false), 0);
    assert.equal(getSharedTtl('/4/movie/550', 'GET', 200, true, true), 0);
});

test('私有数据不进共享缓存', () => {
    assert.equal(getSharedTtl('/3/account/1/favorites', 'GET', 200, false, true), 0);
    assert.equal(getSharedTtl('/3/movie/550/account_states', 'GET', 200, false, true), 0);
});

test('错误状态码不进任何缓存', () => {
    for (const status of NON_CACHEABLE_STATUS) {
        assert.equal(getSharedTtl('/3/movie/550', 'GET', status, false, false), 0);
        assert.equal(getLocalTtl('/3/movie/550', 'GET', status, false), 0);
    }
});

test('非 GET/HEAD 不进缓存', () => {
    assert.equal(getSharedTtl('/3/movie/550', 'POST', 200, false, false), 0);
    assert.equal(getSharedTtl('/3/movie/550', 'DELETE', 200, false, false), 0);
    assert.equal(getLocalTtl('/3/movie/550', 'POST', 200, false), 0);
});

test('私有数据不进进程内缓存', () => {
    assert.equal(getLocalTtl('/3/account/1/favorites', 'GET', 200, true), 0);
    assert.equal(getLocalTtl('/3/movie/550/account_states', 'GET', 200, true), 0);
    // 公共数据进进程内缓存
    assert.ok(getLocalTtl('/3/movie/550', 'GET', 200, false) > 0);
});

test('未分类的 v3 路径走默认 TTL', () => {
    const t = getSharedTtl('/3/something/unknown', 'GET', 200, false, false);
    assert.ok(t > 0, '未知 v3 路径也应有共享缓存 TTL');
});

test('非 v3 路径不进共享缓存', () => {
    assert.equal(getSharedTtl('/health', 'GET', 200, false, false), 0);
    assert.equal(getSharedTtl('/', 'GET', 200, false, false), 0);
});
