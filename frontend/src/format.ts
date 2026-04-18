/**
 * Format a rupee amount with a literal `₹` symbol + Indian digit grouping
 * (`₹1,23,456.78`). Rolled by hand so the symbol is consistent across
 * browsers — some locales render `Intl.NumberFormat(currency:"INR")` as
 * `INR 1,23,456.78` with no actual rupee glyph.
 */
export function fmtINR(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const [rupeesStr, paiseRaw = "00"] = abs.toFixed(2).split(".");
  const paise = paiseRaw.padEnd(2, "0").slice(0, 2);
  let grouped: string;
  if (rupeesStr.length <= 3) {
    grouped = rupeesStr;
  } else {
    const last3 = rupeesStr.slice(-3);
    const rest = rupeesStr.slice(0, -3);
    const chunks: string[] = [];
    let i = rest.length;
    while (i > 0) {
      chunks.unshift(rest.slice(Math.max(0, i - 2), i));
      i -= 2;
    }
    grouped = `${chunks.join(",")},${last3}`;
  }
  return `${sign}₹${grouped}.${paise}`;
}
