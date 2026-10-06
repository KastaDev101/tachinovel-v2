//
//  StorePlugin.swift — Capacitor plugin "Store": StoreKit 2 for "Pro" (JS API: src/ui/monetization/entitlements.ts).
//
//  Pro is granted by EITHER an active auto-renewable subscription (group "Pro": monthly, annual) OR
//  the lifetime non-consumable. Entitlements come from Transaction.currentEntitlements (verified,
//  on device, works offline); no server and no receipt validation service needed at this scale.
//  Product ids: <bundle id>.pro.monthly / .pro.annual / .pro.lifetime (configure in App Store Connect,
//  and in a StoreKit Configuration file for local testing).
//

import Capacitor
import Foundation
import StoreKit
import UIKit

@objc(StorePlugin)
public class StorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePlugin"
    public let jsName = "Store"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "entitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "redeemOfferCode", returnType: CAPPluginReturnPromise),
    ]

    private var updates: Task<Void, Never>?

    override public func load() {
        // Renewals, refunds, Ask to Buy approvals, purchases on other devices.
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
                guard let self else { return }
                let ent = await StorePlugin.currentEntitlements()
                self.notifyListeners("entitlements", data: ent)
            }
        }
    }

    deinit { updates?.cancel() }

    /// "pro.monthly" → "<bundle id>.pro.monthly" (ids from JS are short).
    private static func fullId(_ id: String) -> String {
        let bundle = Bundle.main.bundleIdentifier ?? ""
        return id.hasPrefix(bundle) ? id : "\(bundle).\(id)"
    }

    private static func shortId(_ id: String) -> String {
        let prefix = (Bundle.main.bundleIdentifier ?? "") + "."
        return id.hasPrefix(prefix) ? String(id.dropFirst(prefix.count)) : id
    }

    @objc func products(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids", String.self) ?? []).map { StorePlugin.fullId($0) }
        Task {
            do {
                let products = try await Product.products(for: ids)
                var out: [[String: Any]] = []
                for p in products { out.append(await StorePlugin.encode(p)) }
                call.resolve(["products": out])
            } catch {
                call.reject("Products unavailable: \(error.localizedDescription)", "STORE")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required", "INVALID_ARGS") }
        Task {
            do {
                guard let product = try await Product.products(for: [StorePlugin.fullId(id)]).first else {
                    return call.reject("Unknown product \(id)", "STORE")
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification else { return call.reject("Purchase could not be verified", "STORE") }
                    await transaction.finish()
                    call.resolve(["status": "purchased", "entitlements": await StorePlugin.currentEntitlements()])
                case .pending:
                    call.resolve(["status": "pending", "entitlements": await StorePlugin.currentEntitlements()])
                case .userCancelled:
                    call.resolve(["status": "cancelled", "entitlements": await StorePlugin.currentEntitlements()])
                @unknown default:
                    call.resolve(["status": "cancelled", "entitlements": await StorePlugin.currentEntitlements()])
                }
            } catch {
                call.reject("Purchase failed: \(error.localizedDescription)", "STORE")
            }
        }
    }

    /// Only from an explicit "Restore Purchases" tap: AppStore.sync() may ask for the Apple ID password.
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do { try await AppStore.sync() } catch { /* still report what we have */ }
            call.resolve(["entitlements": await StorePlugin.currentEntitlements()])
        }
    }

    @objc func entitlements(_ call: CAPPluginCall) {
        Task { call.resolve(await StorePlugin.currentEntitlements()) }
    }

    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = NativeUI.shared.keyWindow()?.windowScene else { return call.reject("No window", "STORE") }
            do { try await AppStore.showManageSubscriptions(in: scene) } catch { return call.reject(error.localizedDescription, "STORE") }
            call.resolve()
        }
    }

    @objc func redeemOfferCode(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = NativeUI.shared.keyWindow()?.windowScene else { return call.reject("No window", "STORE") }
            do { try await AppStore.presentOfferCodeRedeemSheet(in: scene) } catch { return call.reject(error.localizedDescription, "STORE") }
            call.resolve()
        }
    }

    // MARK: - Encoding

    static func currentEntitlements() async -> [String: Any] {
        var lifetime: Transaction?
        var subscription: Transaction?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, t.revocationDate == nil else { continue }
            switch t.productType {
            case .nonConsumable: lifetime = t
            case .autoRenewable:
                // currentEntitlements only yields subscriptions that are subscribed OR in billing grace
                // period; the latter have a past expirationDate and must keep Pro on (inGracePeriod).
                subscription = t
            default: break
            }
        }
        if let lifetime {
            return ["pro": true, "source": "lifetime", "productId": shortId(lifetime.productID)]
        }
        if let subscription {
            var out: [String: Any] = ["pro": true, "source": "subscription", "productId": shortId(subscription.productID)]
            if let exp = subscription.expirationDate {
                out["expiresAt"] = exp.timeIntervalSince1970 * 1000
                if exp <= Date() { out["inGracePeriod"] = true }
            }
            if #available(iOS 17.2, *) { out["inTrial"] = subscription.offer?.type == .introductory } else { out["inTrial"] = subscription.offerType == .introductory }
            return out
        }
        return ["pro": false, "source": NSNull()]
    }

    static func period(_ p: Product.SubscriptionPeriod) -> String {
        let unit: String
        switch p.unit {
        case .day: unit = "D"
        case .week: unit = "W"
        case .month: unit = "M"
        case .year: unit = "Y"
        @unknown default: unit = "D"
        }
        return "P\(p.value)\(unit)"
    }

    static func encode(_ p: Product) async -> [String: Any] {
        var out: [String: Any] = [
            "id": shortId(p.id),
            "displayName": p.displayName,
            "description": p.description,
            "displayPrice": p.displayPrice,
            "price": NSDecimalNumber(decimal: p.price).doubleValue,
            "type": p.type == .autoRenewable ? "autoRenewable" : "nonConsumable",
        ]
        if let sub = p.subscription {
            out["period"] = period(sub.subscriptionPeriod)
            if let intro = sub.introductoryOffer, await sub.isEligibleForIntroOffer {
                let type: String
                switch intro.paymentMode {
                case .freeTrial: type = "freeTrial"
                case .payUpFront: type = "payUpFront"
                default: type = "payAsYouGo"
                }
                out["introOffer"] = ["type": type, "period": period(intro.period), "displayPrice": intro.displayPrice]
            }
        }
        return out
    }
}
