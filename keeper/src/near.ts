// Just enough NEAR to sign and send a function call from a Cloudflare Worker:
// base58, borsh for one transaction shape, and Ed25519 through WebCrypto.
// near-api-js is not used here because the free Workers plan allows 10 ms of
// CPU per run, and the platform's own Ed25519 costs almost none of it.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

class Writer {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff);
  }
  uint(v: bigint, bytes: number) {
    for (let i = 0; i < bytes; i++) this.parts.push(Number((v >> BigInt(8 * i)) & 0xffn));
  }
  raw(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  bytes(b: Uint8Array) {
    this.u32(b.length);
    this.raw(b);
  }
  str(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }
  out() {
    return Uint8Array.from(this.parts);
  }
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export interface Signer {
  accountId: string;
  publicKey: Uint8Array;
  publicKeyText: string;
  key: CryptoKey;
}

/** Accepts the near-cli format, `ed25519:<base58 of seed + public key>`. */
export async function signerFrom(accountId: string, privateKey: string): Promise<Signer> {
  const raw = b58decode(privateKey.replace(/^ed25519:/, ""));
  if (raw.length !== 64) throw new Error("expected a 64-byte ed25519 secret key");
  const seed = raw.slice(0, 32);
  const publicKey = raw.slice(32);
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed,
  ]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { accountId, publicKey, publicKeyText: `ed25519:${b58encode(publicKey)}`, key };
}

export function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** JSON-RPC error causes that mean "this endpoint, not this request": try the next one. */
const ENDPOINT_TROUBLE = new Set(["TIMEOUT_ERROR", "INTERNAL_ERROR", "NO_SYNCED_BLOCKS", "UNAVAILABLE_SHARD"]);

export class Rpc {
  private urls: string[];

  /** `urls` is a comma-separated list, tried in order on rate limits and endpoint failures. */
  constructor(urls: string) {
    this.urls = urls.split(",").map((u) => u.trim()).filter(Boolean);
  }

  async call<T = any>(method: string, params: unknown): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: "rigel", method, params });
    let last = "no RPC endpoint configured";
    for (const url of this.urls) {
      let j: any;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        j = await res.json();
      } catch (err) {
        last = `${url}: ${(err as Error).message}`;
        continue;
      }
      if (!j.error) return j.result as T;
      const cause = j.error.cause?.name;
      last = `${method}: ${JSON.stringify(j.error.cause ?? j.error.data ?? j.error)}`;
      // Rate limits (-429 and similar) and node trouble fall through; a real answer about the request does not.
      if (j.error.code === -429 || (cause && ENDPOINT_TROUBLE.has(cause))) {
        console.log(`${url} unavailable for ${method}, trying the next endpoint`);
        continue;
      }
      throw new Error(last);
    }
    throw new Error(last);
  }

  async view<T = any>(contract: string, method: string, args: unknown = {}): Promise<T> {
    const r = await this.call("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
    });
    if (r.error) throw new Error(`${contract}.${method}: ${r.error}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
  }

  /** Nonce and a recent block hash for the next transaction from this key. */
  async accessKey(s: Signer): Promise<{ nonce: bigint; blockHash: Uint8Array }> {
    const r = await this.call("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: s.accountId,
      public_key: s.publicKeyText,
    });
    return { nonce: BigInt(r.nonce), blockHash: b58decode(r.block_hash) };
  }

  /**
   * Signs and sends one function call, waits for it to execute, and returns the
   * decoded return value. Throws with the contract's message when it fails.
   */
  async functionCall(
    s: Signer,
    nonce: bigint,
    blockHash: Uint8Array,
    receiver: string,
    method: string,
    args: unknown,
    gas: bigint,
  ): Promise<unknown> {
    const w = new Writer();
    w.str(s.accountId);
    w.u8(0); // ed25519
    w.raw(s.publicKey);
    w.uint(nonce, 8);
    w.str(receiver);
    w.raw(blockHash);
    w.u32(1); // one action
    w.u8(2); // FunctionCall
    w.str(method);
    w.bytes(new TextEncoder().encode(JSON.stringify(args)));
    w.uint(gas, 8);
    w.uint(0n, 16); // no deposit
    const tx = w.out();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, s.key, hash));
    const signed = new Uint8Array(tx.length + 65);
    signed.set(tx);
    signed[tx.length] = 0;
    signed.set(sig, tx.length + 1);

    const r: any = await this.call("send_tx", {
      signed_tx_base64: toBase64(signed),
      wait_until: "EXECUTED_OPTIMISTIC",
    });
    const status = r.status ?? {};
    if (status.Failure) throw new Error(JSON.stringify(status.Failure).slice(0, 300));
    if (typeof status.SuccessValue === "string") {
      const text = atob(status.SuccessValue);
      return text ? JSON.parse(text) : null;
    }
    return null;
  }
}
