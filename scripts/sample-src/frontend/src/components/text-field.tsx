import { LitElement, customElement, property } from "@yukino.js/lit-jsx";

/**
 * Labeled form input. The label / prop / placeholder attributes are the
 * exact copies the static analyzer extracts to build form-field steps.
 * Renders into light DOM so the global Tailwind utilities apply.
 */
@customElement("text-field")
export class TextField extends LitElement {
  @property() label = "";
  @property() prop = "";
  @property() placeholder = "";
  @property({ type: Boolean }) required = false;
  @property() value = "";

  protected override createRenderRoot() {
    return this;
  }

  render() {
    return (
      <>
        <span class="mb-1.5 block text-[13px] font-medium text-slate-700">
          {this.label}
          {this.required && <span class="ml-0.5 text-red-600">*</span>}
        </span>
        <input
          class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-transparent focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          value={this.value}
          placeholder={this.placeholder}
          onInput={this.handleInput}
        />
      </>
    );
  }

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.value = input.value;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "text-field": TextField;
  }
}
