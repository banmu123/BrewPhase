import XCTest
@testable import BrewPhase

/// §39: ratio arithmetic, the stock deduction, and the validation messages that
/// stand between a user and a nonsense record.
final class BrewMathTests: XCTestCase {

    /// The validation copy is localised, so these assertions pin the language
    /// instead of asserting against whatever the test machine happens to use.
    /// Pinning also means a typo in a *key* fails the test, which it would not if
    /// the expectation were written as `L("…")`.
    override func setUp() {
        super.setUp()
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    // MARK: - Ratio

    func testRatioValueAndText() {
        XCTAssertEqual(BrewMath.ratioValue(coffeeG: 18, waterG: 300), 300.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(Fmt.ratio(coffeeG: 18, waterG: 288), "1:16")
        XCTAssertEqual(Fmt.ratio(coffeeG: 18, waterG: 300), "1:16.7")
        XCTAssertEqual(Fmt.ratio(coffeeG: 0, waterG: 300), "—")
        XCTAssertEqual(Fmt.ratio(coffeeG: 18, waterG: 0), "—")
    }

    func testWaterAndCoffeeFromRatio() {
        XCTAssertEqual(BrewMath.water(coffeeG: 18, ratio: 16), 288)
        XCTAssertEqual(BrewMath.water(coffeeG: 0, ratio: 16), 0)
        XCTAssertEqual(BrewMath.coffee(waterG: 300, ratio: 16.7), 18, accuracy: 0.05)
        XCTAssertEqual(BrewMath.coffee(waterG: 0, ratio: 16), 0)
    }

    // MARK: - Time

    func testTimeFormatting() {
        XCTAssertEqual(BrewMath.formatTime(155), "2:35")
        XCTAssertEqual(BrewMath.formatTime(45), "0:45")
        XCTAssertEqual(BrewMath.formatTime(60), "1:00")
        XCTAssertEqual(BrewMath.formatTime(0), "")
    }

    func testTimeParsingAcceptsTheWaysPeopleActuallyTypeIt() {
        XCTAssertEqual(BrewMath.parseTime("2:35"), 155)
        XCTAssertEqual(BrewMath.parseTime("2：35"), 155)   // full-width colon
        XCTAssertEqual(BrewMath.parseTime("155"), 155)
        XCTAssertEqual(BrewMath.parseTime("2.35"), 155)
        XCTAssertEqual(BrewMath.parseTime(" 1:05 "), 65)
    }

    func testTimeParsingRejectsNonsenseInsteadOfInventingSeconds() {
        XCTAssertNil(BrewMath.parseTime(""))
        XCTAssertNil(BrewMath.parseTime("abc"))
        XCTAssertNil(BrewMath.parseTime("2:75"))    // 75 seconds is not a thing
        XCTAssertNil(BrewMath.parseTime("-3"))
        XCTAssertNil(BrewMath.parseTime("1:2:3"))
    }

    func testTimeRoundTrips() {
        for seconds in [5, 45, 60, 155, 600] {
            XCTAssertEqual(BrewMath.parseTime(BrewMath.formatTime(seconds)), seconds)
        }
    }

    // MARK: - Stock (§32)

    func testRemainingAfterADose() {
        XCTAssertEqual(BrewMath.remainingAfter(current: 86, dose: 18, total: 200), 68, accuracy: 0.001)
    }

    func testRemainingNeverGoesNegative() {
        XCTAssertEqual(BrewMath.remainingAfter(current: 10, dose: 18, total: 200), 0, accuracy: 0.001)
    }

    func testRemainingNeverExceedsTheBag() {
        // A negative dose (a correction that adds coffee back) cannot inflate the bag.
        XCTAssertEqual(BrewMath.remainingAfter(current: 100, dose: -50, total: 200), 150, accuracy: 0.001)
        XCTAssertEqual(BrewMath.remainingAfter(current: 100, dose: -500, total: 200), 200, accuracy: 0.001)
    }

    func testScoreIsClamped() {
        XCTAssertEqual(BrewMath.clampScore(0), 0)
        XCTAssertEqual(BrewMath.clampScore(3), 3)
        XCTAssertEqual(BrewMath.clampScore(5), 5)
        XCTAssertEqual(BrewMath.clampScore(9), 5)
        XCTAssertEqual(BrewMath.clampScore(-2), 0)
    }

    // MARK: - Brew validation

    func testABrewWithNoDoseCannotBeSaved() {
        var recipe = BrewRecipe.empty
        recipe.waterG = 300
        let result = BrewMath.validate(recipe)
        XCTAssertFalse(result.canSave)
        XCTAssertEqual(result.blocking.first, "先填粉量吧，这样才能从库存里扣掉")
    }

    func testMissingOptionalNumbersAreHintsNotErrors() {
        var recipe = BrewRecipe.empty
        recipe.coffeeG = 18
        let result = BrewMath.validate(recipe)
        XCTAssertTrue(result.canSave)
        XCTAssertTrue(result.hints.contains("水量还没填，粉水比会留空"))
        XCTAssertTrue(result.hints.contains("水温还没填"))
        XCTAssertTrue(result.hints.contains("冲煮时间还没填"))
    }

    func testACompleteRecipeHasNothingToSay() {
        var recipe = BrewRecipe.empty
        recipe.coffeeG = 18
        recipe.waterG = 300
        recipe.waterTemp = 92
        recipe.timeSeconds = 155
        XCTAssertTrue(BrewMath.validate(recipe).isEmpty)
    }

    // MARK: - Bean validation

    func testABeanNeedsANameARoastDateAndAWeight() {
        let result = BrewMath.validateBean(name: "  ", roastDate: nil, weightG: 0, remainingG: 0)
        XCTAssertFalse(result.canSave)
        XCTAssertEqual(result.blocking, [
            "给它起个名字吧",
            "烘焙日期还没选，风味阶段要靠它来算",
            "总克数要大于 0",
        ])
    }

    func testNegativeRemainingIsRefusedAndClamped() {
        let result = BrewMath.validateBean(name: "A", roastDate: Date(), weightG: 200, remainingG: -5)
        XCTAssertFalse(result.canSave)
        XCTAssertTrue(result.blocking.contains("剩余克数不能是负数"))
        XCTAssertEqual(result.remainingG, 0)
    }

    func testRemainingHeavierThanTheBagWidensTheBagInsteadOfRefusing() {
        // Real bags are sometimes heavier than the number printed on them.
        let result = BrewMath.validateBean(name: "A", roastDate: Date(), weightG: 200, remainingG: 255)
        XCTAssertTrue(result.canSave)
        XCTAssertEqual(result.weightG, 255)
        XCTAssertEqual(result.hints.first, "剩余量比总克数还多，已把总克数调到 255g")
    }

    func testAnOrdinaryBeanPassesQuietly() {
        let result = BrewMath.validateBean(name: "Guji", roastDate: Date(), weightG: 200, remainingG: 200)
        XCTAssertTrue(result.canSave)
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - Recipe copy (§13)

    func testCopyingARecipeCarriesExactlyTheRepeatableParameters() {
        let brew = Brew(date: Date(), method: "V60", grinder: "C40", grindSize: "22",
                        waterTemp: 92, coffeeG: 18, waterG: 300, timeSeconds: 155,
                        score: 5, notes: "great")
        let recipe = brew.recipe
        XCTAssertEqual(recipe.method, "V60")
        XCTAssertEqual(recipe.grinder, "C40")
        XCTAssertEqual(recipe.grindSize, "22")
        XCTAssertEqual(recipe.waterTemp, 92)
        XCTAssertEqual(recipe.coffeeG, 18)
        XCTAssertEqual(recipe.waterG, 300)
        XCTAssertEqual(recipe.timeSeconds, 155)
        // Verdicts are not recipes: a new cup starts unrated.
        XCTAssertFalse(recipe.isEmpty)
        XCTAssertTrue(BrewRecipe.empty.isEmpty)
    }

    func testRecipeSummaryReadsLikeARecipe() {
        let recipe = BrewRecipe(method: "V60", grinder: "C40", grindSize: "22",
                               waterTemp: 92, coffeeG: 18, waterG: 300, timeSeconds: 155)
        XCTAssertEqual(recipe.summaryParts.joined(separator: " · "), "V60 · 18g / 300g · 92°C · 2:35")
    }

    func testBrewDerivedFieldsAgreeWithTheirInputs() {
        let brew = Brew(coffeeG: 18, waterG: 288, timeSeconds: 155)
        XCTAssertEqual(brew.ratioText, "1:16")
        XCTAssertEqual(brew.timeText, "2:35")
        XCTAssertEqual(brew.doseLine, "18g / 288g")
    }
}
