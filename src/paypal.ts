// PayPal integration.
//
// SandboxPayPalClient talks to the real PayPal sandbox REST API
// (OAuth2 client credentials + Orders v2 + capture refunds).
// MockPayPalClient implements the identical interface with realistic ids
// and statuses, so the full demo runs with no credentials at all.
//
// Mode selection (createPayPalClient):
//   PAYPAL_MODE=mock                              -> mock
//   PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET set   -> sandbox (or live)
//   otherwise                                     -> mock
//
// Env: PAYPAL_ENV=sandbox (default) | live

export interface CreateOrderInput {
  amount: number;
  currency: string;
  description: string;
  referenceId: string; // our mission id, stored as custom_id on the order
}

export interface PayPalOrder {
  id: string;
  status: string; // CREATED -> COMPLETED after capture
  captureId: string | null;
  amount: number;
  currency: string;
}

export interface RefundResult {
  id: string;
  status: string; // COMPLETED
}

export interface PayPalClientLike {
  mode: "mock" | "sandbox" | "live";
  createOrder(input: CreateOrderInput): Promise<PayPalOrder>;
  captureOrder(orderId: string): Promise<PayPalOrder>;
  refundCapture(captureId: string): Promise<RefundResult>;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function fakePayPalId(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return out;
}

export class MockPayPalClient implements PayPalClientLike {
  mode: "mock" | "sandbox" | "live" = "mock";
  private orders = new Map<string, PayPalOrder>();

  async createOrder(input: CreateOrderInput): Promise<PayPalOrder> {
    const order: PayPalOrder = {
      id: fakePayPalId(17),
      status: "CREATED",
      captureId: null,
      amount: input.amount,
      currency: input.currency,
    };
    this.orders.set(order.id, order);
    return { ...order };
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`mock: unknown order ${orderId}`);
    order.status = "COMPLETED";
    order.captureId = fakePayPalId(17);
    return { ...order };
  }

  async refundCapture(captureId: string): Promise<RefundResult> {
    for (const order of this.orders.values()) {
      if (order.captureId === captureId) order.status = "REFUNDED";
    }
    return { id: fakePayPalId(17), status: "COMPLETED" };
  }
}

export class SandboxPayPalClient implements PayPalClientLike {
  mode: "mock" | "sandbox" | "live";
  private base: string;
  private clientId: string;
  private clientSecret: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(clientId: string, clientSecret: string, env: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    if (env === "live") {
      this.mode = "live";
      this.base = "https://api-m.paypal.com";
    } else {
      this.mode = "sandbox";
      this.base = "https://api-m.sandbox.paypal.com";
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.token;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const token = await this.accessToken();
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PayPal ${path} failed: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  async createOrder(input: CreateOrderInput): Promise<PayPalOrder> {
    const data = (await this.request("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.referenceId,
            custom_id: input.referenceId,
            description: input.description.slice(0, 127),
            amount: {
              currency_code: input.currency,
              value: input.amount.toFixed(2),
            },
          },
        ],
      }),
    })) as { id: string; status: string };
    return { id: data.id, status: data.status, captureId: null, amount: input.amount, currency: input.currency };
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    const data = (await this.request(`/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      body: "{}",
    })) as {
      id: string;
      status: string;
      purchase_units?: Array<{
        payments?: { captures?: Array<{ id: string; amount?: { value: string; currency_code: string } }> };
      }>;
    };
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    return {
      id: data.id,
      status: data.status,
      captureId: capture?.id ?? null,
      amount: capture?.amount ? parseFloat(capture.amount.value) : 0,
      currency: capture?.amount?.currency_code ?? "USD",
    };
  }

  async refundCapture(captureId: string): Promise<RefundResult> {
    // Full refund of the capture.
    const data = (await this.request(`/v2/payments/captures/${captureId}/refund`, {
      method: "POST",
      body: "{}",
    })) as { id: string; status: string };
    return { id: data.id, status: data.status };
  }
}

export function createPayPalClient(): PayPalClientLike {
  if ((process.env.PAYPAL_MODE || "").toLowerCase() === "mock") {
    return new MockPayPalClient();
  }
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (id && secret) {
    return new SandboxPayPalClient(id, secret, (process.env.PAYPAL_ENV || "sandbox").toLowerCase());
  }
  return new MockPayPalClient();
}
