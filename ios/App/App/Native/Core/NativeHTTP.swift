//
//  NativeHTTP.swift — URLSession for the core: no CORS, no CORP, real total timeouts, shared cookie
//  jar (so cookies a Cloudflare check left in WKWebView, copied by BrowserFetcher, apply here too).
//  Request/response JSON shapes: NativeHttpRequest / NativeHttpResponse in src/core/native-api.ts.
//

import Foundation

final class NativeHTTP {
    struct Request: Decodable {
        let url: String
        let method: String?
        let headers: [String: String]?
        let body: String?
        let timeoutMs: Double?
        let responseType: String?
    }

    enum HTTPError: LocalizedError {
        case badRequest(String)
        case timedOut(String)
        case transport(String)
        var errorDescription: String? {
            switch self {
            case .badRequest(let m): return "Bad request: \(m)"
            case .timedOut(let u): return "Request timed out: \(u)"
            case .transport(let m): return m
            }
        }
    }

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        cfg.requestCachePolicy = .useProtocolCachePolicy
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 180
        cfg.httpMaximumConnectionsPerHost = 4
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    func perform(json: String, completion: @escaping (Result<String, Error>) -> Void) {
        let req: Request
        do { req = try JSONDecoder().decode(Request.self, from: Data(json.utf8)) } catch {
            return completion(.failure(HTTPError.badRequest("unparseable request")))
        }
        guard let url = URL(string: req.url), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return completion(.failure(HTTPError.badRequest("invalid URL \(req.url)")))
        }
        let timeout = max(1, (req.timeoutMs ?? 15_000) / 1000)
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = (req.method ?? "GET").uppercased()
        for (k, v) in req.headers ?? [:] { request.setValue(v, forHTTPHeaderField: k) }
        if let body = req.body { request.httpBody = Data(body.utf8) }
        let wantsBase64 = req.responseType == "base64"

        let lock = NSLock()
        var finished = false
        func finish(_ r: Result<String, Error>) {
            lock.lock()
            defer { lock.unlock() }
            guard !finished else { return }
            finished = true
            completion(r)
        }

        let task = session.dataTask(with: request) { data, response, error in
            if let error {
                let ns = error as NSError
                if ns.domain == NSURLErrorDomain && (ns.code == NSURLErrorTimedOut || ns.code == NSURLErrorCancelled) {
                    return finish(.failure(HTTPError.timedOut(req.url)))
                }
                return finish(.failure(HTTPError.transport(error.localizedDescription)))
            }
            guard let http = response as? HTTPURLResponse else { return finish(.failure(HTTPError.transport("No HTTP response"))) }
            let body = data ?? Data()
            var out: [String: Any] = [
                "url": http.url?.absoluteString ?? req.url,
                "status": http.statusCode,
                "headers": Self.headers(of: http),
            ]
            if wantsBase64 { out["base64"] = body.base64EncodedString() } else { out["body"] = Self.decode(body, charset: http.textEncodingName) }
            guard let json = try? JSONSerialization.data(withJSONObject: out), let s = String(data: json, encoding: .utf8) else {
                return finish(.failure(HTTPError.transport("Unserializable response")))
            }
            finish(.success(s))
        }
        // URLRequest.timeoutInterval is an idle timeout; enforce a TOTAL deadline like v1 did.
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak task] in
            guard let task, task.state == .running else { return }
            task.cancel()
        }
        task.resume()
    }

    /// Lower-cased header names; Set-Cookie re-split into one cookie per line (iOS folds them with ", ").
    static func headers(of response: HTTPURLResponse) -> [String: String] {
        var out: [String: String] = [:]
        var raw: [String: String] = [:]
        for (k, v) in response.allHeaderFields {
            guard let key = k as? String else { continue }
            let value = "\(v)"
            raw[key] = value
            out[key.lowercased()] = value
        }
        out.removeValue(forKey: "set-cookie")
        if let url = response.url {
            let cookies = HTTPCookie.cookies(withResponseHeaderFields: raw, for: url)
            if !cookies.isEmpty { out["set-cookie"] = cookies.map(cookieLine).joined(separator: "\n") }
        }
        return out
    }

    static func cookieLine(_ c: HTTPCookie) -> String {
        var parts = ["\(c.name)=\(c.value)", "Domain=\(c.domain)", "Path=\(c.path)"]
        if let exp = c.expiresDate {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "GMT")
            f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
            parts.append("Expires=\(f.string(from: exp))")
        }
        if c.isSecure { parts.append("Secure") }
        if c.isHTTPOnly { parts.append("HttpOnly") }
        return parts.joined(separator: "; ")
    }

    /// Body text in the response charset; UTF-8, then Latin-1 (never fails) as fallbacks.
    static func decode(_ data: Data, charset: String?) -> String {
        if let charset {
            let cf = CFStringConvertIANACharSetNameToEncoding(charset as CFString)
            if cf != kCFStringEncodingInvalidId {
                let enc = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf))
                if let s = String(data: data, encoding: enc) { return s }
            }
        }
        if let s = String(data: data, encoding: .utf8) { return s }
        return String(data: data, encoding: .isoLatin1) ?? ""
    }
}
