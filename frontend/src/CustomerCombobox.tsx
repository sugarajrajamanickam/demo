import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Customer, JobType } from "./api";

interface Props {
  customers: Customer[];
  selected: Customer | null;
  onSelect: (c: Customer | null) => void;
  disabled?: boolean;
  placeholder?: string;
  noCustomersHint?: React.ReactNode;
  "data-testid"?: string;
}

function boreLabel(bt: JobType | string): string {
  if (bt === "re_bore") return "Re-Bore";
  if (bt === "new_bore") return "New Bore";
  return bt || "—";
}

function fmtSelected(c: Customer): string {
  return `${c.name} — ${c.phone}`;
}

export default function CustomerCombobox({
  customers,
  selected,
  onSelect,
  disabled,
  placeholder = "Search customer by name or phone…",
  noCustomersHint,
  "data-testid": testId = "customer-combobox",
}: Props) {
  const [query, setQuery] = useState<string>(selected ? fmtSelected(selected) : "");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Tracks when the selection was cleared by the user typing, so the
  // sync-from-props effect doesn't overwrite the keystroke they just made.
  const isTypingRef = useRef(false);
  const listboxId = useId();

  // Keep the input text in sync when the parent changes the selection from
  // outside (e.g. resetting the form). Skip when the clear originated from
  // the user typing in the input.
  useEffect(() => {
    if (isTypingRef.current) {
      isTypingRef.current = false;
      return;
    }
    setQuery(selected ? fmtSelected(selected) : "");
  }, [selected]);

  const matches = useMemo(() => {
    const raw = query.trim().toLowerCase();
    // If the current query exactly matches the selected customer's display,
    // treat it as "no filter" so the user can see other options when they
    // open the dropdown.
    const selectedDisplay = selected ? fmtSelected(selected).toLowerCase() : "";
    const q = raw === selectedDisplay ? "" : raw;
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q),
    );
  }, [customers, query, selected]);

  useEffect(() => {
    if (activeIdx >= matches.length) setActiveIdx(Math.max(0, matches.length - 1));
  }, [matches.length, activeIdx]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const commit = useCallback(
    (c: Customer) => {
      onSelect(c);
      setQuery(fmtSelected(c));
      setOpen(false);
    },
    [onSelect],
  );

  const clear = useCallback(() => {
    onSelect(null);
    setQuery("");
    setOpen(true);
    inputRef.current?.focus();
  }, [onSelect]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (open && matches[activeIdx]) {
        e.preventDefault();
        commit(matches[activeIdx]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  if (customers.length === 0 && noCustomersHint) {
    return <div className="customer-combobox empty">{noCustomersHint}</div>;
  }

  return (
    <div className="customer-combobox" ref={rootRef} data-testid={testId}>
      <div className="customer-combobox-input-row">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listboxId}
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(0);
            // typing invalidates any existing selection. Mark the sync
            // effect to skip once so the user's keystroke isn't erased.
            if (selected) {
              isTypingRef.current = true;
              onSelect(null);
            }
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          data-testid={`${testId}-input`}
        />
        {selected && !disabled && (
          <button
            type="button"
            className="customer-combobox-clear"
            aria-label="Clear selection"
            onClick={clear}
            data-testid={`${testId}-clear`}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="customer-combobox-list"
          data-testid={`${testId}-list`}
        >
          {matches.length === 0 && (
            <li className="customer-combobox-empty">No customers match</li>
          )}
          {matches.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={selected?.id === c.id}
              className={`customer-combobox-option${
                i === activeIdx ? " active" : ""
              }${selected?.id === c.id ? " selected" : ""}`}
              onMouseDown={(e) => {
                // prevent input blur before click fires
                e.preventDefault();
                commit(c);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              data-testid={`${testId}-option-${c.id}`}
            >
              <span className="customer-combobox-option-name">{c.name}</span>
              <span className="customer-combobox-option-phone">{c.phone}</span>
              <span className="customer-combobox-option-boretype">
                {boreLabel(c.bore_type)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
