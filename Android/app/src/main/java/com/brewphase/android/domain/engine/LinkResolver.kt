package com.brewphase.android.domain.engine

import com.brewphase.android.domain.model.LinkContentKind
import com.brewphase.android.domain.model.LinkProvider
import java.net.URI

/**
 * 一次链接识别的结果。
 *
 * 与 iOS `LinkMatch` 同构：平台与内容 ID 是**解析出来的事实**，不是用户输入。
 * 播放地址每次由 [LinkResolver.embed] 现拼，数据库里不存 embed URL——存了就等于
 * 允许一条记录带着任意地址进 WebView。
 */
data class LinkMatch(
    val originalURL: String,
    val canonicalURL: String,
    val provider: LinkProvider,
    val contentKind: LinkContentKind,
    val platformContentID: String,
    val page: Int = 1,
)

/** 允许内嵌的播放器地址与它的可信域名。 */
data class LinkEmbed(
    val url: String,
    val allowedHosts: Set<String>,
    val parentOrigin: String? = null,
)

/**
 * URL 规范化。只为去重与展示服务，不改内容语义。
 */
object LinkURL {

    /** 只记录"从哪里点进来的"，不影响内容本身。 */
    private val trackingKeys = setOf(
        "fbclid", "gclid", "yclid", "mc_cid", "mc_eid", "igshid",
        "ref_src", "ref_url", "spm_id_from", "vd_source",
        "share_source", "share_medium", "share_plat", "share_session_id", "share_tag",
        "unique_k", "from_source", "timestamp", "si", "feature", "pp",
    )

    private val trackingPrefixes = listOf("utm_")

    fun isTracking(key: String): Boolean {
        val lower = key.lowercase()
        if (lower in trackingKeys) return true
        return trackingPrefixes.any { lower.startsWith(it) }
    }

    /**
     * 去掉跟踪参数、锚点、多余的斜杠；主机小写、去 `www.`、去默认端口；
     * 查询参数排序——同样一条链接换个参数顺序，也要被判成同一条。
     */
    fun cleaned(raw: String): String? {
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val rawHost = uri.host ?: return null
        if (rawHost.isEmpty()) return null

        var host = rawHost.lowercase()
        if (host.startsWith("www.")) host = host.removePrefix("www.")

        val port = uri.port
        val keepPort = port != -1 && !((scheme == "https" && port == 443) || (scheme == "http" && port == 80))

        var path = uri.rawPath ?: ""
        if (path.isEmpty()) path = "/"
        if (path.length > 1 && path.endsWith("/")) path = path.dropLast(1)

        val kept = (uri.rawQuery ?: "")
            .split('&')
            .filter { it.isNotEmpty() }
            .map { param ->
                val idx = param.indexOf('=')
                if (idx < 0) param to "" else param.substring(0, idx) to param.substring(idx + 1)
            }
            // 空值参数在 iOS 那里会被丢掉：它不携带信息，却让两条同一内容的地址看着不同。
            .filter { (name, value) -> !isTracking(name) && value.isNotEmpty() }
            .sortedWith(compareBy({ it.first }, { it.second }))

        val query = kept.joinToString("&") { (name, value) -> "$name=$value" }

        return buildString {
            append(scheme).append("://").append(host)
            if (keepPort) append(':').append(port)
            append(path)
            if (query.isNotEmpty()) append('?').append(query)
        }
    }

    fun host(raw: String): String? {
        val host = runCatching { URI(raw).host }.getOrNull()?.lowercase() ?: return null
        if (host.isEmpty()) return null
        return if (host.startsWith("www.")) host.removePrefix("www.") else host
    }

    fun query(raw: String, name: String): String? =
        runCatching { URI(raw) }.getOrNull()?.rawQuery
            ?.split('&')
            ?.firstOrNull { it == name || it.startsWith("$name=") }
            ?.substringAfter('=', "")

    fun isDigits(raw: String): Boolean = raw.isNotEmpty() && raw.all { it.isDigit() }

    /** 路径分段，去掉空串（等价于 Swift 的 `filter { $0 != "/" }`）。 */
    fun segments(raw: String): List<String> =
        (runCatching { URI(raw) }.getOrNull()?.rawPath ?: "")
            .split('/')
            .filter { it.isNotEmpty() }
}

/**
 * 平台适配 + 安全嵌入地址生成。
 *
 * 规则逐条移植自 iOS `LinkResolver` 与四个 adapter。识别完全在本地完成，不联网：
 * 粘贴的瞬间就能说出"这是 YouTube 视频"。
 */
object LinkResolver {

    // MARK: - 入口

    /** 补 scheme 并校验；读不出合法主机就返回 null（"不是链接"不猜）。 */
    fun normalizeInput(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val host = LinkURL.host(withScheme) ?: return null
        if (!host.contains('.')) return null
        val scheme = runCatching { URI(withScheme).scheme?.lowercase() }.getOrNull()
        if (scheme != "http" && scheme != "https") return null
        return withScheme
    }

