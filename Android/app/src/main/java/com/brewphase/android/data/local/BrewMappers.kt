package com.brewphase.android.data.local

import com.brewphase.android.core.TagCodec
import com.brewphase.android.domain.engine.BrewRecipe
import com.brewphase.android.domain.model.BrewRecord
import com.brewphase.android.domain.model.TasteProfile
import com.brewphase.android.domain.model.TastingRecord
import com.brewphase.android.domain.model.TastingSource

fun BrewEntity.toRecord(): BrewRecord = BrewRecord(
    id = id,
    beanId = beanId,
    dateMillis = dateMillis,
    recipe = BrewRecipe(
        method = method,
        grinder = grinder,
        grindSize = grindSize,
        waterTemp = waterTemp,
        coffeeG = coffeeG,
        waterG = waterG,
        timeSeconds = timeSeconds,
    ),
    score = score,
    taste = TasteProfile(acidity, sweetness, bitterness, body, aftertaste),
    flavorTags = TagCodec.decode(flavorTagsRaw),
    notes = notes,
    createdAtMillis = createdAtMillis,
    stockDeductedG = stockDeductedG,
)

fun TastingEntity.toRecord(): TastingRecord = TastingRecord(
    id = id,
    beanId = beanId,
    dateMillis = dateMillis,
    dayAfterRoast = dayAfterRoast,
    flavorTags = TagCodec.decode(flavorTagsRaw),
    score = score,
    notes = notes,
    source = TastingSource.fromRaw(sourceRaw),
    brewId = brewId,
    createdAtMillis = createdAtMillis,
)
