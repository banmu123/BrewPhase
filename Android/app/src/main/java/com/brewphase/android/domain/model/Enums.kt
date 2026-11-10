package com.brewphase.android.domain.model

/**
 * 烘焙度：五档，不是四档。
 *
 * `mediumDark`（中深烘）与 `dark`（深烘）对喝的人来说是两种豆子，即使默认窗口
 * 相同；`espressoBlend`（意式拼配）也不能并进深烘——它的排气期比黄金窗口还长。
 * 每一档都有自己可编辑的规则，所以枚举值必须原样保留。
 */
enum class RoastLevel(val raw: String, val sortOrder: Int) {
    Light("light", 0),
    Medium("medium", 1),
    MediumDark("mediumDark", 2),
    Dark("dark", 3),
    EspressoBlend("espressoBlend", 4);

    companion object {
        fun fromRaw(raw: String?): RoastLevel =
            entries.firstOrNull { it.raw == raw } ?: Medium

        /** 选择器顺序：由浅到深，拼配最后。 */
        val pickerOrder: List<RoastLevel> = entries.sortedBy { it.sortOrder }
    }
}

/**
 * 一包豆的生命周期。`finished` 不删历史：喝完的豆子仍要能回看冲煮与风味。
 */
enum class BeanStatus(val raw: String) {
    Active("active"),
    Finished("finished");

    companion object {
        fun fromRaw(raw: String?): BeanStatus =
            entries.firstOrNull { it.raw == raw } ?: Active
    }
}

/**
 * 一包豆在时间轴上的位置。四个阶段，不是五个：
 * 「建议优先消耗」不是一个时间点，而是"阶段 + 剩余量"得出的结论。
 */
enum class BeanPhase(val raw: String, val order: Int) {
    Resting("resting", 0),
    Opening("opening", 1),
    Peak("peak", 2),
    Declining("declining", 3);

    /** 这包豆今天值不值得喝。 */
    val isInWindow: Boolean get() = this == Peak || this == Declining

    companion object {
        fun fromRaw(raw: String?): BeanPhase =
            entries.firstOrNull { it.raw == raw } ?: Resting
    }
}

/** 提醒的紧迫程度。 */
enum class PriorityTier(val raw: Int) {
    Low(0), Normal(1), High(2), Urgent(3);

    companion object {
        fun fromRaw(raw: Int): PriorityTier = entries.firstOrNull { it.raw == raw } ?: Low
    }
}

/**
 * 一条风味记录从哪来。`brew` 是冲煮自动生成的镜像，独立于冲煮本身：
 * 删掉镜像不该删冲煮，删掉冲煮要能精确带走它那一条。
 */
enum class TastingSource(val raw: String) {
    Manual("manual"),
    Brew("brew");

    companion object {
        fun fromRaw(raw: String?): TastingSource =
            entries.firstOrNull { it.raw == raw } ?: Manual
    }
}

/** 内容载体：这条记录**是**什么。 */
enum class RecordCarrier(val raw: String) {
    Link("link"),
    Image("image"),
    Video("video"),
    Text("text");

    companion object {
        fun fromRaw(raw: String?): RecordCarrier =
            entries.firstOrNull { it.raw == raw } ?: Text
    }
}

/** 链接平台。`generic` 是普通网页，不是"识别失败"。 */
enum class LinkProvider(val raw: String) {
    YouTube("youtube"),
    Bilibili("bilibili"),
    X("x"),
    GitHub("github"),
    Generic("generic");

    /** 只有平台确有官方播放器/嵌入组件时才为 true。 */
    val hasOfficialEmbed: Boolean
        get() = this == YouTube || this == Bilibili

    companion object {
        fun fromRaw(raw: String?): LinkProvider =
            entries.firstOrNull { it.raw == raw } ?: Generic
    }
}

/** 这条链接的形态：视频、社交帖子还是普通网页。 */
enum class LinkContentKind(val raw: String) {
    Video("video"),
    SocialPost("socialPost"),
    Repository("repository"),
    Webpage("webpage");

    companion object {
        fun fromRaw(raw: String?): LinkContentKind =
            entries.firstOrNull { it.raw == raw } ?: Webpage
    }
}

/** 元数据抓取状态。失败也要留下状态，卡片才知道该降级成什么样。 */
enum class LinkMetadataStatus(val raw: String) {
    Idle("idle"),
    Loading("loading"),
    Loaded("loaded"),
    Failed("failed");

    companion object {
        fun fromRaw(raw: String?): LinkMetadataStatus =
            entries.firstOrNull { it.raw == raw } ?: Idle
    }
}

/**
 * 允许打断用户的五个时刻，与 iOS `ReminderKind.allCases` 一一对应。
 *
 * 默认值也是照抄 iOS：三个「推荐提醒」默认开（进入窗口 / 黄金期将尽 / 喝不完），
 * 另外两个默认关——不要默认开启过多提醒。
 */
enum class ReminderKind(val raw: String) {
    /** 排气期结束，风味开始打开。 */
    RestComplete("restComplete"),

    /** 进入黄金风味期。 */
    WindowOpens("windowOpens"),

    /** 黄金风味期走过一半。 */
    WindowHalfway("windowHalfway"),

    /** 黄金风味期结束前两天。 */
    WindowEnding("windowEnding"),

    /** 按消耗速度，这包喝不完黄金期。 */
    BrewPriority("brewPriority");

    val recommendedByDefault: Boolean
        get() = this == WindowOpens || this == WindowEnding || this == BrewPriority

    companion object {
        fun fromRaw(raw: String?): ReminderKind? = entries.firstOrNull { it.raw == raw }
    }
}
