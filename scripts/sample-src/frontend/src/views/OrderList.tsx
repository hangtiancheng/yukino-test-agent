import { LitElement, customElement, state } from "@yukino.js/lit-jsx";

import { showToast } from "../components/toast";

interface OrderInfo {
  orderNo: string;
  receiverName: string;
  amount: string;
  status: string;
}

/** Status badge copy; mirrors the backend OrderStatus labels. */
const STATUS_LABELS: Record<string, string> = {
  CREATED: "Pending payment",
  PAID: "Paid",
  SHIPPED: "Shipped",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Badge palette per status; full class strings so Tailwind detects them. */
const STATUS_BADGES: Record<string, string> = {
  CREATED: "bg-sky-100 text-sky-800",
  PAID: "bg-emerald-100 text-emerald-800",
  SHIPPED: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-slate-100 text-slate-600",
};

// from = states the action is allowed from; to = resulting state. Mirrors
// the backend rules: pay only from CREATED, ship only from PAID, complete
// only from SHIPPED, cancel from CREATED or PAID.
const ALLOW: Record<string, { from: string[]; to: string }> = {
  pay: { from: ["CREATED"], to: "PAID" },
  ship: { from: ["PAID"], to: "SHIPPED" },
  complete: { from: ["SHIPPED"], to: "COMPLETED" },
  cancel: { from: ["CREATED", "PAID"], to: "CANCELLED" },
};

const CELL = "border-b border-slate-200 px-3 py-2.5 text-left align-middle";
const ACTION_BUTTON =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-50";

/** Order List page: status badges plus Pay/Ship/Complete/Cancel actions. */
@customElement("order-list-page")
export class OrderList extends LitElement {
  @state() private orders: OrderInfo[] = [
    {
      orderNo: "ORD1001",
      receiverName: "Alice",
      amount: "100.00",
      status: "CREATED",
    },
    {
      orderNo: "ORD1002",
      receiverName: "Bob",
      amount: "200.00",
      status: "PAID",
    },
    {
      orderNo: "ORD1003",
      receiverName: "Carol",
      amount: "300.00",
      status: "SHIPPED",
    },
    {
      orderNo: "ORD1004",
      receiverName: "David",
      amount: "400.00",
      status: "COMPLETED",
    },
  ];

  /** Light DOM rendering so the global Tailwind utilities apply. */
  protected override createRenderRoot() {
    return this;
  }

  render() {
    return (
      <section class="mx-auto max-w-4xl px-4 py-10">
        <h1 class="text-2xl font-semibold tracking-tight text-slate-900">
          Order List
        </h1>
        <p class="mt-1 text-sm text-slate-500">
          Manage order status through payment, shipping, and completion.
        </p>
        <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div class="mb-4 flex items-center justify-between">
            <span class="text-[13px] text-slate-500">
              Total of {this.orders.length} items
            </span>
            <a
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500"
              href="/orders/create"
            >
              Create order
            </a>
          </div>
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th class="border-b border-slate-200 px-3 py-2 text-left text-[13px] font-medium text-slate-500">
                  Order no.
                </th>
                <th class="border-b border-slate-200 px-3 py-2 text-left text-[13px] font-medium text-slate-500">
                  Receiver
                </th>
                <th class="border-b border-slate-200 px-3 py-2 text-left text-[13px] font-medium text-slate-500">
                  Amount
                </th>
                <th class="border-b border-slate-200 px-3 py-2 text-left text-[13px] font-medium text-slate-500">
                  Status
                </th>
                <th class="border-b border-slate-200 px-3 py-2 text-left text-[13px] font-medium text-slate-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {this.orders.map((order, index) => this.renderRow(order, index))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  private renderRow(order: OrderInfo, index: number) {
    const canPay = order.status === "CREATED";
    const canShip = order.status === "PAID";
    const canComplete = order.status === "SHIPPED";
    const canCancel = order.status === "CREATED" || order.status === "PAID";
    const badge = STATUS_BADGES[order.status] ?? "bg-slate-100 text-slate-600";
    return (
      <tr class="transition-colors hover:bg-slate-50/60">
        <td class={`${CELL} font-medium text-slate-900`}>{order.orderNo}</td>
        <td class={`${CELL} text-slate-700`}>{order.receiverName}</td>
        <td class={`${CELL} text-slate-700`}>{order.amount}</td>
        <td class={CELL}>
          <span
            class={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge}`}
          >
            {STATUS_LABELS[order.status] ?? order.status}
          </span>
        </td>
        <td class={CELL}>
          <div class="flex gap-2">
            {canPay && (
              <button
                class={ACTION_BUTTON}
                onClick={() => this.perform("pay", index)}
              >
                Pay
              </button>
            )}
            {canShip && (
              <button
                class={ACTION_BUTTON}
                onClick={() => this.perform("ship", index)}
              >
                Ship
              </button>
            )}
            {canComplete && (
              <button
                class={ACTION_BUTTON}
                onClick={() => this.perform("complete", index)}
              >
                Complete
              </button>
            )}
            {canCancel && (
              <button
                class="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50"
                onClick={() => this.perform("cancel", index)}
              >
                Cancel
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  /** Guarded action: mirrors the backend transition rules exactly. */
  private perform(action: string, index: number) {
    const order = this.orders[index];
    const rule = ALLOW[action];
    if (!order || !rule || !rule.from.includes(order.status)) {
      return showToast("Current status does not allow this action", "error");
    }
    const next = this.orders.slice();
    next[index] = { ...order, status: rule.to };
    this.orders = next;
    if (action === "pay") return showToast("Payment successful");
    if (action === "ship") return showToast("Shipment successful");
    if (action === "complete") return showToast("Order completed");
    return showToast("Order cancelled");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "order-list-page": OrderList;
  }
}
