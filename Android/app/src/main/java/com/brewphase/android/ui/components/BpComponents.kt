package com.brewphase.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.brewphase.android.domain.model.BeanPhase
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing

/** 有标题的一段内容。层次靠间距与字重，不靠卡片阴影。 */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(
        modifier = modifier.fillMaxWidth().padding(top = BpSpacing.xl.dp, bottom = BpSpacing.s.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            color = BpColors.InkSoft,
        )
        trailing?.invoke()
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier = modifier.fillMaxWidth(), thickness = 1.dp, color = BpColors.Hairline)
}

/** 白底、细边、无阴影。整个应用的卡片只有这一种。 */
@Composable
fun BpSurfaceCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val base = modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(BpRadius.l.dp))
        .background(BpColors.Card)
    Box(
        modifier = if (onClick != null) base.clickable(onClick = onClick) else base,
    ) {
        content()
    }
}

@Composable
fun BpTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    singleLine: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text,
    suffix: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = { Text(label, style = MaterialTheme.typography.bodyMedium) },
        placeholder = {
            if (placeholder.isNotEmpty()) {
                Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = BpColors.InkFaint)
            }
        },
        singleLine = singleLine,
        suffix = suffix?.let { { Text(it, style = MaterialTheme.typography.bodyMedium, color = BpColors.InkFaint) } },
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        textStyle = MaterialTheme.typography.bodyLarge,
        shape = RoundedCornerShape(BpRadius.m.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = BpColors.Card,
            unfocusedContainerColor = BpColors.Well,
            focusedBorderColor = BpColors.Roast,
            unfocusedBorderColor = Color.Transparent,
            focusedTextColor = BpColors.Ink,
            unfocusedTextColor = BpColors.Ink,
            focusedLabelColor = BpColors.InkSoft,
            unfocusedLabelColor = BpColors.InkSoft,
            cursorColor = BpColors.Roast,
        ),
    )
}

@Composable
fun BpPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().height(52.dp),
        enabled = enabled,
        shape = RoundedCornerShape(BpRadius.m.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = BpColors.Espresso,
            contentColor = Color.White,
            disabledContainerColor = BpColors.Hairline,
            disabledContentColor = BpColors.InkFaint,
        ),
    ) {
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

/** 小标签：低饱和描边，不用彩色底。 */
@Composable
fun BpTag(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(BpRadius.pill.dp))
            .background(BpColors.Well)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = BpColors.InkSoft)
    }
}

@Composable
fun BpEmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = BpSpacing.xl.dp, vertical = BpSpacing.xxxl.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = BpColors.Ink)
        Spacer(Modifier.height(BpSpacing.s.dp))
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = BpColors.InkFaint,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

/** 阶段圆点 + 名称。颜色只表达状态。 */
@Composable
fun PhaseDot(phase: BeanPhase, modifier: Modifier = Modifier) {
    val color = when (phase) {
        BeanPhase.Resting -> BpColors.Resting
        BeanPhase.Opening -> BpColors.Opening
        BeanPhase.Peak -> BpColors.Peak
        BeanPhase.Declining -> BpColors.Declining
    }
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(
            text = phaseLabel(phase),
            style = MaterialTheme.typography.labelSmall,
            color = BpColors.InkSoft,
        )
    }
}

@Composable
fun phaseLabel(phase: BeanPhase): String = when (phase) {
    BeanPhase.Resting -> androidx.compose.ui.res.stringResource(com.brewphase.android.R.string.phase_resting)
    BeanPhase.Opening -> androidx.compose.ui.res.stringResource(com.brewphase.android.R.string.phase_opening)
    BeanPhase.Peak -> androidx.compose.ui.res.stringResource(com.brewphase.android.R.string.phase_peak)
    BeanPhase.Declining -> androidx.compose.ui.res.stringResource(com.brewphase.android.R.string.phase_declining)
}

/** 一行「标签 · 标签」。空则不占位。 */
@Composable
fun TagLine(tags: List<String>, modifier: Modifier = Modifier, max: Int = 3) {
    if (tags.isEmpty()) return
    val shown = tags.take(max)
    val extra = tags.size - shown.size
    Text(
        text = buildString {
            append(shown.joinToString(" · "))
            if (extra > 0) append(" +$extra")
        },
        modifier = modifier,
        style = MaterialTheme.typography.labelSmall,
        color = BpColors.InkFaint,
    )
}

/** 数值格式化：整数不带小数点，其余一位。 */
fun formatGrams(value: Double): String =
    if (value % 1.0 == 0.0) value.toInt().toString() else "%.1f".format(value)

fun formatNumber(value: Double): String =
    if (value % 1.0 == 0.0) value.toInt().toString() else "%.1f".format(value)

@Composable
fun KeyValueRow(key: String, value: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = BpSpacing.s.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
    ) {
        Text(key, style = MaterialTheme.typography.bodyMedium, color = BpColors.InkFaint)
        Spacer(Modifier.width(BpSpacing.l.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyLarge,
            color = BpColors.Ink,
            fontWeight = FontWeight.Normal,
        )
    }
}
