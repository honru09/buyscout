// Shared data model for BuyScout.

export type MissionStatus =
  | "watching"
  | "approval_pending"
  | "purchased"
  | "refunded"
  | "cancelled";

export interface Mission {
  id: string;
  rawText: string;
  itemQuery: string;
  keywords: string[];
  targetPrice: number; // buy when best price <= targetPrice
  maxPrice: number; // hard ceiling from the user's wording (defaults to targetPrice)
  quantity: number;
  currency: string;
  status: MissionStatus;
  parseSource: "llm" | "rules";
  listingId: string | null; // best matching listing right now
  lastPrice: number | null; // last observed price of the best listing
  orderId: string | null;
  paidTotal: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Listing {
  id: string;
  title: string;
  seller: string;
  price: number;
  currency: string;
}

export interface Policy {
  autoBuyCap: number; // totals <= cap are bought automatically
  currency: string;
}

export type ApprovalStatus = "pending" | "executed" | "rejected";

export interface Approval {
  id: string;
  missionId: string;
  listingId: string;
  listingTitle: string;
  unitPrice: number;
  quantity: number;
  total: number;
  currency: string;
  status: ApprovalStatus;
  orderId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface OrderRecord {
  id: string; // PayPal (or mock) order id
  captureId: string | null;
  missionId: string;
  amount: number;
  currency: string;
  status: string; // CREATED / COMPLETED / REFUNDED
  via: "auto" | "approval";
  refundId: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  ts: string;
  missionId: string | null;
  event: string;
  details: string;
}

export interface StoreData {
  missions: Mission[];
  approvals: Approval[];
  orders: OrderRecord[];
  audit: AuditEntry[];
  policy: Policy;
}

export interface ParsedMission {
  itemQuery: string;
  keywords: string[];
  targetPrice: number | null;
  maxPrice: number | null;
  quantity: number;
  currency: string;
  source: "llm" | "rules";
}
