//
//  BrowserFetcher.swift — Cloudflare fallbacks (v1 parity: Platform.browserFetch + sources.solveChallenge).
//
//  - BrowserFetcher: hidden WKWebView loads the page, waits until it is no longer a JS challenge, and
//    returns the HTML. Cookies (cf_clearance) are then copied into HTTPCookieStorage.shared so the
//    core's URLSession requests pass too. The User-Agent matches what the plugin host sends
//    (v1 IPHONE_SAFARI_UA), because clearance cookies are bound to it.
//  - ChallengeViewController: the same, visible, for checks a human must solve.
//  Main thread only.
//

import UIKit
import WebKit

enum WebFetchError: LocalizedError {
    case invalidURL, timedOut, failed(String)
    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .timedOut: return "browserFetch timed out"
        case .failed(let m): return m
        }
    }
}

/// Keep in sync with v1 src/plugin-host/net.ts IPHONE_SAFARI_UA.
let pluginUserAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"

private let challengeCheckJS =
    "(function(){var t=document.title||'';var cf=/just a moment|attention required|checking your browser|please wait|verify you are human/i.test(t)" +
    "||!!document.querySelector('#challenge-form,#challenge-stage,#cf-challenge-running,.cf-browser-verification,#turnstile-wrapper');" +
    "return (cf||document.readyState!=='complete')?'challenge':'ok';})()"

/// Copy the WebView's cookies for `host` into the URLSession cookie storage.
func syncWebCookies(to host: String?, completion: @escaping () -> Void) {
    WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
        for c in cookies where host == nil || host!.hasSuffix(c.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) {
            HTTPCookieStorage.shared.setCookie(c)
        }
        completion()
    }
}

final class BrowserFetcher {
    /// JSON from the core (`__native.browserFetch`): {url, timeoutMs, method, headers?, body?}.
    struct Request {
        let url: URL
        let timeout: TimeInterval
        let method: String
        let headers: [String: String]
        let body: String?

        init?(json: String) {
            guard let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
                  let s = obj["url"] as? String, let url = URL(string: s), let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http" else { return nil }
            self.url = url
            let ms = (obj["timeoutMs"] as? NSNumber)?.doubleValue ?? 30_000
            timeout = ms.isFinite && ms > 0 ? min(ms / 1000, 600) : 30 // NaN would never time out
            method = ((obj["method"] as? String) ?? "GET").uppercased()
            headers = obj["headers"] as? [String: String] ?? [:]
            body = obj["body"] as? String
        }
    }

    static let shared = BrowserFetcher()
    private var busy = false
    private var queue: [(Request, (Result<String, Error>) -> Void)] = []

    func fetch(_ request: Request, completion: @escaping (Result<String, Error>) -> Void) {
        queue.append((request, completion))
        pump()
    }

