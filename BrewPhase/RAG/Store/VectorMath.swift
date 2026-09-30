import Accelerate
import Foundation

/// 向量算术。
///
/// 为什么用 Accelerate 而不是手写循环：余弦相似度是这一层唯一的热点——每个
/// 查询都要跟索引里每一条算一遍。`vDSP_dotpr` 会把这件事交给 SIMD 指令，
/// 在几百条的规模上它把一次检索从几毫秒压到零点几毫秒。
enum VectorMath {

    /// L2 归一化。
    ///
    /// 索引里存的向量**一律是单位向量**，所以检索时相似度就等于点积——省掉每次
    /// 比对都要算的两个模长。零向量原样返回（它归一化不了，也不该归一化）。
    static func normalised(_ vector: [Float]) -> [Float] {
        guard !vector.isEmpty else { return vector }
        var sum: Float = 0
        vDSP_svesq(vector, 1, &sum, vDSP_Length(vector.count))
        let norm = sum.squareRoot()
        guard norm > 0, norm.isFinite else { return vector }
        var scale = 1 / norm
        var result = [Float](repeating: 0, count: vector.count)
        vDSP_vsmul(vector, 1, &scale, &result, 1, vDSP_Length(vector.count))
        return result
    }

    /// 点积。两个单位向量的点积就是余弦相似度，落在 -1…1。
    static func dot(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var result: Float = 0
        vDSP_dotpr(a, 1, b, 1, &result, vDSP_Length(a.count))
        return result.isFinite ? result : 0
    }

    // MARK: - 落库

    /// `[Float]` → `Data`，按 IEEE 754 单精度小端存储。
    static func pack(_ vector: [Float]) -> Data {
        guard !vector.isEmpty else { return Data() }
        return vector.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    /// `Data` → `[Float]`。
    ///
    /// 逐字节读而不是 `bindMemory`：从库里取出来的 `Data` 不保证 4 字节对齐，
    /// 而 `bindMemory` 在对齐不满足时是未定义行为。`loadUnaligned` 明确允许
    /// 未对齐访问，代价只是这里多一次拷贝——只有建索引和加载缓存时走这条路。
    static func unpack(_ data: Data) -> [Float] {
        let stride = MemoryLayout<Float>.size
        let count = data.count / stride
        guard count > 0 else { return [] }
        var vector = [Float](repeating: 0, count: count)
        data.withUnsafeBytes { raw in
            for index in 0..<count {
                vector[index] = raw.loadUnaligned(fromByteOffset: index * stride, as: Float.self)
            }
        }
        return vector
    }
}
