/**
 * TMDB 代理的缓存策略。
 *
 * 分两层：
 *   1. 共享 CDN 缓存（Vercel-CDN-Cache-Control: s-maxage）
 *      —— 只有 v3 公共接口能进。命中时请求根本不进函数，
 *         由最近的 PoP 直接返回，国内延迟最低。
 *   2. 进程内缓存（每实例一份 Map）
 *      —— 挡住同一波请求里的重复回源，实例回收即失效。
 *
 * 上游自带的 cache-control 不透传：TTL 完全由本文件决定。
 *
 * 为什么 v4 一律不进共享缓存：
 *   - v4 靠 Authorization 头鉴权，而 Vercel CDN 本来就不缓存带 Authorization 的请求；
 *   - 且 v4 响应可能因 token 作用域不同而不同，共享缓存会串数据。
 *
 * 重要：要��� v3 公共接口真正共享同一份 CDN 缓存，
 * 客户端必须不传 api_key（由服务端 TMDB_API_KEY 注入）。
 * 否则 api_key 会进入 CDN 缓存键，导致每个 key 各存一份、且 key 明文落在键里。
 */

// 榜单类路径（TMDB 每天重算，变动比剧集本体快得多）
// 注意：这些路径都在 /3/movie/ 与 /3/tv/ 之下，必须在 media 规则之前判断，
// 否则 /3/movie/popular 会被当成剧集本体，TTL 差 12 倍。
const LIST_PATHS = new Set([
    '/3/movie/popular',
    '/3/movie/top_rated',
    '/3/movie/now_playing',
    '/3/movie/upcoming',
    '/3/tv/popular',
    '/3/tv/top_rated',
    '/3/tv/on_the_air',
    '/3/tv/airing_today'
]);

// 分类 TTL（秒）
const TTL = {
    // 几乎不变：接口形态、图片尺寸表、语言与认证列表
    configuration: 24 * 60 * 60,
    genre: 24 * 60 * 60,
    certification: 24 * 60 * 60,
    // 剧集/电影本体：上映后信息基本定型
    media: 12 * 60 * 60,
    // 榜单类：TMDB 每天重算，1 小时足够
    list: 60 * 60,
    // 趋势榜与搜索：变动较快
    trending: 15 * 60,
    search: 15 * 60,
    // 单季集数列表：季与季之间相对静态
    season: 6 * 60 * 60,
    // 默认兜底
    default: 60 * 60
};

// 共享缓存允许的过期后宽限期（秒）：过期后先返回旧内容，后台回源刷新。
// 实时性要求低，宽限期给足，避免高峰期回源风暴。
const STALE_WHILE_REVALIDATE = 24 * 60 * 60;

// 环境变量覆盖：把某一类的 TTL 整体调大或调小，
// 例如 TMDB_TTL_MEDIA=21600 把剧集本体的缓存从 12 小时改成 6 小时。
const TTL_ENV_OVERRIDES = {
    configuration: 'TMDB_TTL_CONFIGURATION',
    genre: 'TMDB_TTL_GENRE',
    certification: 'TMDB_TTL_CERTIFICATION',
    media: 'TMDB_TTL_MEDIA',
    list: 'TMDB_TTL_LIST',
    trending: 'TMDB_TTL_TRENDING',
    search: 'TMDB_TTL_SEARCH',
    season: 'TMDB_TTL_SEASON',
    default: 'TMDB_TTL_DEFAULT'
};

/**
 * 取某一类的 TTL（秒），允许用环境变量覆盖。
 */
function ttlOf(category) {
    const envName = TTL_ENV_OVERRIDES[category];
    if (envName && process.env[envName]) {
        const value = Number(process.env[envName]);
        if (Number.isFinite(value) && value >= 0) return value;
    }
    return TTL[category];
}

// 永不共享缓存的路径前缀（用户私有数据）
const PRIVATE_PREFIXES = [
    '/4/account',
    '/4/auth',
    '/4/list',
    '/3/account',
    '/3/list'
];

// 路径后缀：这些接口返回的是「当前用户」在该资源上的状态（评分/收藏/观看进度），
// 属于用户私有数据，只是路径不在上面那些前缀里。
const PRIVATE_SUFFIXES = [
    '/account_states',
    '/item_status'
];

