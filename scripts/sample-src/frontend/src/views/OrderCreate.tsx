import { LitElement, customElement, state } from "@yukino.js/lit-jsx";

import { navigate } from "../app-router";
import { TextField } from "../components/text-field";
import { showToast } from "../components/toast";

/** Create Order page: five validated fields and a Submit button. */
@customElement("order-create-page")
export class OrderCreate extends LitElement {
  /** prop -> current input value, updated as fields bubble input events. */
  @state() private values: Record<string, string> = {};

  /** Light DOM rendering so the global Tailwind utilities apply. */
  protected override createRenderRoot() {
    return this;
  }

  render() {
    return (
      <section class="mx-auto max-w-xl px-4 py-10">
        <h1 class="text-2xl font-semibold tracking-tight text-slate-900">
          Create Order
        </h1>
        <p class="mt-1 text-sm text-slate-500">
          Fill in the delivery details to place a new order.
        </p>
        <form
          class="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          onInput={this.trackField}
          onSubmit={this.handleSubmit}
        >
          <text-field
            label="Receiver name"
            prop="receiverName"
            placeholder="Enter receiver name"
            required
          ></text-field>
          <text-field
            label="Phone number"
            prop="phone"
            placeholder="Enter phone number"
            required
          ></text-field>
          <text-field
            label="Address"
            prop="address"
            placeholder="Enter address"
            required
          ></text-field>
          <text-field
            label="Amount"
            prop="amount"
            placeholder="Enter amount"
            required
          ></text-field>
          <text-field
            label="Remark"
            prop="remark"
            placeholder="Enter remark"
          ></text-field>
          <div class="flex items-center gap-3 pt-1">
            <button
              type="submit"
              class="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none"
            >
              Submit
            </button>
            <a
              class="rounded-lg border border-slate-300 bg-white px-5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              href="/orders/list"
            >
              Cancel
            </a>
          </div>
        </form>
      </section>
    );
  }

  /** Input events bubble from the inner input; closest() finds the field. */
  private trackField(event: Event) {
    const target = event.target as HTMLElement | null;
    // instanceof keeps TextField a value import: dropping it would skip
    // the custom-element registration and lit-jsx would render a div.
    const field = target?.closest("text-field");
    if (!(field instanceof TextField) || !field.prop) return;
    this.values = { ...this.values, [field.prop]: field.value };
  }

  private value(name: string): string {
    return (this.values[name] ?? "").trim();
  }

  /** Client-side copy mirrors the backend validation messages exactly. */
  private handleSubmit(event: Event) {
    event.preventDefault();
    if (!this.value("receiverName"))
      return showToast("Receiver name cannot be empty", "error");
    if (this.value("receiverName").length > 20)
      return showToast("Receiver name cannot exceed 20 characters", "error");
    if (!this.value("phone"))
      return showToast("Phone number cannot be empty", "error");
    if (!/^1[3-9]\d{9}$/.test(this.value("phone")))
      return showToast("Phone number format is invalid", "error");
    if (!this.value("address"))
      return showToast("Address cannot be empty", "error");
    if (this.value("address").length > 100)
      return showToast("Address cannot exceed 100 characters", "error");
    if (!this.value("amount"))
      return showToast("Amount cannot be empty", "error");
    if (this.value("remark").length > 200)
      return showToast("Remark cannot exceed 200 characters", "error");
    showToast("Order created successfully");
    window.setTimeout(() => {
      navigate("/orders/list");
    }, 500);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "order-create-page": OrderCreate;
  }
}
