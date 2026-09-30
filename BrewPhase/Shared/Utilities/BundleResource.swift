import Foundation

/// 在 App Bundle 里找一个资源文件。
///
/// 两处都要用（风味模型的 JSON、RAG 的知识库），所以只有一份实现——Bundle 的
/// 资源摆放方式一旦变化，需要修的是一个地方而不是两个。
enum BundleResource {

    /// 先试标准的扁平查找；找不到再递归翻一遍。
    ///
    /// 递归那一遍不是保险起见：Xcode 的「文件系统同步组」会把资源按源目录放进
    /// 子目录（这个工程里就是 `Resources/`），而扁平查找只认 Bundle 根目录。
    /// 两种落法都得能找到，否则换一个 Xcode 版本资源摆法变了，功能就悄悄失效。
    static func url(
        named name: String,
        extensions: [String],
        bundle: Bundle = .main,
        maxDepth: Int = 3
    ) -> URL? {
        for ext in extensions {
            if let url = bundle.url(forResource: name, withExtension: ext) { return url }
        }
        var roots: [URL] = []
        if let resourceURL = bundle.resourceURL { roots.append(resourceURL) }
        roots.append(bundle.bundleURL)
        for root in roots {
            for ext in extensions {
                if let found = search(root, for: "\(name).\(ext)", depth: maxDepth) { return found }
            }
        }
        return nil
    }

    /// 读一个 JSON 资源，返回最外层对象。任何一步失败都返回 nil，由调用方降级。
    static func jsonObject(named name: String, bundle: Bundle = .main) -> [String: Any]? {
        guard let url = url(named: name, extensions: ["json"], bundle: bundle),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json
    }

    private static func search(_ directory: URL, for fileName: String, depth: Int) -> URL? {
        guard depth > 0 else { return nil }
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        for item in contents where item.lastPathComponent == fileName {
            return item
        }
        for item in contents {
            let isDirectory = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDirectory else { continue }
            // `.mlmodelc` 是预编译模型目录，别往里翻，浪费时间也可能误命中。
            guard !item.pathExtension.hasPrefix("mlmodel") else { continue }
            if let found = search(item, for: fileName, depth: depth - 1) { return found }
        }
        return nil
    }
}
