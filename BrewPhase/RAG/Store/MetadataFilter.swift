import Foundation

/// 向量检索的附加条件（协议 §7 第三层）。
///
/// 为什么这一层不能省：只用相似度排序时，「我这包豆之前什么时候冲得最好」会去
/// 和**所有**记录比相似度，其它豆子的高分记录会挤进来——它们和这句话很像，但不
/// 是问题的答案。加上 `beanID` 之后，检索范围先被收窄到正确的对象上。
///
/// 每一项都是可选的，空过滤器表示不筛。`.` 空过滤器在实现里走的是「直接返回 true」
/// 的快路径，不给每次检索都加一遍无谓的判断。
struct MetadataFilter: Equatable, Sendable {

    var sourceTypes: Set<KnowledgeSourceType> = []
    var beanID: UUID?
    var brewID: UUID?
    /// 冲煮方式的可选写法。空表示不筛。
    ///
    /// 是数组而不是单个字符串：`Brew.method` 是自由文本，同一件事在库里可能写作
    /// 「爱乐压」也可能写作「AeroPress」，而用户提问时用的是其中一种。多个写法
    /// 之间是「或」——命中一个就算。
    var methods: [String] = []
    /// 磨豆机的可选写法。同样的道理：「C40」和「司令官 C40」是同一台。
    var devices: [String] = []
    /// 处理法的可选写法。理由同上：库里存的是用户当时界面语言下的文本。
    var processes: [String] = []
    /// 产地关键词。
    ///
    /// 这一项不是从词典来的，而是**从用户自己的豆子列表里反推**的（见
    /// `RuleQueryAnalyzer`）——没有外部产区表可用，也不该为了这个引一张进来。
    var origins: [String] = []
    /// 知识实体筛选（规格 §十五）。命中任一即算——和上面几项同一个「或」语义。
    ///
    /// 它比 `origins` 那类**子串匹配**强一个量级：`origins` 比的是自由文本，
    /// 「埃塞俄比亚 · Guji」和「Ethiopia Guji」只能靠字面沾边；实体 id 是归一过的
    /// 稳定标识，`origin.ethiopia` 就是它自己。Bean→Knowledge Linking 走这条。
    var entityIDs: [String] = []
    /// 适用范围筛选（规格 §十三）。空表示不筛。
    var scopes: [String] = []
    var dateRange: ClosedRange<Date>?
    var dayAfterRoast: ClosedRange<Int>?
    var minimumScore: Int?
    var maximumScore: Int?

    static let none = MetadataFilter()

    var isEmpty: Bool { self == .none }

    /// 一条资料是否满足全部条件。
    func matches(_ passage: StoredPassage) -> Bool {
        if !sourceTypes.isEmpty, !sourceTypes.contains(passage.sourceType) { return false }

        let metadata = passage.metadata
        if let beanID, metadata.beanID != beanID { return false }
        if let brewID, metadata.brewID != brewID { return false }

        if !methods.isEmpty,
           !methods.contains(where: { MetadataFilter.text(metadata.method, contains: $0) }) { return false }
        if !devices.isEmpty,
           !devices.contains(where: { MetadataFilter.text(metadata.grinder, contains: $0) }) { return false }
        if !processes.isEmpty,
           !processes.contains(where: { MetadataFilter.text(metadata.process, contains: $0) }) { return false }
        if !origins.isEmpty,
           !origins.contains(where: { MetadataFilter.text(metadata.origin, contains: $0) }) { return false }

        // 实体筛选是**集合相交**，不是子串：文档带的是 `entityIds`（可能多个），
        // 过滤条件是「豆子解析出的实体」（也可能多个），任一对上就算命中。
        if !entityIDs.isEmpty {
            let owned = Set(metadata.entityIds ?? [])
            if owned.isDisjoint(with: entityIDs) { return false }
        }
        if !scopes.isEmpty {
            guard let scope = metadata.scope, scopes.contains(scope) else { return false }
        }

        if let dateRange {
            guard let date = metadata.docDate, dateRange.contains(date) else { return false }
        }
        if let dayAfterRoast {
            guard let day = metadata.dayAfterRoast, dayAfterRoast.contains(day) else { return false }
        }
        // 打分区间按「没打分 = 不参与」处理：`score == 0` 在 App 里是「没打分」，
        // 把它算成 0 分会让「我打过 4 分以上的豆子」把这些都漏掉。
        if minimumScore != nil || maximumScore != nil {
            guard let score = metadata.score, score > 0 else { return false }
            if let minimumScore, score < minimumScore { return false }
            if let maximumScore, score > maximumScore { return false }
        }
        return true
    }

    /// 自由文本的包含判断。
    ///
    /// 两边都做全角转半角 + 转小写 + 去空白，因为 App 里 `origin` 存的是
    /// 「埃塞俄比亚 · Guji」这种混写串，而用户问的时候可能只说「Guji」。
    static func text(_ value: String?, contains needle: String) -> Bool {
        guard let value else { return false }
        let haystack = normalised(value)
        let target = normalised(needle)
        guard !target.isEmpty else { return true }
        return haystack.contains(target)
    }

    static func normalised(_ text: String) -> String {
        LexicalEmbeddingProvider.normalised(text)
            .filter { !$0.isWhitespace }
    }
}
