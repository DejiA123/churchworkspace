import Foundation
#if canImport(Darwin)
import Darwin
#endif

/*
 * THE OTHER HALF OF THE ANSWER.
 *
 * This app can edit a sermon entirely on the phone — that is the point of the
 * Engine folder. But a phone is not a workstation: a 90-minute service still
 * takes a phone several minutes to reframe and encode, and it will do it with
 * the battery and the heat that implies.
 *
 * So the app also speaks to Phone Studio, the HTTP surface the Windows/macOS
 * app opens on the church wifi (src/main/mobile-api.js). Paired, the SAME
 * screens drive the PC instead of the phone: the PC's ffmpeg does the encoding
 * at full speed and hands the finished clip back. Off the wifi, the app falls
 * back to its own engine and keeps working on a train.
 *
 * One app, two engines, and the user only ever sees a "Use my PC" switch.
 */

struct RemoteEnvelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: String?
    let cancelled: Bool?
}

struct RemoteVideo: Decodable, Identifiable, Hashable {
    let path: String
    let name: String
    let size: Int64
    let mtime: Double
    var id: String { path }
}

struct RemoteVideoGroup: Decodable, Identifiable, Hashable {
    let key: String
    let label: String
    let files: [RemoteVideo]
    var id: String { key }
}

struct RemoteHello: Decodable {
    let ok: Bool
    let name: String
    let version: String
    let needsPin: Bool
    let allowUpload: Bool
    let paired: Bool
}

enum RemoteError: LocalizedError {
    case notPaired
    case badPin(String)
    case unreachable
    case studio(String)

    var errorDescription: String? {
        switch self {
        case .notPaired: return "Pair with your PC first."
        case .badPin(let why): return why
        case .unreachable: return "Could not reach the workstation. Is the PC on and on this wifi?"
        case .studio(let why): return why
        }
    }
}

