import AppKit
import SwiftUI
import Network
import MapKit
import CoreLocation

// Notch Eats: shows a live Uber Eats order countdown around the MacBook notch.
// Hover the pill to expand it: arrival time, courier, delivery PIN and a mini map.
// Data arrives as JSON on http://127.0.0.1:47321/update from the Chrome extension.

let kPort: UInt16 = UInt16(ProcessInfo.processInfo.environment["NOTCH_PORT"] ?? "") ?? 47321   // NOTCH_PORT only for testing
let uberGreen = Color(red: 0.024, green: 0.757, blue: 0.404)

// MARK: - Sound

var paymentSound: NSSound?
func playPaymentSuccess() {
    // The system's own Apple Pay "payment success" chime.
    let path = "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/payment_success.aif"
    paymentSound = NSSound(contentsOfFile: path, byReference: true) ?? NSSound(named: "Glass")
    paymentSound?.play()
}

// MARK: - Model

struct LatLon: Codable, Equatable {
    var lat: Double
    var lon: Double
}

struct Coords: Codable, Equatable {
    var courier: LatLon?
    var dropoff: LatLon?
    var store: LatLon?
}

struct OrderState: Codable {
    var active: Bool?
    var etaMs: Double?     // epoch milliseconds of expected arrival
    var status: String?    // Placed / Preparing / On the way / Arriving / Delivered / Cancelled
    var done: Bool?        // terminal state (delivered or cancelled)
    var pin: String?       // delivery PIN to read out to the courier
    var courier: String?
    var vehicle: String?
    var plate: String?
    var store: String?
    var coords: Coords?
    var etaLowMs: Double?  // start of Uber's arrival window ("11:23 - 11:40")
    var stage: Int?        // 1...5, filled segments of Uber's progress bar
    var headline: String?  // "Picking up your order"
    var total: String?     // "€14.61"
    var topRated: Bool?
    var photo: String?     // https URL of the courier's profile photo

    /// Fill gaps from the previous update of the same order (the page doesn't always show every field).
    func merged(over old: OrderState?) -> OrderState {
        guard let o = old, o.done != true else { return self }
        var n = self
        n.pin = n.pin ?? o.pin
        n.courier = n.courier ?? o.courier
        n.vehicle = n.vehicle ?? o.vehicle
        n.plate = n.plate ?? o.plate
        n.store = n.store ?? o.store
        n.total = n.total ?? o.total
        n.topRated = n.topRated ?? o.topRated
        n.photo = n.photo ?? o.photo
        n.stage = n.stage ?? o.stage
        n.headline = n.headline ?? o.headline
        if var c = n.coords {
            c.courier = c.courier ?? o.coords?.courier
            c.dropoff = c.dropoff ?? o.coords?.dropoff
            c.store = c.store ?? o.coords?.store
            n.coords = c
        } else {
            n.coords = o.coords
        }
        return n
    }
}

final class Model: ObservableObject {
    @Published var state: OrderState?
    @Published var visible = false
    @Published var expanded = false
    @Published var now = Date()
    @Published var mapImage: NSImage?
    @Published var photoImage: NSImage?
    @Published var pinMode = false   // courier about to arrive: card is dropped down showing the PIN big
    private var photoKey = ""

    /// Set by the app delegate: is the mouse inside the pill (false) / expanded card (true)?
    var pointerInside: ((Bool) -> Bool)?

    private var lastUpdate = Date.distantPast
    private var lastActiveAt = Date.distantPast
    private var doneAt: Date?
    private var doneConsumed = false
    private var chimed = false
    private var pinAlerted = false
    private var hovered = false
    private var insideSince: Date?
    private var outsideSince: Date?
    private var peekUntil = Date.distantPast
    private var mapKey = ""
    private var mapBusy = false
    private var lastMapAt = Date.distantPast
    private var tickCount = 0

    init() {
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
    }

