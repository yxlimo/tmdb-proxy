## tmdb-proxy

用 Vercel 代理 TMDB 接口。免费额度每月 100GB 流量，自用完全够用。

支持错误原样透传、多方法转发、缓存隔离与分级、服务端凭据注入、
上游超时处理、健康检查、尾斜杠处理，并有单元测试覆盖。

## 功能

| 能力 | 说明 |
| --- | --- |
| 接口代理 | `/{3\|4}/...` 透传到 `api.themoviedb.org`，路径与查询参数原样转发 |
| 图片代理 | `/t/p/...`、`/t/{w\|o\|l\|r}/...` 转发到 `image.tmdb.org` |
| 错误原样透传 | 上游状态码和响应体不包装，TMDB 的 `status_code` / `status_message` 保持原样，Emby / Jellyfin / TMDbHelper 可直接解析 |
| 多方法支持 | GET / HEAD / POST / PUT / PATCH / DELETE 按原方法转发，`POST /4/auth/token`、`DELETE /4/auth/session` 等 v4 鉴权接口可用 |
| 分层缓存 | Vercel 共享 CDN 缓存 + 进程内缓存，TTL 按数据类别分级（配置 24h / 剧集 12h / 榜单 1h / 趋势 15min），不跟随上游 |
| 缓存隔离 | 缓存键含凭据指纹，不同用户的私有数据不会互相串 |
| 服务端凭据 | 可配置 `TMDB_API_KEY` / `TMDB_BEARER_TOKEN`，客户端无需再带 key |
| CORS | 允许跨域，`OPTIONS` 预检直接放行 |
| 健康检查 | `/health` 返回服务状态、缓存条目数与地理信息 |
| 根路径 | 308 跳转到本仓库页面 |

## 部署

1. fork 本仓库，登录 [Vercel](https://vercel.com/) 选择自己的仓库新建项目。

2. 绑定自己的域名。**必须绑定**——`*.vercel.app` 在国内基本不可用
   （实测被 DNS 污染 + TLS SNI 层面 RST 双重阻断）。

3. 可选：配置服务端 key（Settings → Environment Variables）

   | 变量 | 说明 |
   | --- | --- |
   | `TMDB_API_KEY` | 服务端 v3 api key，配置后客户端无需再带 key |
   | `TMDB_BEARER_TOKEN` | 服务端 v4 read access token，优先级更高 |

   配好后客户端（含 Emby / Jellyfin 的 TMDB 提供器）只填代理域名即可。

推送到 `master` 会触发 Vercel 重新部署。

### 全部环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TMDB_API_KEY` | 空 | 服务端 v3 api key |
| `TMDB_BEARER_TOKEN` | 空 | 服务端 v4 read access token，优先级高于 `TMDB_API_KEY` |
| `TMDB_API_BASE` | `https://api.themoviedb.org` | 上游地址，可指向自建镜像 |
| `TMDB_TIMEOUT_MS` | `15000` | 上游请求超时，超时返回 504 |
| `TMDB_CACHE_MAX_SIZE` | `1000` | 进程内缓存条目上限 |
| `TMDB_LOCAL_CACHE_TTL_CAP_MS` | `1800000` | 进程内缓存 TTL 上限（30 分钟） |
| `TMDB_TTL_CONFIGURATION` | `86400` | `/3/configuration` 的共享缓存 TTL（秒） |
| `TMDB_TTL_GENRE` | `86400` | `/3/genre/*` 的共享缓存 TTL（秒） |
| `TMDB_TTL_CERTIFICATION` | `86400` | `/3/certification/*` 的共享缓存 TTL（秒） |
| `TMDB_TTL_MEDIA` | `43200` | 剧集本体的共享缓存 TTL（秒） |
| `TMDB_TTL_SEASON` | `21600` | 单季集数的共享缓存 TTL（秒） |
| `TMDB_TTL_LIST` | `3600` | 榜单类的共享缓存 TTL（秒） |
| `TMDB_TTL_TRENDING` | `900` | 趋势榜的共享缓存 TTL（秒） |
| `TMDB_TTL_SEARCH` | `900` | 搜索结果的共享缓存 TTL（秒） |
| `TMDB_TTL_DEFAULT` | `3600` | 其余 v3 接口的共享缓存 TTL（秒） |

## 使用方法

1. **v3**——调用方自带 api key：

   ```bash
   curl "https://<你的域名>/3/movie/550?api_key=<你的 v3 key>&language=zh-CN"
   ```

2. **v4**——调用方自带 read access token：

   ```bash
   curl -H "Authorization: Bearer <你的 v4 token>" "https://<你的域名>/4/movie/550"
   ```

3. **图片**——把 TMDB 返回的 `poster_path` / `backdrop_path` 拼成
   `https://<你的域名>/t/p/{size}{poster_path}`，
   `size` 取 `w185` / `w300` / `w342` / `w500` / `w780` / `original`：

   ```bash
   curl -o poster.jpg "https://<你的域名>/t/p/w500/1E5baAaEse26fej7uHcjOgEE2t2.jpg"
   ```

4. **健康检查**：

   ```bash
   curl "https://<你的域名>/health"
   ```

## 注意事项

- 共享 CDN 缓存由 Vercel 边缘承担，跨实例共享；进程内缓存每实例一份，冷启动即失效。
- 免费额度每月 100GB 流量，图片请求同样计入。
- 代理只做转发，不做鉴权与限流。公开暴露前建议在 Vercel WAF 里加访问控制——
  Bot Protection 会对非浏览器客户端（Emby / Jellyfin）下发 JS 挑战，客户端解不开会拿到 403。
  可在项目 → Firewall 里加一条 custom rule，用 `City` / `AS Number` / `ip_address`
  条件配 `bypass` 动作放行自己的来源。

## 本地开发

```bash
pnpm install
pnpm test
```

测试会在本地起一个假上游，覆盖透传、错误、缓存隔离、凭据注入、超时、缓存 TTL 分级等场景。

