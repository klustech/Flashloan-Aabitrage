/* global BigInt */
export const DEX_LABELS = {
  uniswap_v2: "Uniswap V2",
  uniswap_v3: "Uniswap V3",
  sushiswap: "SushiSwap",
  sushiswap_v2: "SushiSwap V2",
  pancake_v3: "Pancake V3",
  balancer: "Balancer",
  curve: "Curve",
};
export function formatUnits(value, decimals, precision = 6) {
  if (
    value === undefined ||
    value === null ||
    !Number.isInteger(decimals) ||
    decimals < 0
  )
    return "—";
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return "—";
  const negative = raw.startsWith("-"),
    digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals
    ? digits.slice(-decimals).slice(0, precision).replace(/0+$/, "")
    : "";
  const grouped = whole
    .replace(/^0+(?=\d)/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (grouped === "0" && !fraction && /[1-9]/.test(digits))
    return `${negative ? "−" : ""}<${(10 ** -precision).toFixed(precision)}`;
  return `${negative ? "−" : ""}${grouped}${fraction ? "." + fraction : ""}`;
}
export function number(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "—";
}
export function time(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
export const shortAddress = (value) =>
  value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
export function statusColor(value) {
  return (
    {
      SIMULATED: "info",
      INCLUDED: "success",
      SUBMITTED: "warning",
      REVERTED: "error",
      DROPPED: "default",
      PAPER: "info",
      LIVE_ARMED: "warning",
      LIVE_RUNNING: "error",
      PAUSED: "warning",
      STOPPED: "default",
    }[value] || "default"
  );
}
export const routeLabel = (record) =>
  record.route?.legs?.map((l) => DEX_LABELS[l.dex] || l.dex).join(" → ") ||
  record.route?.strategy ||
  (typeof record.route === "string" ? record.route : "Route unavailable");
export function positive(value) {
  return (
    value !== null &&
    value !== undefined &&
    /^\d+$/.test(String(value)) &&
    BigInt(value) > 0n
  );
}