    func apply(_ incoming: OrderState) {
        if incoming.done == true {
            // Ignore "delivered" unless we watched this order while it was live
            // (stops old receipts from flashing on the notch).
            guard !doneConsumed, Date().timeIntervalSince(lastActiveAt) < 4 * 3600 else { return }
            if doneAt == nil {
                doneAt = Date()
                if incoming.status == "Cancelled" {
                    NSSound(named: "Basso")?.play()
                } else {
                    peekUntil = Date().addingTimeInterval(7)   // pop open to play the success animation
                    // land the sound on the tick, like Apple Pay
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { playPaymentSuccess() }
                }
            }
            state = incoming
            lastUpdate = Date()
            return
        }
        let wasDone = doneAt != nil
        // Status moved on (e.g. courier left the store): chime and drop the card down briefly.
        if !wasDone, state?.done != true, let old = state?.status, let new = incoming.status, old != new {
            peekUntil = max(peekUntil, Date().addingTimeInterval(6))
            NSSound(named: new == "On the way" ? "Pop" : "Tink")?.play()
        }
        doneAt = nil
        doneConsumed = false
        state = incoming.merged(over: wasDone ? nil : state)
        lastUpdate = Date()
        lastActiveAt = Date()
        refreshMap()
        loadPhoto(state?.photo)
    }