    fun match(raw: String): LinkMatch? {
        val url = normalizeInput(raw) ?: return null
        return matchYouTube(url)
            ?: matchBilibili(url)
            ?: matchX(url)
            ?: matchGitHub(url)
            ?: genericMatch(url)
    }

    /** 识别失败时的兜底：只要 http(s) 且主机里有「.」，就一定是条能保存的记录。 */
    fun genericMatch(raw: String): LinkMatch? {
        val url = normalizeInput(raw) ?: return null
        val canonical = LinkURL.cleaned(url) ?: url
        return LinkMatch(
            originalURL = url,
            canonicalURL = canonical,
            provider = LinkProvider.Generic,
            contentKind = LinkContentKind.Webpage,
            platformContentID = "",
        )
    }

    /** 记录只存平台与内容 ID，播放地址每次现拼。 */
    fun embed(match: LinkMatch): LinkEmbed? = when (match.provider) {
        LinkProvider.YouTube -> youTubeEmbed(match.platformContentID)
        LinkProvider.Bilibili -> bilibiliEmbed(match.platformContentID, match.page)
        LinkProvider.X -> xEmbed(match.platformContentID)
        LinkProvider.GitHub, LinkProvider.Generic -> null
    }

    // MARK: - YouTube

    private val youTubeHosts = setOf(
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
    )

    private fun matchYouTube(raw: String): LinkMatch? {
        val id = youTubeVideoID(raw) ?: return null
        return LinkMatch(
            originalURL = raw,
            canonicalURL = "https://www.youtube.com/watch?v=$id",
            provider = LinkProvider.YouTube,
            contentKind = LinkContentKind.Video,
            platformContentID = id,
        )
    }

    fun youTubeVideoID(raw: String): String? {
        val host = LinkURL.host(raw) ?: return null
        if (host !in youTubeHosts) return null

        val parts = LinkURL.segments(raw)
        val candidate = when {
            host.endsWith("youtu.be") -> parts.firstOrNull()
            parts.firstOrNull() == "watch" -> LinkURL.query(raw, "v")
            parts.size >= 2 && parts[0] in listOf("shorts", "embed", "live", "v") -> parts[1]
            else -> null
        } ?: return null

        return if (isVideoID(candidate)) candidate else null
    }

    /** 11 位 base64url；`watch?v=` 后面跟着一长串别的东西时不要当成 ID。 */
    fun isVideoID(raw: String): Boolean {
        if (raw.length != 11) return false
        return raw.all { it.code < 128 && (it.isLetterOrDigit() || it == '_' || it == '-') }
    }

    private fun youTubeEmbed(videoID: String): LinkEmbed? {
        if (!isVideoID(videoID)) return null
        val url = "https://www.youtube.com/embed/$videoID?playsinline=1&rel=0"
        return LinkEmbed(url = url, allowedHosts = setOf("youtube.com"), parentOrigin = "https://com.brewphase.android/")
    }

    // MARK: - Bilibili

    private val bilibiliHosts = setOf(
        "bilibili.com", "www.bilibili.com", "m.bilibili.com",
        "player.bilibili.com", "b23.tv", "www.b23.tv",
    )
    private val bilibiliShortHosts = setOf("b23.tv", "www.b23.tv")

    private fun matchBilibili(raw: String): LinkMatch? {
        val host = LinkURL.host(raw) ?: return null
        if (host !in bilibiliHosts) return null
        val parts = LinkURL.segments(raw)

        if (host in bilibiliShortHosts) {
            if (parts.firstOrNull().isNullOrEmpty()) return null
            // 短链只知道"这是一条 B 站链接"，具体是哪条要等重定向；识别结果照实留空。
            return LinkMatch(
                originalURL = raw,
                canonicalURL = raw,
                provider = LinkProvider.Bilibili,
                contentKind = LinkContentKind.Video,
                platformContentID = "",
            )
        }

        val token = when {
            host == "player.bilibili.com" -> {
                val bvid = LinkURL.query(raw, "bvid")
                val aid = LinkURL.query(raw, "aid")
                when {
                    bvid != null && isBV(bvid) -> bvid
                    aid != null && LinkURL.isDigits(aid) -> "av$aid"
                    else -> null
                }
            }
            parts.size >= 2 && parts[0] == "video" -> normalizeBilibiliToken(parts[1])
            else -> null
        } ?: return null

        val page = pageNumber(raw)
        val canonical = if (page > 1) {
            "https://www.bilibili.com/video/$token?p=$page"
        } else {
            "https://www.bilibili.com/video/$token"
        }
        return LinkMatch(
            originalURL = raw,
            canonicalURL = canonical,
            provider = LinkProvider.Bilibili,
            contentKind = LinkContentKind.Video,
            platformContentID = token,
            page = page,
        )
    }

