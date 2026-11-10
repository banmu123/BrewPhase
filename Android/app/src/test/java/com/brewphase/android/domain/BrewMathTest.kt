package com.brewphase.android.domain

import com.brewphase.android.domain.engine.BeanIssue
import com.brewphase.android.domain.engine.BrewIssue
import com.brewphase.android.domain.engine.BrewMath
import com.brewphase.android.domain.engine.BrewRecipe
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * 冲煮算术的边界。
 *
 * 时间解析接受 `2:35` / `155` / `2.35` / 全角写法——中文键盘上这些是常态；
 * 库存夹紧绝不能出现负数或超过总量。
 */
class BrewMathTest {

    @Test
    fun `ratio needs both sides`() {
        assertEquals(16.0, BrewMath.ratioValue(15.0, 240.0), 0.0001)
        assertEquals(0.0, BrewMath.ratioValue(0.0, 240.0), 0.0001)
        assertEquals(0.0, BrewMath.ratioValue(15.0, 0.0), 0.0001)
    }

    @Test
    fun `water and coffee are inverse`() {
        assertEquals(240.0, BrewMath.water(15.0, 16.0), 0.0001)
        assertEquals(15.0, BrewMath.coffee(240.0, 16.0), 0.0001)
        assertEquals(0.0, BrewMath.water(0.0, 16.0), 0.0001)
        assertEquals(0.0, BrewMath.coffee(240.0, 0.0), 0.0001)
    }

    @Test
    fun `time parsing accepts the four ways people type it`() {
        assertEquals(155, BrewMath.parseTime("2:35"))
        assertEquals(155, BrewMath.parseTime("155"))
        assertEquals(155, BrewMath.parseTime("2.35"))
        assertEquals(65, BrewMath.parseTime("1:05"))
        assertEquals(155, BrewMath.parseTime("２：３５"))
        assertEquals(155, BrewMath.parseTime("2．35"))
        assertEquals(0, BrewMath.parseTime("0"))
    }

    @Test
    fun `time parsing rejects nonsense`() {
        assertNull(BrewMath.parseTime(""))
        assertNull(BrewMath.parseTime("abc"))
        assertNull(BrewMath.parseTime("1:65"))
        assertNull(BrewMath.parseTime("2.75"))
        assertNull(BrewMath.parseTime("-5"))
    }

    @Test
    fun `format time`() {
        assertEquals("2:35", BrewMath.formatTime(155))
        assertEquals("0:45", BrewMath.formatTime(45))
        assertEquals("", BrewMath.formatTime(0))
    }

    @Test
    fun `remaining is clamped into the bag`() {
        assertEquals(232.0, BrewMath.remainingAfter(250.0, 18.0, 250.0), 0.0001)
        assertEquals(0.0, BrewMath.remainingAfter(5.0, 18.0, 250.0), 0.0001)
        assertEquals(250.0, BrewMath.remainingAfter(250.0, -18.0, 250.0), 0.0001)
    }

    @Test
    fun `score is clamped to 0 through 5`() {
        assertEquals(0, BrewMath.clampScore(-3))
        assertEquals(5, BrewMath.clampScore(9))
        assertEquals(4, BrewMath.clampScore(4))
    }

    @Test
    fun `brew validation blocks an empty dose only`() {
        val empty = BrewMath.validate(BrewRecipe())
        assertFalse(empty.canSave)
        assertTrue(empty.blocking.contains(BrewIssue.MissingDose))

        val doseOnly = BrewMath.validate(BrewRecipe(coffeeG = 15.0))
        assertTrue(doseOnly.canSave)
        assertTrue(doseOnly.hints.contains(BrewIssue.MissingWater))
        assertTrue(doseOnly.hints.contains(BrewIssue.MissingTemperature))
        assertTrue(doseOnly.hints.contains(BrewIssue.MissingTime))
    }

    @Test
    fun `bean validation trusts a heavier-than-advertised bag`() {
        val result = BrewMath.validateBean(
            name = "Kenya",
            roastDate = LocalDate.of(2026, 1, 1),
            weightG = 200.0,
            remainingG = 220.0,
        )
        assertTrue(result.validation.canSave)
        assertEquals(220.0, result.weightG, 0.0001)
        assertTrue(result.validation.hints.any { it is BeanIssue.RemainingOverWeight })
    }

    @Test
    fun `bean validation blocks missing name and roast date`() {
        val result = BrewMath.validateBean("", null, 200.0, 100.0)
        assertFalse(result.validation.canSave)
        assertTrue(result.validation.blocking.contains(BeanIssue.MissingName))
        assertTrue(result.validation.blocking.contains(BeanIssue.MissingRoastDate))
    }

    @Test
    fun `negative remaining becomes zero`() {
        val result = BrewMath.validateBean("Kenya", LocalDate.of(2026, 1, 1), 200.0, -5.0)
        assertEquals(0.0, result.remainingG, 0.0001)
        assertTrue(result.validation.blocking.contains(BeanIssue.NegativeRemaining))
    }
}