    private func loadPhoto(_ urlString: String?) {
        guard let s = urlString, s != photoKey, s.hasPrefix("https://"), let url = URL(string: s) else { return }
        photoKey = s
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data, let img = NSImage(data: data) else { return }
            DispatchQueue.main.async { self?.photoImage = img }
        }.resume()
    }

    func clear() {
        state = nil
        doneAt = nil
        visible = false
        expanded = false
        mapImage = nil
        mapKey = ""
        photoImage = nil
        photoKey = ""
    }

    private func tick() {
        now = Date()
        tickCount += 1
        var vis = false
        if let s = state {
            if s.done == true {
                if let d = doneAt, now.timeIntervalSince(d) < 45 {
                    vis = true
                } else {
                    state = nil
                    doneAt = nil
                    doneConsumed = true
                }
            } else if let eta = s.etaMs {
                let nowMs = now.timeIntervalSince1970 * 1000
                // Keep showing up to 10 min past the ETA ("Due"), in case the courier is late.
                vis = nowMs < eta + 10 * 60_000 && now.timeIntervalSince(lastUpdate) < 3 * 3600
                let rem = (eta - nowMs) / 1000
                if rem > 150 { chimed = false }
                if rem <= 120 && rem > 10 && !chimed {
                    chimed = true
                    NSSound(named: "Tink")?.play()   // soft heads-up, no pop-open
                }
            } else {
                vis = now.timeIntervalSince(lastUpdate) < 30 * 60
            }
        }
        if vis != visible { visible = vis }

        // PIN screen: recomputed from the CURRENT data every tick, never latched.
        // Shows only when the courier is genuinely about to arrive:
        //   - countdown at 10 s or less, or
        //   - page says "Arriving" AND the ETA (if known) is within 2 min, or
        //   - courier within ~80 m AND the ETA (if known) is within 3 min.
        // If the ETA moves later, it closes again straight away.
        var imminent = false
        if let s = state, s.done != true, vis, s.pin != nil {
            let nowMs = now.timeIntervalSince1970 * 1000
            let rem: Double? = s.etaMs.map { ($0 - nowMs) / 1000 }
            let dist = distanceMeters(s.coords.flatMap { c in c.courier.flatMap { a in c.dropoff.map { (a, $0) } } })
            if let r = rem, r <= 10 { imminent = true }
            if s.status == "Arriving", rem == nil || rem! <= 120 { imminent = true }
            if let d = dist, d <= 80, rem == nil || rem! <= 180 { imminent = true }
        }
        if imminent && !pinAlerted {
            pinAlerted = true
            NSSound(named: "Ping")?.play()
        }
        if !imminent { pinAlerted = false }
        let pm = imminent
        if pm != pinMode { pinMode = pm }

        // Hover with dwell, so brushing past the notch doesn't pop it open.
        let inside = vis && (pointerInside?(expanded) ?? false)
        if inside {
            outsideSince = nil
            if insideSince == nil { insideSince = now }
            if !hovered, now.timeIntervalSince(insideSince!) > 0.3 { hovered = true }
        } else {
            insideSince = nil
            if outsideSince == nil { outsideSince = now }
            if hovered, now.timeIntervalSince(outsideSince!) > 0.3 { hovered = false }
        }
        let ex = vis && (hovered || now < peekUntil || pinMode)
        if ex != expanded { expanded = ex }

        if tickCount % 100 == 0 { refreshMap() }
    }

    // MARK: map

    func refreshMap() {
        guard let c = state?.coords else { return }
        let pts = [c.courier, c.dropoff, c.store].compactMap { $0 }
        guard !pts.isEmpty else { return }
        let key = pts.map { String(format: "%.4f,%.4f", $0.lat, $0.lon) }.joined(separator: ";")
        guard key != mapKey, !mapBusy, Date().timeIntervalSince(lastMapAt) > 4 else { return }
        mapBusy = true

        let lats = pts.map { $0.lat }, lons = pts.map { $0.lon }
        let center = CLLocationCoordinate2D(latitude: (lats.min()! + lats.max()!) / 2,
                                            longitude: (lons.min()! + lons.max()!) / 2)
        let span = MKCoordinateSpan(latitudeDelta: max((lats.max()! - lats.min()!) * 1.8, 0.006),
                                    longitudeDelta: max((lons.max()! - lons.min()!) * 1.8, 0.006))
        let opts = MKMapSnapshotter.Options()
        opts.region = MKCoordinateRegion(center: center, span: span)
        opts.size = CGSize(width: 170, height: 130)
        opts.appearance = NSAppearance(named: .darkAqua)
        opts.pointOfInterestFilter = .excludingAll
        opts.showsBuildings = false

        MKMapSnapshotter(options: opts).start(with: .main) { [weak self] snap, _ in
            guard let self = self else { return }
            self.mapBusy = false
            self.lastMapAt = Date()
            guard let snap = snap else { return }
            self.mapKey = key
            let base = snap.image
            let h = base.size.height
            self.mapImage = NSImage(size: base.size, flipped: false) { rect in
                base.draw(in: rect)
                func dot(_ ll: LatLon?, _ color: NSColor, _ r: CGFloat) {
                    guard let ll = ll else { return }
                    let p = snap.point(for: CLLocationCoordinate2D(latitude: ll.lat, longitude: ll.lon))
                    let circle = NSRect(x: p.x - r, y: h - p.y - r, width: 2 * r, height: 2 * r)
                    NSColor.white.setFill()
                    NSBezierPath(ovalIn: circle.insetBy(dx: -2, dy: -2)).fill()
                    color.setFill()
                    NSBezierPath(ovalIn: circle).fill()
                }
                dot(c.store, NSColor.systemOrange, 4)
                dot(c.dropoff, NSColor.systemBlue, 5)
                dot(c.courier, NSColor(red: 0.024, green: 0.757, blue: 0.404, alpha: 1), 6)
                return true
            }
        }
    }
}

// MARK: - Notch geometry

struct Geo {
    var notchW: CGFloat
    var notchH: CGFloat
    var wing: CGFloat
    var cardW: CGFloat = 400
    var cardH: CGFloat = 182
    var total: CGFloat { notchW + 2 * wing }
    var panelH: CGFloat { notchH + cardH }

    static func current() -> (Geo, NSScreen) {
        let screens = NSScreen.screens
        let screen = screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? screens[0]
        let h = screen.safeAreaInsets.top
        if h > 0, let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
            let w = screen.frame.width - l.width - r.width
            return (sized(Geo(notchW: w, notchH: h, wing: 124)), screen)
        }
        // No notch on this display: draw a pill hanging from the top centre instead.
        return (sized(Geo(notchW: 150, notchH: 32, wing: 124)), screen)
    }

    /// The window (and expanded card) must always be wider than the collapsed pill,
    /// otherwise the window clips the pill's rounded corners and text. The notch is
    /// wider in "More Space" display modes, so derive the width instead of fixing it.
    private static func sized(_ g: Geo) -> Geo {
        var g = g
        g.cardW = max(400, g.total + 40)
        return g
    }
}

