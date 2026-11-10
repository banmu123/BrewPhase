package com.brewphase.android.notifications

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.brewphase.android.MainActivity
import com.brewphase.android.R
import com.brewphase.android.data.local.BrewPhaseDatabase
import com.brewphase.android.data.local.toLocalDate
import com.brewphase.android.data.local.toRecord
import com.brewphase.android.data.local.toSnapshot
import com.brewphase.android.data.repository.SettingsRepository
import com.brewphase.android.domain.engine.ConsumptionEstimator
import com.brewphase.android.domain.engine.DefaultPhaseRules
import com.brewphase.android.domain.engine.NotificationPlanner
import com.brewphase.android.domain.engine.PhaseEngine
import com.brewphase.android.domain.model.BrewSample
import com.brewphase.android.domain.model.ReminderKind

/**
 * 把「什么时候该提醒」翻译成本机的 AlarmManager + 通知。
 *
 * 计算全部在 [NotificationPlanner] 里（纯函数、可单测）；这里只做副作用：
 * 取消旧闹钟、按新的计划重设、建通知渠道。
 */
class ReminderScheduler(
    private val context: Context,
    private val db: BrewPhaseDatabase,
) {

    private val alarmManager = context.getSystemService(AlarmManager::class.java)

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_reminders),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.notification_channel_reminders_desc)
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    fun canNotify(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    /**
     * 重排一包豆的全部提醒。
     *
     * 先取消它可能拥有的每一种通知 ID，再按当前规则/库存重设——规则或库存变了，
     * 计划会缩小，不先全清就会留下过期的闹钟。
     */
    suspend fun rescheduleForBean(beanId: String, settings: SettingsRepository) {
        cancelForBean(beanId)
        if (!canNotify()) return

        val beanEntity = db.beanDao().getById(beanId) ?: return
        val bean = beanEntity.toSnapshot()
        val roastDate = bean.roastDate ?: return

        val stored = db.phaseRuleDao().get(bean.roastLevel.raw)
        val rule = stored?.let {
            com.brewphase.android.domain.engine.PhaseRuleData(
                roastLevel = bean.roastLevel,
                restMinDays = it.restMinDays,
                restMaxDays = it.restMaxDays,
                peakStartDay = it.peakStartDay,
                peakEndDay = it.peakEndDay,
                declineStartDay = it.declineStartDay,
                enabled = it.enabled,
            )
        } ?: DefaultPhaseRules.data(bean.roastLevel)

        val brews = db.brewDao().listByBean(beanId).map { it.toRecord() }
        val estimate = ConsumptionEstimator.estimate(
            remainingG = bean.remainingG,
            samples = brews.map { BrewSample(it.dateMillis.toLocalDate(), it.recipe.coffeeG, it.recipe.waterG) },
        )
        val prefs = settings.current()
        val planned = NotificationPlanner.plan(
            beanId = beanId,
            roastDate = roastDate,
            openDate = bean.openDate,
            rule = rule,
            estimate = estimate,
            disabled = ReminderKind.entries.filterNot { prefs.reminderEnabled(it) }.toSet(),
            now = com.brewphase.android.core.DateMath.today(),
        )

        planned.forEach { reminder ->
            val intent = Intent(context, ReminderReceiver::class.java).apply {
                putExtra(EXTRA_BEAN_ID, beanId)
                putExtra(EXTRA_BEAN_NAME, bean.name)
                putExtra(EXTRA_KIND, reminder.kind.raw)
            }
            val pending = PendingIntent.getBroadcast(
                context,
                reminder.androidNotificationId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            // 不要求精确闹钟权限：上午 9 点前后几分钟的偏差可以接受，
            // 换来的是一台不必向用户申请 SCHEDULE_EXACT_ALARM 的手机。
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.fireAtMillis, pending)
        }
    }

    fun cancelForBean(beanId: String) {
        NotificationPlanner.allNotificationIds(beanId).forEach { id ->
            val intent = Intent(context, ReminderReceiver::class.java)
            val pending = PendingIntent.getBroadcast(
                context,
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            alarmManager.cancel(pending)
            context.getSystemService(NotificationManager::class.java)?.cancel(id)
        }
    }

    companion object {
        const val CHANNEL_ID = "brewphase.reminders"
        const val EXTRA_BEAN_ID = "bean_id"
        const val EXTRA_BEAN_NAME = "bean_name"
        const val EXTRA_KIND = "kind"
    }
}

/** 闹钟到点时显示通知。文案与通知 ID 都是本机的事，不跨端同步。 */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val beanId = intent.getStringExtra(ReminderScheduler.EXTRA_BEAN_ID) ?: return
        val beanName = intent.getStringExtra(ReminderScheduler.EXTRA_BEAN_NAME).orEmpty()
        val kind = ReminderKind.fromRaw(intent.getStringExtra(ReminderScheduler.EXTRA_KIND)) ?: return

        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val open = PendingIntent.getActivity(
            context,
            beanId.hashCode(),
            Intent(context, MainActivity::class.java).apply {
                putExtra("beanId", beanId)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val title = when (kind) {
            ReminderKind.RestComplete -> context.getString(R.string.reminder_rest_complete_title, beanName)
            ReminderKind.WindowOpens -> context.getString(R.string.reminder_window_opens_title, beanName)
            ReminderKind.WindowHalfway -> context.getString(R.string.reminder_window_halfway_title, beanName)
            ReminderKind.WindowEnding -> context.getString(R.string.reminder_window_ending_title, beanName)
            ReminderKind.BrewPriority -> context.getString(R.string.reminder_priority_title, beanName)
        }
        val body = when (kind) {
            ReminderKind.RestComplete -> context.getString(R.string.reminder_rest_complete_body, beanName)
            ReminderKind.WindowOpens -> context.getString(R.string.reminder_window_opens_body, beanName)
            ReminderKind.WindowHalfway -> context.getString(R.string.reminder_window_halfway_body, beanName)
            ReminderKind.WindowEnding -> context.getString(R.string.reminder_window_ending_body, beanName)
            ReminderKind.BrewPriority -> context.getString(R.string.reminder_priority_body, beanName)
        }

        val notification = NotificationCompat.Builder(context, ReminderScheduler.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()

        if (ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
        ) {
            manager.notify(NotificationPlanner.notificationId(beanId, kind), notification)
        }
    }
}
