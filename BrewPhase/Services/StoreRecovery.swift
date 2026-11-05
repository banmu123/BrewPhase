import Foundation

/// 数据库打不开时的最后一条出口：把**原始数据库文件**复制出来交给用户。
///
/// 为什么不是「导出成 JSON」：JSON 导出要先打开数据库，而这里的全部前提就是
/// 打不开。能拿到的只有那三个文件（`.store` 与它的 `-wal` / `-shm` 旁路日志），
/// 它们合起来才是完整数据——少一个 `-wal`，最近几次记录就不在里面。
///
/// 只复制，不移动、不删除：恢复页上的任何动作都不该让原始文件先消失。
enum StoreRecovery {

    enum Failure: Error, Equatable {
        /// 应用支持目录里没有数据库文件——没什么可导出的。
        case noStore
        case copyFailed
    }

    /// SwiftData 默认容器在这个目录下建库（`ModelConfiguration` 不指定 URL 时）。
    static let storeFileName = "default.store"

    /// SQLite 的预写日志与共享内存文件。它们不是可选的：只拿主文件会丢掉
    /// 最近一次检查点之后的写入。
    static let sidecarSuffixes = ["-wal", "-shm"]

    static var applicationSupport: URL {
        URL.applicationSupportDirectory
    }

    /// 当前存在的数据库文件，主文件在前。
    static func storeFiles(in directory: URL = applicationSupport) -> [URL] {
        let names = [storeFileName] + sidecarSuffixes.map { storeFileName + $0 }
        return names
            .map { directory.appending(path: $0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// 把数据库文件整组复制到 `destination/<时间戳>/`，返回那个目录。
    ///
    /// 目标目录已存在时直接失败，不覆盖：同名目录里可能已经有一份用户的
    /// 旧数据，覆盖比没有更糟。
    @discardableResult
    static func archive(
        in directory: URL = applicationSupport,
        to destination: URL,
        now: Date = Date()
    ) throws -> URL {
        let files = storeFiles(in: directory)
        guard files.contains(where: { $0.lastPathComponent == storeFileName }) else {
            throw Failure.noStore
        }

        let fileManager = FileManager.default
        let folder = destination.appending(path: folderName(now: now), directoryHint: .isDirectory)

        // 建目录单独处理：目标已存在说明里面可能是一份旧的导出，绝不能因为
        // 「这次没写成」就把它删掉。
        do {
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: false)
        } catch {
            throw Failure.copyFailed
        }

        do {
            for file in files {
                try fileManager.copyItem(at: file, to: folder.appending(path: file.lastPathComponent))
            }
        } catch {
            // 这里是**本次新建**的半成品目录，清掉它才对。
            try? fileManager.removeItem(at: folder)
            throw Failure.copyFailed
        }

        AppLog.store.info("store files exported: \(files.count) file(s)")
        return folder
    }

    /// `brewphase-store-20261104-143012`。文件名保持 ASCII：它会被写进
    /// 分享面板与「文件」App，中文名在不同导出路径上会被转义成一串百分号。
    static func folderName(now: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "brewphase-store-\(formatter.string(from: now))"
    }
}