    private fun normalizeBilibiliToken(raw: String): String? = when {
        isBV(raw) -> raw
        isAV(raw) -> raw
        else -> null
    }

    fun isBV(raw: String): Boolean {
        if (raw.length != 12 || !raw.startsWith("BV")) return false
        return raw.drop(2).all { it.code < 128 && it.isLetterOrDigit() }
    }

    fun isAV(raw: String): Boolean =
        raw.length > 2 && raw.startsWith("av") && LinkURL.isDigits(raw.drop(2))

    private fun pageNumber(raw: String): Int =
        LinkURL.query(raw, "p")?.toIntOrNull()?.coerceAtLeast(1) ?: 1

    private fun bilibiliEmbed(contentID: String, page: Int): LinkEmbed? {
        val query = when {
            isBV(contentID) -> "bvid=$contentID"
            isAV(contentID) -> "aid=${contentID.drop(2)}"
            else -> return null
        }
        val url = "https://player.bilibili.com/player.html?$query&page=${maxOf(1, page)}" +
            "&high_quality=1&danmaku=0&autoplay=0"
        return LinkEmbed(url = url, allowedHosts = setOf("bilibili.com"))
    }

    // MARK: - X

    private val xHosts = setOf(
        "x.com", "www.x.com", "mobile.x.com",
        "twitter.com", "www.twitter.com", "mobile.twitter.com",
    )

    private fun matchX(raw: String): LinkMatch? {
        val id = xStatusID(raw) ?: return null
        val user = xUserName(raw) ?: "i"
        return LinkMatch(
            originalURL = raw,
            canonicalURL = "https://x.com/$user/status/$id",
            provider = LinkProvider.X,
            contentKind = LinkContentKind.SocialPost,
            platformContentID = id,
        )
    }

    fun xStatusID(raw: String): String? {
        val host = LinkURL.host(raw) ?: return null
        if (host !in xHosts) return null
        val parts = LinkURL.segments(raw)
        // /{user}/status/{id}
        if (parts.size >= 3 && parts[1] == "status" && LinkURL.isDigits(parts[2])) return parts[2]
        // /i/web/status/{id}
        if (parts.size >= 4 && parts[0] == "i" && parts[2] == "status" && LinkURL.isDigits(parts[3])) {
            return parts[3]
        }
        return null
    }

    private fun xUserName(raw: String): String? {
        val parts = LinkURL.segments(raw)
        if (parts.size < 3 || parts[1] != "status") return null
        val name = parts[0]
        if (name.isEmpty() || name == "i") return null
        return name
    }

    private fun xEmbed(statusID: String): LinkEmbed? {
        if (!LinkURL.isDigits(statusID)) return null
        return LinkEmbed(
            url = "https://platform.twitter.com/embed/Tweet.html?id=$statusID&dnt=true&theme=light",
            allowedHosts = setOf("platform.twitter.com", "platform.x.com"),
            parentOrigin = "https://x.com/",
        )
    }

    // MARK: - GitHub

    private val gitHubHosts = setOf("github.com", "www.github.com")

    /** 第一段是这些词时不是「owner/repo」，而是 GitHub 自己的功能页。 */
    private val reservedOwners = setOf(
        "settings", "notifications", "explore", "topics", "marketplace", "login",
        "logout", "join", "about", "pricing", "features", "enterprise", "sponsors",
        "orgs", "users", "new", "organizations", "collections", "events", "security",
        "contact", "site", "apps", "codespaces", "discussions", "search", "trending",
        "readme", "customer-stories", "team", "solutions", "resources", "github-copilot",
    )

    private fun matchGitHub(raw: String): LinkMatch? {
        val host = LinkURL.host(raw) ?: return null
        if (host !in gitHubHosts) return null
        val parts = LinkURL.segments(raw)
        if (parts.size < 2) return null

        val owner = parts[0]
        val name = parts[1].removeSuffix(".git")
        if (owner.isEmpty() || name.isEmpty()) return null
        if (owner.lowercase() in reservedOwners) return null
        if (owner.startsWith(".")) return null

        val isRoot = parts.size == 2
        // 仓库根地址才是「同一条内容」；指向某个文件时保留完整地址，
        // 否则同一个仓库下的两个文件会被当成重复记录。
        val canonical = if (isRoot) {
            "https://github.com/$owner/$name"
        } else {
            LinkURL.cleaned(raw) ?: raw
        }

        return LinkMatch(
            originalURL = raw,
            canonicalURL = canonical,
            provider = LinkProvider.GitHub,
            contentKind = LinkContentKind.Repository,
            platformContentID = "$owner/$name",
        )
    }
}
