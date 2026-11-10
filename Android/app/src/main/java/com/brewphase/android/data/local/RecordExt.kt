package com.brewphase.android.data.local

import com.brewphase.android.domain.engine.LinkResolver
import com.brewphase.android.domain.engine.LinkURL
import com.brewphase.android.domain.model.LinkProvider
import com.brewphase.android.domain.model.RecordCarrier

/**
 * 卡片上的显示字段。与 iOS `Record.displayTitle / linkHost / sourceLine` 同义：
 * 标题空着时用正文第一行，链接连正文都没有时退回域名——「example.com」比
 * 「未命名链接」有用。
 */
fun RecordEntity.displayTitle(): String {
    val trimmedTitle = title.trim()
    if (trimmedTitle.isNotEmpty()) return trimmedTitle
    if (carrier() == RecordCarrier.Link) {
        summary.trim().lineSequence().firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        linkHost()?.let { return it }
    }
    return note.trim().lineSequence().firstOrNull()?.trim().orEmpty()
}

fun RecordEntity.carrier(): RecordCarrier = RecordCarrier.fromRaw(carrierRaw)

fun RecordEntity.linkHost(): String? {
    val raw = canonicalURL.trim().ifEmpty { urlString.trim() }
    if (raw.isEmpty()) return null
    return LinkURL.host(raw)
}

fun RecordEntity.provider(): LinkProvider = LinkProvider.fromRaw(providerRaw)

/** 平台名；普通网页用域名。 */
fun RecordEntity.providerLabel(): String = when (provider()) {
    LinkProvider.YouTube -> "YouTube"
    LinkProvider.Bilibili -> "哔哩哔哩"
    LinkProvider.X -> "X"
    LinkProvider.GitHub -> "GitHub"
    LinkProvider.Generic -> linkHost().orEmpty()
}

fun RecordEntity.sourceLine(): String =
    sourceName.trim().ifEmpty { linkHost().orEmpty() }

/** 可信的嵌入地址：由平台 + 内容 ID 现拼，绝不采用记录里可能被改写的任何 URL。 */
fun RecordEntity.embedURL(): String? {
    if (carrier() != RecordCarrier.Link) return null
    val match = com.brewphase.android.domain.engine.LinkMatch(
        originalURL = urlString,
        canonicalURL = canonicalURL,
        provider = provider(),
        contentKind = com.brewphase.android.domain.model.LinkContentKind.fromRaw(contentKindRaw),
        platformContentID = platformContentID,
        page = linkPage,
    )
    return LinkResolver.embed(match)?.url
}

fun RecordEntity.openURL(): String? {
    val raw = canonicalURL.trim()
    if (raw.isNotEmpty()) return raw
    return LinkResolver.normalizeInput(urlString)
}
