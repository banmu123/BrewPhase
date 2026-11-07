import XCTest
@testable import BrewPhase

/// 同步模型契约：规范指纹与桌面端 snapshot-importer.ts 必须逐字节一致。
final class SyncModelsTests: XCTestCase {
    func testNumberCanonicalizationMatchesTS() {
        XCTAssertEqual(SyncFingerprint.number(1.0), "1")
        XCTAssertEqual(SyncFingerprint.number(0.5), "0.5")
        XCTAssertEqual(SyncFingerprint.number(1_782_000_000_000), "1782000000000")
        XCTAssertEqual(SyncFingerprint.number(-2.25), "-2.25")
    }

    func testCanonicalSeparatorsAndNulls() {
        XCTAssertEqual(SyncFingerprint.canonical(["a", nil, true, 1]), "a\u{1F}~\u{1F}true\u{1F}1")
    }

    func testFingerprintIsStableSHA256() {
        let a = SyncFingerprint.of(SyncFingerprint.canonical(["x", 1.0]))
        let b = SyncFingerprint.of(SyncFingerprint.canonical(["x", 1]))
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.count, 64)
    }

    func testEpochMillisDefendsSeconds() {
        // 秒值（< 1e11）会被放大成毫秒，正常 Date 不受影响。
        XCTAssertEqual(epochMillis(Date(timeIntervalSince1970: 1_782_000_000)), 1_782_000_000_000)
        XCTAssertNil(epochMillis(nil))
    }

    func testPairingLinkParse() {
        let raw = "brewphase://pair?host=192.168.1.5&port=47821&deviceId=bp_desk_x&deviceName=Mac&pairingCode=AbCdEf123456&protocolVersion=1&expiresAt=1782100000000"
        let link = SyncPairingLink.parse(raw)
        XCTAssertNotNil(link)
        XCTAssertEqual(link?.host, "192.168.1.5")
        XCTAssertEqual(link?.port, 47821)
        XCTAssertEqual(link?.pairingCode, "AbCdEf123456")
        XCTAssertEqual(link?.protocolVersion, 1)

        // 不是我们的 scheme / 缺关键字段 → nil
        XCTAssertNil(SyncPairingLink.parse("brewping://pair?host=x&port=1"))
        XCTAssertNil(SyncPairingLink.parse("brewphase://pair?host=x"))
    }
}
