import type { UiState } from "@skail-purchase-approval/contracts";

export interface OrderFields {
  supplier: string;
  description: string;
  amount: string;
}

interface Props {
  fields: OrderFields;
  placeholders: OrderFields;
  ui: UiState;
  busy: boolean;
  onChange: (fields: OrderFields) => void;
  onStart: () => void;
}

export function OrderForm({ fields, placeholders, ui, busy, onChange, onStart }: Props) {
  const disabled = !ui.enabled || busy;
  return (
    <section className="form">
      <label htmlFor="supplier">
        Supplier
        <input
          id="supplier"
          type="text"
          maxLength={120}
          value={fields.supplier}
          placeholder={placeholders.supplier}
          disabled={disabled}
          onChange={(e) => onChange({ ...fields, supplier: e.target.value })}
        />
      </label>
      <label htmlFor="description">
        Description
        <input
          id="description"
          type="text"
          maxLength={120}
          value={fields.description}
          placeholder={placeholders.description}
          disabled={disabled}
          onChange={(e) => onChange({ ...fields, description: e.target.value })}
        />
      </label>
      <label htmlFor="amount">
        Amount
        <input
          id="amount"
          type="number"
          min="0.01"
          step="0.01"
          value={fields.amount}
          placeholder={placeholders.amount}
          disabled={disabled}
          onChange={(e) => onChange({ ...fields, amount: e.target.value })}
        />
      </label>
      <button id="start" type="button" disabled={disabled} onClick={onStart}>
        {ui.label}
      </button>
    </section>
  );
}
