# BrewPhase Desktop 无混淆需求；保留 Room / 序列化反射所需元数据。
-keepattributes *Annotation*, InnerClasses
-keep class com.brewphase.android.data.local.** { *; }
-keep class com.brewphase.android.data.backup.dto.** { *; }
