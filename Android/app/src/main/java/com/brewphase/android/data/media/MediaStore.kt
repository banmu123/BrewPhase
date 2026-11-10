package com.brewphase.android.data.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * 应用自己管理的媒体目录。
 *
 * 导入图片/视频后**复制**进 `files/media`，绝不只存一个可能随时失效的外部 URI——
 * 相册权限被撤销、文件被移走、云端照片没下载，都会让一条记录变成空白。
 *
 * 预览图单独放 `files/previews`：卡片要的是小图，反复解码原图既慢又费内存。
 */
class MediaStore(private val context: Context) {

    private val mediaDir: File = File(context.filesDir, "media").apply { mkdirs() }
    private val previewDir: File = File(context.filesDir, "previews").apply { mkdirs() }

    fun file(name: String): File = File(mediaDir, name)

    fun preview(name: String): File = File(previewDir, name)

    fun exists(name: String): Boolean = file(name).isFile

    /** 复制进来，返回落盘后的文件名（不是原 URI）。 */
    suspend fun importImage(uri: Uri): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val name = "img_${UUID.randomUUID()}.jpg"
            copy(uri, file(name))
            writePreview(name)
            name
        }
    }

    suspend fun importVideo(uri: Uri): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val name = "vid_${UUID.randomUUID()}.mp4"
            copy(uri, file(name))
            writeVideoPreview(name)
            name
        }
    }

    suspend fun writeVideoPreview(name: String) = withContext(Dispatchers.IO) {
        runCatching {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(file(name).absolutePath)
                retriever.getFrameAtTime(0)?.let { bitmap ->
                    File(previewDir, name).outputStream().use { out ->
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
                    }
                }
            } finally {
                retriever.release()
            }
        }
    }

    private fun copy(uri: Uri, target: File) {
        val input = context.contentResolver.openInputStream(uri)
            ?: error("cannot open source uri")
        input.use { source ->
            target.outputStream().use { out -> source.copyTo(out) }
        }
    }

    private fun writePreview(name: String) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file(name).absolutePath, bounds)
        val longest = maxOf(bounds.outWidth, bounds.outHeight).coerceAtLeast(1)
        var sample = 1
        while (longest / sample > 1600) sample *= 2

        val bitmap = BitmapFactory.decodeFile(
            file(name).absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: return

        File(previewDir, name).outputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
        }
        bitmap.recycle()
    }

    fun delete(name: String?) {
        if (name.isNullOrBlank()) return
        file(name).delete()
        preview(name).delete()
    }

    /**
     * 清理没有被任何记录引用的媒体文件。
     *
     * 只删本应用目录里的文件，且只删"确实没人引用"的——被引用的图必须留着，
     * 否则恢复备份后会出现一批打不开的卡片。
     */
    suspend fun cleanupOrphans(referenced: Set<String>): Int = withContext(Dispatchers.IO) {
        var removed = 0
        mediaDir.listFiles()?.forEach { f ->
            val name = f.name
            if (name !in referenced && f.isFile) {
                if (f.delete()) removed++
                preview(name).delete()
            }
        }
        previewDir.listFiles()?.forEach { f ->
            if (f.name !in referenced && f.isFile) f.delete()
        }
        removed
    }

    /** 当前媒体占用（字节），设置页用来显示真实体积。 */
    fun totalBytes(): Long =
        (mediaDir.listFiles()?.sumOf { it.length() } ?: 0L) +
            (previewDir.listFiles()?.sumOf { it.length() } ?: 0L)
}