// 查询参数里的私有信号：
//  - session_id / guest_session_id：v3 的用户会话，命中后响应会带上该用户的状态
//  - append_to_response=account_states：显式要求把用户状态附加进公共响应
// 这两个都不在路径上，但会让同一个路径返回不同用户的数据，必须按私有处理。
const PRIVATE_QUERY_KEYS = ['session_id', 'guest_session_id'];
const PRIVATE_APPEND_KEY = 'append_to_response';
const PRIVATE_APPEND_VALUES = ['account_states'];

// 显式不缓存的状态码：调用方的问题（401/403/404）或上游临时故障（429/5xx）。
// 缓存下来会让客户端在 key 修好后仍持续收到错误。
const NON_CACHEABLE_STATUS = new Set([400, 401, 403, 404, 429, 500, 502, 503, 504]);

/**
 * 判断请求是否包含用户私有数据。
 *
 * @param {string} pathname 请求路径（不含 query）
 * @param {URLSearchParams} [query] 请求查询参数
 */
function isPrivateRequest(pathname, query) {
    if (PRIVATE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))) {
        return true;
    }
    if (PRIVATE_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
        return true;
    }
    if (!query) return false;
    for (const key of PRIVATE_QUERY_KEYS) {
        if (query.has(key) && query.get(key)) return true;
    }
    const append = query.get(PRIVATE_APPEND_KEY);
    if (append) {
        const values = append.split(',').map((v) => v.trim().toLowerCase());
        if (values.some((v) => PRIVATE_APPEND_VALUES.includes(v))) return true;
    }
    return false;
}

/**
 * v3 公共接口的共享缓存 TTL（秒）。0 表示不进共享缓存。
 *
 * @param {string} pathname 请求路径（不含 query）
 * @param {string} method HTTP 方法
 * @param {number} status 上游返回的状态码
 * @param {boolean} isV4 是否是 v4 接口
 * @param {boolean} isPrivate 是否含用户私有数据
 */
function getSharedTtl(pathname, method, status, isV4, isPrivate) {
    if (method !== 'GET' && method !== 'HEAD') return 0;
    if (NON_CACHEABLE_STATUS.has(status)) return 0;
    if (isPrivate) return 0;
    // v4 走 Authorization 鉴权，响应可能因 token 作用域而异，不共享。
    if (isV4) return 0;

    if (pathname === '/3/configuration' || pathname.startsWith('/3/configuration/')) {
        return ttlOf('configuration');
    }
    if (pathname.startsWith('/3/genre/')) {
        return ttlOf('genre');
    }
    if (pathname.startsWith('/3/certification/')) {
        return ttlOf('certification');
    }
    // 榜单类要在 media 之前判断
    if (LIST_PATHS.has(pathname)) {
        return ttlOf('list');
    }
    if (pathname.startsWith('/3/search/')) {
        return ttlOf('search');
    }
    if (pathname.startsWith('/3/trending/')) {
        return ttlOf('trending');
    }
    if (pathname.startsWith('/3/tv/') && /\/season\/\d+/.test(pathname)) {
        return ttlOf('season');
    }
    if (
        pathname.startsWith('/3/tv/') ||
        pathname.startsWith('/3/movie/') ||
        pathname.startsWith('/3/person/')
    ) {
        return ttlOf('media');
    }
    if (pathname.startsWith('/3/')) {
        return ttlOf('default');
    }
    return 0;
}

/**
 * 进程内缓存的 TTL（秒）。0 表示不缓存。
 *
 * 进程内缓存的键带凭据指纹与 session_id，因此私有数据本来也安全；
 * 但多实例部署下私有数据的重复回源率很低，缓存收益小，
 * 这里直接不缓存私有数据，减少「A 用户数据被返回给 B 用户」的风险面。
 */
function getLocalTtl(pathname, method, status, isPrivate) {
    if (method !== 'GET' && method !== 'HEAD') return 0;
    if (NON_CACHEABLE_STATUS.has(status)) return 0;
    if (isPrivate) return 0;
    // 与共享缓存用同一套分类，只是随后会被实例内存上限截断
    return getSharedTtl(pathname, method, status, false, false) || ttlOf('default');
}

module.exports = {
    TTL,
    TTL_ENV_OVERRIDES,
    STALE_WHILE_REVALIDATE,
    NON_CACHEABLE_STATUS,
    PRIVATE_PREFIXES,
    PRIVATE_SUFFIXES,
    PRIVATE_QUERY_KEYS,
    LIST_PATHS,
    ttlOf,
    isPrivateRequest,
    getSharedTtl,
    getLocalTtl
};
