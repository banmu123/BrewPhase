package com.brewphase.android.core

/**
 * 风味标签的存储编码。
 *
 * iOS 把 `[String]` 存成用 **U+001F（Unit Separator）** 连接的字符串——选它是因为
 * 人不可能在标签里打出这个字符。Android 必须用同一套编码：跨端备份与同步传的是
 * 数据库字段本身，换一种分隔符就会在另一端读成一整个标签。
 */
object TagCodec {

    const val SEPARATOR = '\u001F'

    fun decode(raw: String): List<String> {
        if (raw.isEmpty()) return emptyList()
        return raw.split(SEPARATOR)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    }

    fun encode(tags: List<String>): String =
        tags.map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(SEPARATOR.toString())
}
