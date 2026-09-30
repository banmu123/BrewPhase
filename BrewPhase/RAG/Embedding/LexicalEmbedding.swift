import Foundation

/// 哈希词法向量：不依赖任何模型，永远可用。
///
/// 这不是「随便给个兜底」。它解决两个真问题：
/// 1. **端侧模型可能不在。** 某些语言在设备上要等系统下载；模型缺失时功能不该
///    整个消失。
/// 2. **数据和查询可能是中英混写的。** 这个 App 里 `origin` 存的就是用户当时
///    界面语言下的原文，同一个库里中英并存。语义模型按语言分空间，词法匹配
///    不分——它按字面切词，中英同一套规则。
///
/// 做法是特征哈希（hashing trick）：把文本切成 token，每个 token 哈希到固定维度的
/// 某一维上，同维不同 token 的碰撞靠正负号互相抵消。没有词表、没有训练、没有
/// 额外内存，而且**同一个字符串永远得到同一个向量**——测试因此可以断言。
struct LexicalEmbeddingProvider: EmbeddingProvider {

    let dimension: Int
    let modelIdentifier: String

    /// 256 维是个折中：再小中文二字组碰撞明显，再大对几百条资料没有收益
    /// （而且向量是要落库的）。
    init(dimension: Int = 256) {
        self.dimension = dimension
        self.modelIdentifier = "brewphase.lexical.hash\(dimension).v1"
    }

    func embed(_ text: String) async -> [Float]? {
        let normalised = Self.normalised(text)
        guard !normalised.isEmpty else { return nil }

        var counts = [Float](repeating: 0, count: dimension)
        for token in Self.tokens(normalised) {
            var hash = Self.offsetBasis
            for byte in token.utf8 {
                hash ^= UInt64(byte)
                hash = hash &* Self.prime
            }
            let index = Int(hash % UInt64(dimension))
            // 符号取哈希的另一位，和下标不相关，所以两个不同 token 撞进同一维时
            // 有大约一半概率互相抵消，而不是同向叠加成假信号。
            let positive = (hash >> 40) & 1 == 0
            counts[index] += positive ? 1 : -1
        }

        // 次线性加权：同一维被反复命中的 token 不该按次数线性放大，否则一条
        // 长记录里反复出现的词会盖过真正区分性的词。
        var vector = [Float](repeating: 0, count: dimension)
        var squared: Float = 0
        for index in counts.indices {
            let magnitude = abs(counts[index])
            guard magnitude > 0 else { continue }
            let weighted = 1 + log(magnitude)
            let value = counts[index] < 0 ? -weighted : weighted
            vector[index] = value
            squared += value * value
        }
        guard squared > 0 else { return nil }
        return vector
    }

    // MARK: - 切词

    /// 全角转半角、转小写。转小写是为了让「Ethiopia」和「ethiopia」是同一个 token。
    static func normalised(_ text: String) -> String {
        let halfWidth = text.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? text
        return halfWidth.lowercased()
    }

    /// 把文本切成 token。
    ///
    /// 分两套规则，因为中英的「词」不是一个东西：
    /// * **汉字**没有空格，所以用**单字 + 二字组**。二字组是关键——「水温」和
    ///   「水量」共享单字「水」，只靠单字区分不开；二字组能。
    /// * **拉丁字母与数字**按连续段切，整段当一个 token。
    static func tokens(_ text: String) -> [String] {
        var tokens: [String] = []
        var cjkRun: [Character] = []
        var latinRun: [Character] = []

        func flushCJK() {
            guard !cjkRun.isEmpty else { return }
            for character in cjkRun { tokens.append(String(character)) }
            if cjkRun.count >= 2 {
                for index in 0..<(cjkRun.count - 1) {
                    tokens.append(String(cjkRun[index...(index + 1)]))
                }
            }
            cjkRun.removeAll()
        }

        func flushLatin() {
            guard !latinRun.isEmpty else { return }
            let token = String(latinRun)
            tokens.append(token)
            // 拉丁词再补一层三字组前缀，让拼写略有差别的词也能沾上边
            // （「grinder」和「grinding」共享「gri」）。
            if token.count >= 4 {
                for index in 0..<(token.count - 2) {
                    let start = token.index(token.startIndex, offsetBy: index)
                    let end = token.index(start, offsetBy: 3)
                    tokens.append(String(token[start..<end]))
                }
            }
            latinRun.removeAll()
        }

        for character in text {
            if character.isCJK {
                flushLatin()
                cjkRun.append(character)
            } else if character.isLetter || character.isNumber {
                flushCJK()
                latinRun.append(character)
            } else {
                flushCJK()
                flushLatin()
            }
        }
        flushCJK()
        flushLatin()
        return tokens
    }

    private static let offsetBasis: UInt64 = 0xcbf2_9ce4_8422_2325
    private static let prime: UInt64 = 0x0000_0100_0000_01b3
}

extension Character {
    /// 是否是汉字。只覆盖 CJK 统一表意文字的常用区，够用且不必引整张 Unicode 表。
    var isCJK: Bool {
        unicodeScalars.contains { scalar in
            (0x4E00...0x9FFF).contains(scalar.value)      // 基本区
                || (0x3400...0x4DBF).contains(scalar.value)  // 扩展 A
                || (0xF900...0xFAFF).contains(scalar.value)  // 兼容表意文字
        }
    }
}
