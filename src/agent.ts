// The agent: watches listings for active missions and acts when a price
// hits the target, always inside the user's autonomy policy.
//
//   total <= policy.autoBuyCap  -> buy immediately via PayPal
//   total >  policy.autoBuyCap  -> prepare checkout, park it in the
//                                  approvals queue for a one-click human OK
//
// Every decision and money movement is written to the audit log.

import type { Mission, Approval, OrderRecord, Listing } from "./types.ts";
import { Store, newId, round2 } from "./store.ts";
import type { LocalCatalog } from "./catalog.ts";
import type { PayPalClientLike } from "./paypal.ts";

export class Agent {
  private store: Store;
  private catalog: LocalCatalog;
  private paypal: PayPalClientLike;

  constructor(store: Store, catalog: LocalCatalog, paypal: PayPalClientLike) {
    this.store = store;
    this.catalog = catalog;
    this.paypal = paypal;
  }

  async tick(): Promise<void> {
    for (const mission of this.store.data.missions) {
      if (mission.status !== "watching") continue;
      const listing = this.catalog.bestMatch(mission.keywords);
      if (!listing) continue;

      mission.listingId = listing.id;
      mission.lastPrice = listing.price;
      mission.updatedAt = new Date().toISOString();

      if (listing.price > mission.targetPrice) {
        this.store.save();
        continue;
      }

      const total = round2(listing.price * mission.quantity);
      this.store.audit(
        mission.id,
        "price_hit",
        `"${listing.title}" (${listing.seller}) at ${listing.currency} ${listing.price.toFixed(2)} ` +
          `<= target ${mission.targetPrice.toFixed(2)}; total for x${mission.quantity} = ${total.toFixed(2)}`,
      );

      if (total <= this.store.data.policy.autoBuyCap) {
        await this.executeBuy(mission, listing, "auto");
      } else {
        const approval: Approval = {
          id: newId("apr"),
          missionId: mission.id,
          listingId: listing.id,
          listingTitle: listing.title,
          unitPrice: listing.price,
          quantity: mission.quantity,
          total,
          currency: listing.currency,
          status: "pending",
          orderId: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        };
        this.store.data.approvals.push(approval);
        mission.status = "approval_pending";
        this.store.audit(
          mission.id,
          "approval_requested",
          `Total ${total.toFixed(2)} exceeds auto-buy cap ${this.store.data.policy.autoBuyCap.toFixed(2)}; ` +
            `checkout prepared and parked for human approval`,
        );
        this.store.save();
      }
    }
  }

  async executeBuy(mission: Mission, listing: Listing, via: "auto" | "approval"): Promise<OrderRecord> {
    const total = round2(listing.price * mission.quantity);
    const order = await this.paypal.createOrder({
      amount: total,
      currency: listing.currency,
      description: `${listing.title} x${mission.quantity} (BuyScout mission)`,
      referenceId: mission.id,
    });
    this.store.audit(
      mission.id,
      via === "auto" ? "auto_buy" : "order_created",
      `PayPal order ${order.id} created for ${listing.currency} ${total.toFixed(2)} via ${via === "auto" ? "autonomy policy" : "human approval"}`,
    );

    const captured = await this.paypal.captureOrder(order.id);
    const record: OrderRecord = {
      id: captured.id,
      captureId: captured.captureId,
      missionId: mission.id,
      amount: captured.amount || total,
      currency: captured.currency,
      status: captured.status,
      via,
      refundId: null,
      createdAt: new Date().toISOString(),
    };
    this.store.data.orders.push(record);

    mission.status = "purchased";
    mission.orderId = captured.id;
    mission.paidTotal = record.amount;
    mission.updatedAt = new Date().toISOString();
    this.store.audit(
      mission.id,
      "order_captured",
      `Order ${captured.id} captured (${captured.status}), capture id ${captured.captureId}, ` +
        `${record.currency} ${record.amount.toFixed(2)} paid via PayPal (${this.paypal.mode} mode)`,
    );
    this.store.save();
    return record;
  }

  async approve(approvalId: string): Promise<Approval> {
    const approval = this.store.data.approvals.find((a) => a.id === approvalId);
    if (!approval) throw new Error(`unknown approval ${approvalId}`);
    if (approval.status !== "pending") throw new Error(`approval ${approvalId} is ${approval.status}`);
    const mission = this.store.data.missions.find((m) => m.id === approval.missionId);
    if (!mission) throw new Error(`mission ${approval.missionId} missing`);

    const listing: Listing = {
      id: approval.listingId,
      title: approval.listingTitle,
      seller: "",
      price: approval.unitPrice,
      currency: approval.currency,
    };
    this.store.audit(mission.id, "approval_approved", `Human approved checkout of ${approval.currency} ${approval.total.toFixed(2)}`);
    const record = await this.executeBuy(mission, listing, "approval");
    approval.status = "executed";
    approval.orderId = record.id;
    approval.resolvedAt = new Date().toISOString();
    this.store.save();
    return approval;
  }

  reject(approvalId: string): Approval {
    const approval = this.store.data.approvals.find((a) => a.id === approvalId);
    if (!approval) throw new Error(`unknown approval ${approvalId}`);
    if (approval.status !== "pending") throw new Error(`approval ${approvalId} is ${approval.status}`);
    approval.status = "rejected";
    approval.resolvedAt = new Date().toISOString();
    const mission = this.store.data.missions.find((m) => m.id === approval.missionId);
    if (mission && mission.status === "approval_pending") {
      mission.status = "watching";
      mission.updatedAt = new Date().toISOString();
    }
    this.store.audit(approval.missionId, "approval_rejected", `Human rejected checkout of ${approval.currency} ${approval.total.toFixed(2)}; mission resumed watching`);
    this.store.save();
    return approval;
  }

  async refund(orderId: string): Promise<OrderRecord> {
    const record = this.store.data.orders.find((o) => o.id === orderId);
    if (!record) throw new Error(`unknown order ${orderId}`);
    if (!record.captureId) throw new Error(`order ${orderId} has no capture to refund`);
    if (record.status === "REFUNDED") throw new Error(`order ${orderId} already refunded`);
    const refund = await this.paypal.refundCapture(record.captureId);
    record.status = "REFUNDED";
    record.refundId = refund.id;
    const mission = this.store.data.missions.find((m) => m.id === record.missionId);
    if (mission) {
      mission.status = "refunded";
      mission.updatedAt = new Date().toISOString();
    }
    this.store.audit(
      record.missionId,
      "refund_issued",
      `Refund ${refund.id} (${refund.status}) issued for capture ${record.captureId}: ${record.currency} ${record.amount.toFixed(2)} returned via PayPal (${this.paypal.mode} mode)`,
    );
    this.store.save();
    return record;
  }
}
