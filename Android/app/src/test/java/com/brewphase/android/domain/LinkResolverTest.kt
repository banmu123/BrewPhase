package com.brewphase.android.domain

import com.brewphase.android.domain.engine.LinkResolver
import com.brewphase.android.domain.engine.LinkURL
import com.brewphase.android.domain.model.LinkContentKind
import com.brewphase.android.domain.model.LinkProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 链接识别与安全嵌入。
 *
 * 最重要的不是"能不能认出来"，而是：**嵌入地址永远由平台 + 内容 ID 现拼，
 * 绝不采用输入里的 embed 地址**。所以任何野地址都只能退化成 generic，且没有播放器。
 */
class LinkResolverTest {

    @Test
    fun `youtube short link becomes a canonical watch url`() {
        val match = LinkResolver.match("https://youtu.be/dQw4w9WgXcQ")!!
        assertEquals(LinkProvider.YouTube, match.provider)
        assertEquals(LinkContentKind.Video, match.contentKind)
        assertEquals("dQw4w9WgXcQ", match.platformContentID)
        assertEquals("https://www.youtube.com/watch?v=dQw4w9WgXcQ", match.canonicalURL)
    }

    @Test
    fun `youtube shorts and embed forms resolve to the same id`() {
        assertEquals("dQw4w9WgXcQ", LinkResolver.match("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.platformContentID)
        assertEquals("dQw4w9WgXcQ", LinkResolver.match("https://www.youtube.com/embed/dQw4w9WgXcQ")?.platformContentID)
        assertEquals("dQw4w9WgXcQ", LinkResolver.match("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")?.platformContentID)
    }

    @Test
    fun `a watch url with junk is not mistaken for a video id`() {
        assertNull(LinkResolver.youTubeVideoID("https://www.youtube.com/watch?v=too-long-to-be-an-id"))
        assertEquals(LinkProvider.Generic, LinkResolver.match("https://www.youtube.com/watch?v=too-long-to-be-an-id")?.provider)
    }

    @Test
    fun `bilibili keeps the bv token and page`() {
        val match = LinkResolver.match("https://www.bilibili.com/video/BV1xx411c7mD?p=2")!!
        assertEquals(LinkProvider.Bilibili, match.provider)
        assertEquals("BV1xx411c7mD", match.platformContentID)
        assertEquals(2, match.page)
        assertEquals("https://www.bilibili.com/video/BV1xx411c7mD?p=2", match.canonicalURL)
    }

    @Test
    fun `bilibili player page rebuilds its own id instead of trusting the url`() {
        val match = LinkResolver.match("https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=1")!!
        assertEquals("BV1xx411c7mD", match.platformContentID)
        assertTrue(LinkResolver.embed(match)!!.url.contains("autoplay=0"))
    }

    @Test
    fun `x status id and handle`() {
        val match = LinkResolver.match("https://x.com/coffee/status/1234567890")!!
        assertEquals(LinkProvider.X, match.provider)
        assertEquals(LinkContentKind.SocialPost, match.contentKind)
        assertEquals("1234567890", match.platformContentID)
        assertEquals("https://x.com/coffee/status/1234567890", match.canonicalURL)
    }

    @Test
    fun `github repository is a repository, not a video`() {
        val match = LinkResolver.match("https://github.com/banmu123/BrewPhase")!!
        assertEquals(LinkProvider.GitHub, match.provider)
        assertEquals(LinkContentKind.Repository, match.contentKind)
        assertEquals("banmu123/BrewPhase", match.platformContentID)
        assertNull(LinkResolver.embed(match))
    }

    @Test
    fun `github feature pages are not repositories`() {
        assertEquals(LinkProvider.Generic, LinkResolver.match("https://github.com/settings/profile")?.provider)
        assertEquals(LinkProvider.Generic, LinkResolver.match("https://github.com/explore")?.provider)
    }

    @Test
    fun `tracking parameters are stripped and the rest sorted`() {
        val cleaned = LinkURL.cleaned("https://example.com/a?utm_source=x&b=2&a=1&fbclid=zzz")!!
        assertEquals("https://example.com/a?a=1&b=2", cleaned)
    }

    @Test
    fun `same content in different parameter order is one record`() {
        val one = LinkResolver.match("https://example.com/x?b=2&a=1")!!.canonicalURL
        val two = LinkResolver.match("https://example.com/x?a=1&b=2")!!.canonicalURL
        assertEquals(one, two)
    }

    @Test
    fun `www and fragment do not create a second record`() {
        val one = LinkResolver.match("https://www.example.com/x#top")!!.canonicalURL
        val two = LinkResolver.match("https://example.com/x")!!.canonicalURL
        assertEquals(one, two)
    }

    @Test
    fun `an arbitrary embed url never becomes a player`() {
        val match = LinkResolver.match("https://evil.example.com/embed/dQw4w9WgXcQ")!!
        assertEquals(LinkProvider.Generic, match.provider)
        assertNull(LinkResolver.embed(match))
    }

    @Test
    fun `youtube embed is built from the id with the expected flags`() {
        val match = LinkResolver.match("https://youtu.be/dQw4w9WgXcQ")!!
        val embed = LinkResolver.embed(match)!!
        assertTrue(embed.url.startsWith("https://www.youtube.com/embed/dQw4w9WgXcQ"))
        assertTrue(embed.url.contains("playsinline=1"))
        assertEquals(setOf("youtube.com"), embed.allowedHosts)
    }

    @Test
    fun `plain words are not links`() {
        assertNull(LinkResolver.normalizeInput("不是链接"))
        assertNull(LinkResolver.match("hello world"))
    }

    @Test
    fun `scheme-less input is completed with https`() {
        val match = LinkResolver.match("example.com/article")!!
        assertEquals("https://example.com/article", match.originalURL)
        assertEquals(LinkProvider.Generic, match.provider)
    }

    @Test
    fun `github file links keep the full canonical path`() {
        val root = LinkResolver.match("https://github.com/o/r")!!
        val file = LinkResolver.match("https://github.com/o/r/blob/main/README.md")!!
        assertEquals("https://github.com/o/r", root.canonicalURL)
        assertEquals("https://github.com/o/r/blob/main/README.md", file.canonicalURL)
        assertEquals(file.platformContentID, root.platformContentID)
    }

    @Test
    fun `embed only exists for platforms with an official player`() {
        assertNotNull(LinkResolver.embed(LinkResolver.match("https://youtu.be/dQw4w9WgXcQ")!!))
        assertNotNull(LinkResolver.embed(LinkResolver.match("https://www.bilibili.com/video/BV1xx411c7mD")!!))
        assertNull(LinkResolver.embed(LinkResolver.match("https://example.com")!!))
    }
}