/// Talks to one workstation.
actor RemoteClient {

    private(set) var host: String
    private(set) var token: String?
    private let session: URLSession

    init(host: String, token: String? = nil) {
        self.host = host
        self.token = token
        let config = URLSessionConfiguration.default
        // A short is minutes of encoding on the PC with no bytes moving on this
        // socket; the default 60-second timeout would abandon a perfectly
        // healthy export.
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 7200
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config)
    }

    private var base: URL? { URL(string: host.hasPrefix("http") ? host : "http://\(host)") }

    // MARK: - pairing

    func hello() async throws -> RemoteHello {
        guard let base else { throw RemoteError.unreachable }
        var req = URLRequest(url: base.appendingPathComponent("api/hello"))
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        guard let (data, _) = try? await session.data(for: req) else { throw RemoteError.unreachable }
        guard let hello = try? JSONDecoder().decode(RemoteHello.self, from: data) else { throw RemoteError.unreachable }
        return hello
    }

    func pair(pin: String) async throws {
        guard let base else { throw RemoteError.unreachable }
        var req = URLRequest(url: base.appendingPathComponent("api/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["pin": pin])
        guard let (data, response) = try? await session.data(for: req) else { throw RemoteError.unreachable }
        struct Reply: Decodable { let token: String?; let error: String? }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let t = reply.token else {
            throw RemoteError.badPin(reply.error ?? "That PIN was not accepted.")
        }
        token = t
    }

    func unpair() { token = nil }
    var isPaired: Bool { token != nil }

    // MARK: - calls

    /// One call into the workstation's Video Studio. `channel` is the same IPC
    /// name the desktop renderer uses; the PC's allowlist decides what a phone
    /// may ask for.
    func call<T: Decodable>(_ channel: String, _ args: [String: Any] = [:], as: T.Type) async throws -> T {
        guard let base else { throw RemoteError.unreachable }
        guard let token else { throw RemoteError.notPaired }
        var req = URLRequest(url: base.appendingPathComponent("api/rpc"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["channel": channel, "args": args])

        guard let (data, response) = try? await session.data(for: req) else { throw RemoteError.unreachable }
        if (response as? HTTPURLResponse)?.statusCode == 401 { self.token = nil; throw RemoteError.notPaired }
        let envelope = try JSONDecoder().decode(RemoteEnvelope<T>.self, from: data)
        if envelope.cancelled == true { throw CancellationError() }
        guard envelope.ok, let value = envelope.data else {
            throw RemoteError.studio(envelope.error ?? "The workstation refused that request.")
        }
        return value
    }

    /// For handlers whose reply is a bare path string.
    func callPath(_ channel: String, _ args: [String: Any] = [:]) async throws -> String {
        try await call(channel, args, as: String.self)
    }

    func videos() async throws -> [RemoteVideoGroup] {
        guard let base, let token else { throw RemoteError.notPaired }
        var req = URLRequest(url: base.appendingPathComponent("api/videos"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await session.data(for: req) else { throw RemoteError.unreachable }
        struct Reply: Decodable { let ok: Bool; let groups: [RemoteVideoGroup] }
        return try JSONDecoder().decode(Reply.self, from: data).groups
    }

    /// A URL this phone can stream from, for the scrubbing preview.
    func mediaURL(for path: String) -> URL? {
        guard let base, let token else { return nil }
        var comps = URLComponents(url: base.appendingPathComponent("api/media"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "p", value: path), URLQueryItem(name: "k", value: token)]
        return comps?.url
    }

    /// Pull a finished export down onto the phone so it can go in the camera roll.
    func download(path: String, progress: ((Double) -> Void)? = nil) async throws -> URL {
        guard let base, let token else { throw RemoteError.notPaired }
        var comps = URLComponents(url: base.appendingPathComponent("api/file"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "p", value: path), URLQueryItem(name: "k", value: token)]
        guard let url = comps?.url else { throw RemoteError.unreachable }
        let (tempURL, _) = try await session.download(from: url)
        let name = (path as NSString).lastPathComponent
        let dest = AppFolders.exports.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tempURL, to: dest)
        progress?(1)
        return dest
    }

    /// Send a recording from this phone to the PC.
    func upload(fileURL: URL, name: String) async throws -> String {
        guard let base, let token else { throw RemoteError.notPaired }
        var comps = URLComponents(url: base.appendingPathComponent("api/upload"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "name", value: name)]
        guard let url = comps?.url else { throw RemoteError.unreachable }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await session.upload(for: req, fromFile: fileURL)
        struct Reply: Decodable { let ok: Bool?; let path: String?; let error: String? }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard let path = reply.path else { throw RemoteError.studio(reply.error ?? "Upload failed.") }
        return path
    }

    /// Kill a running job on the PC.
    func cancel(jobId: String) async {
        _ = try? await call("job:cancel", ["id": jobId], as: CancelReply.self)
    }
    struct CancelReply: Decodable { let cancelled: Bool?; let killed: Int? }

    // MARK: - discovery

    /// Workstations advertise nothing, so finding one is a sweep of the phone's
    /// own /24 for the Phone Studio greeting. Ninety usable addresses at a
    /// 350 ms timeout, twenty at a time — about two seconds on a church wifi,
    /// and far kinder than asking someone to read an IP off a monitor.
    static func discover(port: Int = 7380, timeout: TimeInterval = 0.35) async -> [String] {
        guard let localIP = LocalNetwork.ipv4Address() else { return [] }
        let parts = localIP.split(separator: ".")
        guard parts.count == 4 else { return [] }
        let prefix = parts.prefix(3).joined(separator: ".")

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let probe = URLSession(configuration: config)

        return await withTaskGroup(of: String?.self) { group in
            var found: [String] = []
            var next = 1
            let maxParallel = 20

            func addTask(_ i: Int) {
                let host = "\(prefix).\(i)"
                group.addTask {
                    guard let url = URL(string: "http://\(host):\(port)/api/hello") else { return nil }
                    guard let (data, _) = try? await probe.data(from: url),
                          let hello = try? JSONDecoder().decode(RemoteHello.self, from: data),
                          hello.ok else { return nil }
                    return "\(host):\(port)"
                }
            }
            while next <= min(maxParallel, 254) { addTask(next); next += 1 }
            for await result in group {
                if let result { found.append(result) }
                if next <= 254 { addTask(next); next += 1 }
            }
            return found.sorted()
        }
    }
}

/// This device's own address on the wifi, so a scan knows which /24 to sweep.
enum LocalNetwork {
    static func ipv4Address() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }
        var result: String?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }
            guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ptr.pointee.ifa_name)
            // en0 is wifi on a phone; en1/en2 show up on a Mac running the tests.
            guard name.hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count),
                           nil, 0, NI_NUMERICHOST) == 0 {
                result = String(cString: host)
                break
            }
        }
        return result
    }
}
