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

    func testPairingLinkHostsCandidates() {
        // 多网卡：host 是首选，hosts 是全部候选（含 host 本身、去重去空）
        let raw = "brewphase://pair?host=192.168.1.5&hosts=192.168.1.5,10.0.0.8,192.168.1.5,&port=47821&deviceId=d&deviceName=Mac&pairingCode=AbCdEf123456&protocolVersion=1&expiresAt=1782100000000"
        let link = SyncPairingLink.parse(raw)
        XCTAssertNotNil(link)
        XCTAssertEqual(link?.candidateHosts, ["192.168.1.5", "10.0.0.8"])
        // 没有 hosts 参数时退化为单 host
        let single = SyncPairingLink.parse(
            "brewphase://pair?host=192.168.1.9&port=47821&deviceId=d&deviceName=Mac&pairingCode=AbCdEf123456&protocolVersion=1&expiresAt=1782100000000"
        )
        XCTAssertEqual(single?.candidateHosts, ["192.168.1.9"])
    }

    /// 回归（2026-11-07 真机崩溃）：SyncBatch 必须走 JSONEncoder 且键名与
    /// 桌面端一致；JSONSerialization 遇到 Swift struct 会抛无法捕获的
    /// NSException（「开始同步即闪退」的根因）。
    func testSyncBatchEncodesWithTSCompatibleKeys() throws {
        let batch = SyncBatch(operations: [SyncOperation(
            entityType: "bean",
            upserts: [SyncUpsert(id: "id-1", fingerprint: "fp-1", payload: ["name": .string("豆子"), "remainingG": .double(158)])],
            deletes: [SyncDelete(id: "id-2", expectedFingerprint: "fp-old")]
        )])
        let data = try JSONEncoder().encode(batch)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let operation = try XCTUnwrap((object["operations"] as? [[String: Any]])?.first)
        XCTAssertEqual(operation["entityType"] as? String, "bean")
        let upsert = try XCTUnwrap((operation["upserts"] as? [[String: Any]])?.first)
        XCTAssertEqual(upsert["id"] as? String, "id-1")
        XCTAssertEqual(upsert["fingerprint"] as? String, "fp-1")
        XCTAssertEqual((upsert["payload"] as? [String: Any])?["name"] as? String, "豆子")
        let deletion = try XCTUnwrap((operation["deletes"] as? [[String: Any]])?.first)
        XCTAssertEqual(deletion["id"] as? String, "id-2")
        XCTAssertEqual(deletion["expectedFingerprint"] as? String, "fp-old")
    }

    /// 回归（2026-11-07 真机）：epochMillis 的 Int64? 必须保留为 JSON 数字，
    /// 不能因 AnyCodableValue.init 缺 Int64 分支静默变 null（record_tags
    /// created_at NOT NULL 失败的根因）。
    func testAnyCodableValuePreservesInt64Timestamps() throws {
        let value = AnyCodableValue(epochMillis(Date(timeIntervalSince1970: 1_782_000_000)))
        let data = try JSONEncoder().encode(["t": value])
        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"t":1782000000000}"#)
        // 可空时间戳为 nil 时才是显式 null
        let nilValue = AnyCodableValue(epochMillis(nil))
        let nilData = try JSONEncoder().encode(["t": nilValue])
        XCTAssertEqual(String(data: nilData, encoding: .utf8), #"{"t":null}"#)
    }
}
