import { YOCTO } from "./near";

/** yoctoNEAR string to a short decimal NEAR string. */
export function near(yocto: string | bigint, digits = 4): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits);
  return digits > 0 ? `${whole}.${frac}` : whole.toString();
}

/** Decimal NEAR input to yoctoNEAR. Throws on anything that is not a plain amount. */
export function toYocto(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{0,24})?$/.test(s)) throw new Error("enter an amount like 1.5");
  const [w, f = ""] = s.split(".");
  return BigInt(w) * YOCTO + BigInt(f.padEnd(24, "0"));
}

/** A raw price at an exponent, as a USD string. */
export function usd(raw: string | number, expo: number, digits = 4): string {
  return (Number(raw) * 10 ** expo).toFixed(digits);
}

export function bps(v: number): string {
  return `${(v / 100).toFixed(2)}%`;
}

/** Seconds as "4m 05s" or "1h 02m". */
export function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function clock(unix: string | number): string {
  return new Date(Number(unix) * 1000).toISOString().slice(11, 19) + " UTC";
}