// MARK: - View helpers

func countdownText(_ s: OrderState, now: Date) -> String {
    if s.done == true { return s.status == "Cancelled" ? "✕" : "✓" }
    guard let eta = s.etaMs else { return "--:--" }
    let r = Int((eta / 1000 - now.timeIntervalSince1970).rounded(.up))
    if r <= 0 { return "Due" }
    let h = r / 3600, m = (r % 3600) / 60, sec = r % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

func arrivalClock(_ etaMs: Double) -> String {
    let f = DateFormatter()
    f.dateStyle = .none
    f.timeStyle = .short
    return f.string(from: Date(timeIntervalSince1970: etaMs / 1000))
}

func distanceMeters(_ pair: (LatLon, LatLon)?) -> Double? {
    guard let (a, b) = pair else { return nil }
    return CLLocation(latitude: a.lat, longitude: a.lon).distance(from: CLLocation(latitude: b.lat, longitude: b.lon))
}

func distanceText(_ c: Coords?) -> String? {
    guard let a = c?.courier, let b = c?.dropoff else { return nil }
    let m = distanceMeters((a, b))!
    if m < 1000 { return "\(Int((m / 10).rounded()) * 10) m away" }
    return String(format: "%.1f km away", m / 1000)
}

func courierLine(_ s: OrderState) -> String? {
    guard let name = s.courier else { return nil }
    var out = name
    if let v = s.vehicle { out += " · \(v)" }
    if let p = s.plate { out += " · \(p)" }
    return out
}

func arrivalText(_ s: OrderState) -> String {
    guard let hi = s.etaMs else { return "" }
    let f = DateFormatter()
    f.dateStyle = .none
    f.timeStyle = .short
    func fmt(_ ms: Double) -> String {
        f.string(from: Date(timeIntervalSince1970: ms / 1000)).replacingOccurrences(of: "\u{202F}", with: " ")
    }
    let hiStr = fmt(hi)
    guard let lo = s.etaLowMs, lo < hi else { return "Arrives \(hiStr)" }
    var loStr = fmt(lo)
    // "11:23 AM – 11:40 AM" reads better as "11:23 – 11:40 AM"
    for suf in [" AM", " PM", " am", " pm"] where loStr.hasSuffix(suf) && hiStr.hasSuffix(suf) {
        loStr = String(loStr.dropLast(suf.count))
    }
    return "Arrives \(loStr) – \(hiStr)"
}

func bandSub(_ s: OrderState) -> String? {
    if s.done == true { return nil }
    let parts = [s.courier, s.total].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

func storeLine(_ s: OrderState) -> String? {
    let parts = [s.store, s.total].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

func iconName(_ status: String?) -> String {
    switch status {
    case "Delivered": return "checkmark.circle.fill"
    case "Cancelled": return "xmark.circle.fill"
    case "Arriving": return "mappin.circle.fill"
    case "On the way": return "bicycle"
    case "Preparing": return "flame.fill"
    default: return "bag.fill"
    }
}

// MARK: - Apple Pay style success mark

struct CheckShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX + r.width * 0.26, y: r.minY + r.height * 0.53))
        p.addLine(to: CGPoint(x: r.minX + r.width * 0.43, y: r.minY + r.height * 0.69))
        p.addLine(to: CGPoint(x: r.minX + r.width * 0.75, y: r.minY + r.height * 0.34))
        return p
    }
}