    private func pump() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let (request, completion) = queue.removeFirst()
        run(request) { [weak self] result in
            completion(result)
            self?.busy = false
            self?.pump()
        }
    }

    private static func json(_ obj: [String: Any]) -> String {
        (try? JSONSerialization.data(withJSONObject: obj)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    /// GET: load the URL and return the page once it is past any challenge.
    /// POST (v1 parity): load the site's origin, get past the challenge, then fetch() inside the page so the
    /// request carries the WebView's cookies (e.g. a cf_clearance) and the page's origin.
    private func run(_ req: Request, completion: @escaping (Result<String, Error>) -> Void) {
        let isPost = req.method == "POST"
        var originURL = req.url
        if isPost, var c = URLComponents(url: req.url, resolvingAgainstBaseURL: false) {
            c.path = "/"
            c.query = nil
            c.fragment = nil
            originURL = c.url ?? req.url
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: config)
        web.customUserAgent = pluginUserAgent
        web.alpha = 0.01
        web.isUserInteractionEnabled = false
        // Attached to a window so timers and layout run normally; invisible to the user.
        if let window = NativeUI.shared.keyWindow() { window.insertSubview(web, at: 0) }
        web.load(URLRequest(url: originURL))
        let deadline = Date().addingTimeInterval(req.timeout)

        // Exactly one completion per run (the serial queue in pump() waits for it).
        var finished = false
        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            web.stopLoading()
            web.removeFromSuperview()
            completion(result)
        }

        func readPage() {
            web.evaluateJavaScript("JSON.stringify({u: location.href, ct: document.contentType, h: document.contentType && /html|xml/i.test(document.contentType) ? document.documentElement.outerHTML : document.body ? document.body.innerText : ''})") { raw, error in
                guard let raw = raw as? String, let data = raw.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return finish(.failure(WebFetchError.failed(error?.localizedDescription ?? "page read failed")))
                }
                let response: [String: Any] = [
                    "url": obj["u"] as? String ?? req.url.absoluteString,
                    "status": 200,
                    "headers": ["content-type": obj["ct"] as? String ?? "text/html"],
                    "body": obj["h"] as? String ?? "",
                ]
                syncWebCookies(to: req.url.host) { finish(.success(Self.json(response))) }
            }
        }

        func postInPage() {
            let script = """
            const r = await fetch(url, { method: 'POST', headers: headers, body: body, credentials: 'include' });
            return JSON.stringify({ u: r.url, s: r.status, ct: r.headers.get('content-type') || '', b: await r.text() });
            """
            let args: [String: Any] = ["url": req.url.absoluteString, "headers": req.headers, "body": req.body ?? ""]
            web.callAsyncJavaScript(script, arguments: args, in: nil, in: .page) { result in
                switch result {
                case .failure(let error):
                    finish(.failure(WebFetchError.failed("in-page POST failed: \(error.localizedDescription)")))
                case .success(let value):
                    guard let raw = value as? String, let data = raw.data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        return finish(.failure(WebFetchError.failed("in-page POST returned no result")))
                    }
                    let response: [String: Any] = [
                        "url": obj["u"] as? String ?? req.url.absoluteString,
                        "status": (obj["s"] as? NSNumber)?.intValue ?? 0,
                        "headers": ["content-type": obj["ct"] as? String ?? ""],
                        "body": obj["b"] as? String ?? "",
                    ]
                    syncWebCookies(to: req.url.host) { finish(.success(Self.json(response))) }
                }
            }
        }

        func poll() {
            guard !finished else { return }
            web.evaluateJavaScript(challengeCheckJS) { value, _ in
                if (value as? String) == "ok" {
                    if isPost { postInPage() } else { readPage() }
                    return
                }
                if Date() > deadline { return finish(.failure(WebFetchError.timedOut)) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { poll() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { poll() }
        // Watchdog: evaluateJavaScript may never answer while the web content process is suspended (app in
        // the background), which would otherwise wedge the fetch queue for good.
        DispatchQueue.main.asyncAfter(deadline: .now() + req.timeout + 5) { finish(.failure(WebFetchError.timedOut)) }
    }
}

/// Visible "solve the browser check" sheet (sources.solveChallenge).
final class ChallengeViewController: UIViewController {
    private let url: URL
    private let completion: (Bool) -> Void
    private let web: WKWebView

    /// Queued like every other modal (PresentationQueue); answered once, after the sheet is gone.
    static func present(urlString: String, completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: urlString) else { return completion(false) }
        let answer = Once(completion)
        PresentationQueue.shared.enqueue({ host, finished in
            let vc = ChallengeViewController(url: url) { solved in
                answer.call(solved)
                finished()
            }
            let nav = UINavigationController(rootViewController: vc)
            nav.isModalInPresentation = true
            host.present(nav, animated: true)
            return nav
        }, cancel: { answer.call(false) })
    }

    init(url: URL, completion: @escaping (Bool) -> Void) {
        self.url = url
        self.completion = completion
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.customUserAgent = pluginUserAgent
        self.web = web
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = url.host
        view = web
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
        web.load(URLRequest(url: url))
    }

    @objc private func done() {
        navigationItem.rightBarButtonItem?.isEnabled = false // a double tap must not answer twice
        web.evaluateJavaScript(challengeCheckJS) { [weak self] value, _ in
            guard let self else { return }
            let solved = (value as? String) == "ok"
            syncWebCookies(to: self.url.host) {
                self.dismiss(animated: true) { self.completion(solved) }
            }
        }
    }
}
