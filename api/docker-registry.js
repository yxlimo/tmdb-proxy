/**
 * Docker Registry v2 代理的纯函数部分。
 *
 * 拆分出来是为了能脱离网络单独测试路径解析、缓存策略与令牌逻辑。
 */

// Registry v2 的资源类型
const KINDS = new Set(['manifests', 'blobs', 'tags']);

// 上游返回的 manifest 可能带多种 Content-Type（OCI index、docker manifest list 等），
// 同一个 URL 在不同 Accept 下返回不同内容，所以缓存键必须带上 Accept。
//
// 注意：不能重排顺序。Docker Hub 按客户端给出的优先级协商 manifest 类型，
// 排序后再转发会拿到与客户端预期不同的内容。这里只做去空白与合并多余分隔符。
function normalizeAccept(accept) {
    if (!accept) return '';
    return String(accept)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .join(', ');
}

/**
 * 解析 /v2/ 下的资源路径。
 *
 * 仓库名本身可以含斜杠（library/nginx、bitnami/redis），
 * 而 reference（tag 或 digest）一定不含斜杠，所以从右往左切分最稳。
 *
 * @returns {{kind: string, name: string, reference: string, scope: string}|null}
 */
function parseRegistryPath(pathname) {
    if (!pathname.startsWith('/v2/')) return null;

    const segments = pathname.slice('/v2/'.length).split('/').filter((s) => s !== '');
    // 至少需要 name + kind + reference 三段
    if (segments.length < 3) return null;

    const reference = segments[segments.length - 1];
    const kind = segments[segments.length - 2];
    if (!KINDS.has(kind)) return null;

    const name = segments.slice(0, segments.length - 2).join('/');
    if (!name) return null;

    return { kind, name, reference, scope: `repository:${name}:pull` };
}

// digest 形式的 reference 是内容寻址的，永久不变；
// tag 可能被重新指向，缓存时间要短。
function isDigestReference(reference) {
    return /^sha256:[0-9a-f]{64}$/.test(reference);
}

/**
 * 上游错误体原样透传，Docker 客户端据此区分 401/404/429。
 * 错误响应不缓存。
 */
function isCacheableStatus(status) {
    return status === 200;
}

module.exports = {
    parseRegistryPath,
    normalizeAccept,
    isDigestReference,
    isCacheableStatus
};
