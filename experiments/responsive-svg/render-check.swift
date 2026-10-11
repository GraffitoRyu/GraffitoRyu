import AppKit
import WebKit

// Local component test; no user browser, account, or website is accessed.
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let testView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 1000), configuration: configuration)
let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1440, height: 1000), styleMask: .borderless, backing: .buffered, defer: false)
window.contentView = testView
window.orderBack(nil)

final class Renderer: NSObject, WKNavigationDelegate {
    var timer: Timer?
    var attempts = 0
    var captures: [[String: Any]] = []

    func fail(_ message: String) -> Never {
        fputs(message + "\n", stderr)
        exit(1)
    }

    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [self] _ in
            attempts += 1
            if attempts > 100 { fail("Local SVG images did not finish loading") }
            view.evaluateJavaScript("document.images.length===15 && [...document.images].every(i=>i.complete&&i.naturalWidth>0)") { [self] result, error in
                if let error = error { fail(error.localizedDescription) }
                if result as? Bool == true {
                    timer?.invalidate()
                    measure()
                }
            }
        }
    }

    func measure() {
        let script = #"""
        (()=>{
          const boxes=[...document.querySelectorAll('.host')];
          const cases=boxes.map(host=>({contentWidth:Number(host.dataset.content),images:[...host.querySelectorAll('img')].map(img=>{
            const b=img.getBoundingClientRect();return{variant:img.dataset.variant,width:b.width,height:b.height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight};
          })}));
          const captures=boxes.filter(h=>[846,293,263].includes(Number(h.dataset.content))).flatMap(h=>{
            const width=Number(h.dataset.content),b=h.getBoundingClientRect(),c=h.querySelector('img[data-variant="percent-width.svg"]').getBoundingClientRect();
            return[{name:`proof-${width}.png`,width,x:b.x,y:b.y,w:b.width,h:b.height},{name:`responsive-${width}.png`,width,x:c.x,y:c.y,w:c.width,h:c.height}];
          });
          return{engine:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},documentHeight:document.documentElement.scrollHeight,cases,captures};
        })()
        """#
        testView.evaluateJavaScript(script) { [self] result, error in
            if let error = error { fail(error.localizedDescription) }
            guard let report = result as? [String: Any], let cases = report["cases"] as? [[String: Any]], cases.count == 5 else { fail("Missing measured cases") }
            for entry in cases {
                guard let expected = entry["contentWidth"] as? Double, let images = entry["images"] as? [[String: Any]], images.count == 3 else { fail("Invalid case") }
                for image in images {
                    guard let width = image["width"] as? Double, abs(width - expected) < 0.1,
                          let height = image["height"] as? Double, height > 0 else { fail("Image does not fit measured content width") }
                    if image["variant"] as? String == "percent-width.svg", abs(height - 440) > 0.1 { fail("Percentage-width SVG height did not remain 440px") }
                }
            }
            do {
                let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: folder.appendingPathComponent("render-result.json"))
                print(String(data: data, encoding: .utf8)!)
            } catch { fail(error.localizedDescription) }
            captures = report["captures"] as? [[String: Any]] ?? []
            testView.setFrameSize(NSSize(width: 1440, height: report["documentHeight"] as? Double ?? 3000))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.captureNext() }
        }
    }

    func captureNext() {
        guard !captures.isEmpty else { print("Image loading and content-width assertions: OK"); exit(0) }
        let target = captures.removeFirst()
        let config = WKSnapshotConfiguration()
        config.rect = NSRect(x: target["x"] as! Double, y: target["y"] as! Double, width: target["w"] as! Double, height: target["h"] as! Double)
        testView.takeSnapshot(with: config) { [self] image, error in
            if let error = error { fail(error.localizedDescription) }
            guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { fail("Snapshot unavailable") }
            do { try png.write(to: folder.appendingPathComponent(target["name"] as! String)) }
            catch { fail(error.localizedDescription) }
            captureNext()
        }
    }
}

let renderer = Renderer()
let timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in renderer.fail("WebKit rendering timeout") }
testView.navigationDelegate = renderer
testView.loadFileURL(folder.appendingPathComponent("index.html"), allowingReadAccessTo: folder)
app.run()
