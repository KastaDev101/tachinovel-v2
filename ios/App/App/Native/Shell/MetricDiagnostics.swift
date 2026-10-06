//
//  MetricDiagnostics.swift — MetricKit crash, hang, CPU, disk-write and launch diagnostics, collected on
//  the device only. iOS delivers an MXDiagnosticPayload (usually at the next launch after the problem);
//  its JSON goes unchanged to the core (`diagnostics.metricPayload`, src/core/diagnostics/metrickit.ts),
//  which stores it under logs/metrickit/ and logs a one-line summary for Settings › Diagnostics.
//  Nothing is uploaded: reports leave the device only through the share sheet, when the user asks.
//

import Foundation
import MetricKit

final class MetricDiagnostics: NSObject, MXMetricManagerSubscriber, Sendable {
    static let shared = MetricDiagnostics()

    /// Call once at launch. Also forwards payloads iOS delivered before this launch subscribed
    /// (the core ignores ones it already stored).
    @MainActor func start() {
        MXMetricManager.shared.add(self)
        forward(MXMetricManager.shared.pastDiagnosticPayloads)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        forward(payloads)
    }

    private func forward(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            guard let json = String(data: payload.jsonRepresentation(), encoding: .utf8) else { continue }
            CoreHost.shared.request("diagnostics.metricPayload", args: ["json": json])
        }
    }
}