/// Circle draws itself, then the tick draws, then a soft ring pulses out (like the Face ID / Apple Pay confirmation).
struct SuccessMark: View {
    @State private var circle: CGFloat = 0
    @State private var tick: CGFloat = 0
    @State private var pulse = false
    @State private var pop = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(uberGreen.opacity(pulse ? 0 : 0.5), lineWidth: 3)
                .scaleEffect(pulse ? 1.45 : 1)
            Circle()
                .trim(from: 0, to: circle)
                .stroke(uberGreen, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            CheckShape()
                .trim(from: 0, to: tick)
                .stroke(Color.white, style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 76, height: 76)
        .scaleEffect(pop ? 1.08 : 1)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5)) { circle = 1 }
            withAnimation(.easeOut(duration: 0.3).delay(0.5)) { tick = 1 }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.5).delay(0.55)) { pop = true }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.6).delay(0.85)) { pop = false }
            withAnimation(.easeOut(duration: 0.8).delay(0.6)) { pulse = true }
        }
    }
}

// MARK: - View

struct NotchView: View {
    @ObservedObject var model: Model
    let geo: Geo

    var body: some View {
        let vis = model.visible
        let ex = model.expanded
        let w: CGFloat = !vis ? geo.notchW : (ex ? geo.cardW : geo.total)
        let h: CGFloat = ex ? geo.panelH : geo.notchH
        let r: CGFloat = ex ? 26 : 14
        let shape = UnevenRoundedRectangle(bottomLeadingRadius: r, bottomTrailingRadius: r)
        ZStack(alignment: .top) {
            shape.fill(Color.black)
            if let s = model.state, vis {
                VStack(spacing: 0) {
                    band(s, width: w)
                    if ex { card(s).transition(.opacity) }
                }
            }
        }
        .frame(width: w, height: h, alignment: .top)
        .clipShape(shape)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .opacity(vis ? 1 : 0)
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: vis)
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: ex)
    }

    func band(_ s: OrderState, width: CGFloat) -> some View {
        let wing = (width - geo.notchW) / 2
        return HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Image(systemName: iconName(s.status))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(uberGreen)
                    Text(s.status ?? "Order")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                if let sub = bandSub(s) {
                    Text(sub)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.leading, 18)   // line up under the status text, not under the icon
                }
            }
            .padding(.leading, 16)
            .frame(width: wing, alignment: .leading)

            Spacer().frame(width: geo.notchW)

            Text(countdownText(s, now: model.now))
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.trailing, 16)
                .frame(width: wing, alignment: .trailing)
        }
        .frame(width: width, height: geo.notchH)
    }

    func doneCard(_ s: OrderState) -> some View {
        let cancelled = s.status == "Cancelled"
        return HStack(spacing: 18) {
            if cancelled {
                Image(systemName: "xmark.circle.fill").font(.system(size: 64)).foregroundStyle(.red.opacity(0.85))
            } else {
                SuccessMark()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(cancelled ? "Cancelled" : "Delivered")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white)
                Text(cancelled ? "This order was cancelled" : "Enjoy your order")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.6))
                if let st = s.store {
                    Text(st).font(.system(size: 12)).foregroundStyle(.white.opacity(0.4)).lineLimit(1)
                }
            }
        }
        .frame(width: geo.cardW, height: geo.cardH - 6)
    }

    func pinCard(_ s: OrderState, pin: String) -> some View {
        VStack(spacing: 2) {
            Text("Nearly there. Give your courier this PIN")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.7))
            Text(pin)
                .font(.system(size: 84, weight: .bold, design: .monospaced))
                .tracking(14)
                .foregroundStyle(uberGreen)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let c = courierLine(s) {
                Text(c).font(.system(size: 12)).foregroundStyle(.white.opacity(0.5))
            }
        }
        .padding(.horizontal, 20)
        .frame(width: geo.cardW, height: geo.cardH - 6)
    }

    @ViewBuilder func card(_ s: OrderState) -> some View {
        if s.done == true { doneCard(s) }
        else if model.pinMode, let pin = s.pin { pinCard(s, pin: pin) }
        else { liveCard(s) }
    }

    func liveCard(_ s: OrderState) -> some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                leftColumn(s)
                VStack(alignment: .leading, spacing: 4) {
                    if s.etaMs != nil {
                        Text(arrivalText(s))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    if let h = s.headline {
                        Text(h).font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                    }
                    if let d = distanceText(s.coords) {
                        Text(d).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                    }
                    if let c = courierLine(s) {
                        Text(c).font(.system(size: 12)).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
                    }
                    if let line = storeLine(s) {
                        Text(line).font(.system(size: 12)).foregroundStyle(.white.opacity(0.45)).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let pin = s.pin {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("PIN").font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.5))
                            Text(pin)
                                .font(.system(size: 28, weight: .bold, design: .monospaced))
                                .tracking(4)
                                .foregroundStyle(uberGreen)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: geo.cardH - 6 - 10 - 4 - 14)
            if let stage = s.stage { progressBar(stage) }
        }
        .padding(.horizontal, 18)
        .padding(.top, 6)
        .padding(.bottom, 14)
        .frame(width: geo.cardW, height: geo.cardH)
    }

    func progressBar(_ stage: Int) -> some View {
        HStack(spacing: 4) {
            ForEach(1...5, id: \.self) { i in
                Capsule().fill(i <= stage ? uberGreen : Color.white.opacity(0.18)).frame(height: 4)
            }
        }
        .frame(height: 4)
    }

    /// Map when we have coordinates, otherwise the courier's photo (or an initial) with a rating badge.
    @ViewBuilder func leftColumn(_ s: OrderState) -> some View {
        let h = geo.cardH - 6 - 10 - 4 - 14
        if let img = model.mapImage {
            Image(nsImage: img)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 140, height: h)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            VStack(spacing: 7) {
                avatar(s, size: 76)
                if s.topRated == true {
                    HStack(spacing: 3) {
                        Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(.orange)
                        Text("Top-rated").font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.6))
                    }
                }
            }
            .frame(width: 140, height: h)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.06)))
        }
    }

    @ViewBuilder func avatar(_ s: OrderState, size: CGFloat) -> some View {
        if let img = model.photoImage {
            Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                .frame(width: size, height: size).clipShape(Circle())
        } else {
            Circle().fill(Color.white.opacity(0.12)).frame(width: size, height: size)
                .overlay(
                    Group {
                        if let c = s.courier?.first {
                            Text(String(c)).font(.system(size: size * 0.4, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                        } else {
                            Image(systemName: "person.fill").font(.system(size: size * 0.4)).foregroundStyle(.white.opacity(0.5))
                        }
                    })
        }
    }
}

// MARK: - Local HTTP server (loopback only)

final class Server {
    var onState: ((OrderState) -> Void)?
    private var listener: NWListener?
    private let lock = NSLock()
    private var lastBody = Data("{}".utf8)

    func start() throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        // requiredInterfaceType alone still binds *:port, so pin the local endpoint to 127.0.0.1.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: kPort)!)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] c in
            c.start(queue: .global())
            self?.receive(c, Data())
        }
        l.stateUpdateHandler = { st in
            if case .failed(let e) = st {
                fputs("Notch Eats: listener failed: \(e)\n", stderr)
                exit(1)
            }
        }
        l.start(queue: .global())
        listener = l
    }

    private func receive(_ c: NWConnection, _ buf: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isDone, err in
            guard let self = self else { return }
            var b = buf
            if let d = data { b.append(d) }
            if let req = Self.parseRequest(b) {
                self.respond(c, req)
                return
            }
            if isDone || err != nil || b.count > 262_144 {
                c.cancel()
                return
            }
            self.receive(c, b)
        }
    }

    private static func parseRequest(_ d: Data) -> (method: String, path: String, body: Data)? {
        guard let sep = d.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: d[d.startIndex..<sep.lowerBound], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count >= 2 else { return nil }
        var length = 0
        for l in lines.dropFirst() {
            let parts = l.split(separator: ":", maxSplits: 1)
            if parts.count == 2, parts[0].lowercased() == "content-length" {
                length = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let body = d[sep.upperBound...]
        if body.count < length { return nil }
        return (String(first[0]), String(first[1]), Data(body.prefix(length)))
    }

    private func respond(_ c: NWConnection, _ req: (method: String, path: String, body: Data)) {
        var code = "404 Not Found"
        var out = "not found"
        if req.method == "POST", req.path == "/update" {
            if let s = try? JSONDecoder().decode(OrderState.self, from: req.body) {
                lock.lock(); lastBody = req.body; lock.unlock()
                onState?(s)
                code = "200 OK"; out = "ok"
            } else {
                code = "400 Bad Request"; out = "bad json"
            }
        } else if req.method == "GET", req.path == "/state" {
            lock.lock(); out = String(decoding: lastBody, as: UTF8.self); lock.unlock()
            code = "200 OK"
        } else if req.method == "GET", req.path == "/ping" {
            code = "200 OK"; out = "notch-eats"
        }
        let resp = "HTTP/1.1 \(code)\r\nContent-Type: text/plain\r\nContent-Length: \(out.utf8.count)\r\nConnection: close\r\n\r\n\(out)"
        c.send(content: Data(resp.utf8), completion: .contentProcessed { _ in c.cancel() })
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = Model()
    let server = Server()
    var panel: NSPanel!
    var hosting: NSHostingView<NotchView>!
    var statusItem: NSStatusItem!
    var geo = Geo(notchW: 150, notchH: 32, wing: 124)
    var screen: NSScreen = NSScreen.screens[0]

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)

        server.onState = { [weak self] s in
            DispatchQueue.main.async { self?.model.apply(s) }
        }
        do { try server.start() } catch {
            fputs("Notch Eats: cannot listen on 127.0.0.1:\(kPort): \(error)\n", stderr)
            exit(1)
        }

        (geo, screen) = Geo.current()
        hosting = NSHostingView(rootView: NotchView(model: model, geo: geo))
        hosting.sizingOptions = []
        // The panel is always the full expanded size; the SwiftUI shape inside grows and shrinks.
        // It ignores the mouse, so clicks pass straight through to whatever is underneath.
        panel = NSPanel(contentRect: panelFrame(),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = hosting
        panel.orderFrontRegardless()

        model.pointerInside = { [weak self] expanded in
            guard let self = self else { return false }
            let g = self.geo
            let w = expanded ? g.cardW : g.total
            let h = expanded ? g.panelH : g.notchH
            let r = NSRect(x: self.screen.frame.midX - w / 2 - 4,
                           y: self.screen.frame.maxY - h - 4,
                           width: w + 8, height: h + 12)   // extra on top: cursor stops at the screen edge
            return r.contains(NSEvent.mouseLocation)
        }

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in self?.reposition() }

        buildStatusItem()
    }

    func panelFrame() -> NSRect {
        NSRect(x: screen.frame.midX - geo.cardW / 2,
               y: screen.frame.maxY - geo.panelH,
               width: geo.cardW, height: geo.panelH)
    }

    func reposition() {
        (geo, screen) = Geo.current()
        hosting.rootView = NotchView(model: model, geo: geo)
        panel.setFrame(panelFrame(), display: true)
    }

    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "bag.fill", accessibilityDescription: "Notch Eats")
        let menu = NSMenu()
        let head = NSMenuItem(title: "Notch Eats · listening on 127.0.0.1:\(kPort)", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Demo order (hover the notch)", action: #selector(demo), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Clear", action: #selector(clear), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Notch Eats", action: #selector(quit), keyEquivalent: "q"))
        for i in menu.items where i.action != nil { i.target = self }
        statusItem.menu = menu
    }

    @objc func demo() {
        model.apply(OrderState(
            active: true,
            etaMs: Date().timeIntervalSince1970 * 1000 + 8 * 60_000,
            status: "On the way", done: false,
            pin: "1234", courier: "Alex", vehicle: "bicycle", plate: nil, store: "Example Mart",
            coords: Coords(courier: LatLon(lat: 54.0000, lon: -6.4200),
                           dropoff: LatLon(lat: 54.0090, lon: -6.4010),
                           store: LatLon(lat: 53.9960, lon: -6.4250)),
            etaLowMs: Date().timeIntervalSince1970 * 1000 + 2 * 60_000,
            stage: 4, headline: "On the way to you", total: "€14.61", topRated: true))
    }
    @objc func clear() { model.clear() }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
