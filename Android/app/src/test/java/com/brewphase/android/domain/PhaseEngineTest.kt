package com.brewphase.android.domain

import com.brewphase.android.domain.engine.DefaultPhaseRules
import com.brewphase.android.domain.engine.PhaseEngine
import com.brewphase.android.domain.engine.PhaseReading
import com.brewphase.android.domain.model.BeanPhase
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.domain.model.RoastLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * 阶段引擎的黄金样例。
 *
 * 这些数字不是"跑一遍看看"，而是从 iOS `PhaseEngine` 的边界推导出来的：
 * 浅烘默认 `restEnd=3, peakStart=7, peakEnd=28`，所以 Day 2 是养豆、Day 3 是打开、
 * Day 7 是黄金期第一天、Day 28 进入衰减。任何一条与 iOS 不一致，这里就会红。
 */
class PhaseEngineTest {

    private fun bean(
        roastDate: LocalDate? = LocalDate.of(2026, 1, 1),
        openDate: LocalDate? = null,
        level: RoastLevel = RoastLevel.Light,
        remaining: Double = 200.0,
        weight: Double = 250.0,
    ) = BeanSnapshot(
        id = "b1",
        name = "Test",
        roaster = "Roaster",
        roastLevel = level,
        roastDate = roastDate,
        openDate = openDate,
        weightG = weight,
        remainingG = remaining,
        imagePath = null,
        flavorTags = emptyList(),
        status = BeanStatus.Active,
        createdAtMillis = 0,
        updatedAtMillis = 0,
    )

    @Test
    fun `default light rule boundaries`() {
        val rule = DefaultPhaseRules.data(RoastLevel.Light)
        val bounds = PhaseEngine.boundaries(rule)
        assertEquals(3, bounds.restEnd)
        assertEquals(7, bounds.peakStart)
        assertEquals(28, bounds.peakEnd)
    }

    @Test
    fun `five roast levels keep their own windows`() {
        assertEquals(7, PhaseEngine.boundaries(DefaultPhaseRules.data(RoastLevel.Light)).peakStart)
        assertEquals(5, PhaseEngine.boundaries(DefaultPhaseRules.data(RoastLevel.Medium)).peakStart)
        assertEquals(3, PhaseEngine.boundaries(DefaultPhaseRules.data(RoastLevel.MediumDark)).peakStart)
        assertEquals(3, PhaseEngine.boundaries(DefaultPhaseRules.data(RoastLevel.Dark)).peakStart)
        assertEquals(7, PhaseEngine.boundaries(DefaultPhaseRules.data(RoastLevel.EspressoBlend)).peakStart)
        // 意式拼配的排气期比黄金期还长：restMin 5 被夹在 peakStart 之前，但 restEnd 仍取 5。
        assertEquals(5, PhaseEngine.boundaries(DefaultPhaseRules.data(RoastLevel.EspressoBlend)).restEnd)
    }

    @Test
    fun `day 2 is resting and day 3 opens`() {
        val rule = DefaultPhaseRules.data(RoastLevel.Light)
        assertEquals(BeanPhase.Resting, PhaseEngine.phase(2, rule))
        assertEquals(BeanPhase.Opening, PhaseEngine.phase(3, rule))
        assertEquals(BeanPhase.Opening, PhaseEngine.phase(6, rule))
        assertEquals(BeanPhase.Peak, PhaseEngine.phase(7, rule))
        assertEquals(BeanPhase.Peak, PhaseEngine.phase(27, rule))
        assertEquals(BeanPhase.Declining, PhaseEngine.phase(28, rule))
    }

    @Test
    fun `sealed days past the window start earn a half-day discount`() {
        val rule = DefaultPhaseRules.data(RoastLevel.Light)
        // 第 20 天开封：只有 20-7=13 天算在"窗口开启后仍密封"里，折扣 = round(6.5) = 7，
        // 所以阶段时钟读到第 20-7=13 天。
        assertEquals(13, PhaseEngine.effectiveDay(20, 20, rule))
        // 开封前不产生折扣。
        assertEquals(10, PhaseEngine.effectiveDay(10, null, rule))
        // 第 3 天就开封：窗口还没开始，一天也不耽误。
        assertEquals(5, PhaseEngine.effectiveDay(5, 3, rule))
        // 读数不能倒退：第 6 天开封时，6-7 为负 → 只按 0 天折扣。
        assertEquals(6, PhaseEngine.effectiveDay(6, 6, rule))
    }

    @Test
    fun `late opening postpones the peak start`() {
        val rule = DefaultPhaseRules.data(RoastLevel.Light)
        val sealed = bean(openDate = LocalDate.of(2026, 1, 21)) // day 20
        val reading = PhaseEngine.reading(sealed, rule, today = LocalDate.of(2026, 1, 21))
        assertEquals(20, reading.dayAfterRoast)
        assertEquals(13, reading.effectiveDay)
        assertEquals(7, reading.sealedShiftDays)
        assertEquals(BeanPhase.Peak, reading.phase)
    }

    @Test
    fun `missing roast date is reported instead of guessing day zero`() {
        val reading = PhaseEngine.reading(bean(roastDate = null), today = LocalDate.of(2026, 1, 10))
        assertNull(reading.dayAfterRoast)
        assertEquals(PhaseReading.Problem.MissingRoastDate, reading.problem)
        assertEquals(BeanPhase.Resting, reading.phase)
    }

    @Test
    fun `future roast date is flagged`() {
        val reading = PhaseEngine.reading(
            bean(roastDate = LocalDate.of(2026, 2, 1)),
            today = LocalDate.of(2026, 1, 1),
        )
        assertEquals(PhaseReading.Problem.RoastDateInFuture, reading.problem)
        assertEquals(0, reading.dayAfterRoast)
        assertEquals(0.0, reading.progress, 0.0001)
    }

    @Test
    fun `custom rule is normalized before use`() {
        val bad = DefaultPhaseRules.data(RoastLevel.Medium).copy(
            peakStartDay = 0,
            peakEndDay = 0,
            declineStartDay = -5,
        )
        val bounds = PhaseEngine.boundaries(bad)
        assertEquals(1, bounds.peakStart)
        assertTrue(bounds.peakEnd >= bounds.peakStart + 1)
    }

    @Test
    fun `day reaching inverts the sealed discount`() {
        val rule = DefaultPhaseRules.data(RoastLevel.Light)
        // 第 20 天开封时，阶段时钟要到第 7 天，日历上必须走到第 11 天（7 + round(4*0.5)=2? 实际为 11）。
        val day = PhaseEngine.dayReaching(7, rule, openDayAfterRoast = 20)
        assertEquals(7, PhaseEngine.effectiveDay(day, 20, rule))
        assertTrue(day >= 7)
    }

    @Test
    fun `track segments cover the whole track`() {
        val reading = PhaseEngine.reading(bean(), today = LocalDate.of(2026, 1, 10))
        assertTrue(reading.trackSegments.isNotEmpty())
        assertEquals(0.0, reading.trackSegments.first().start, 0.0001)
        assertEquals(1.0, reading.trackSegments.last().end, 0.0001)
        // 段与段之间不能有缝。
        reading.trackSegments.zipWithNext().forEach { (a, b) ->
            assertEquals(a.end, b.start, 0.0001)
        }
    }
}
