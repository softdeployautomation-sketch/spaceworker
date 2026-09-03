import "server-only";

const TOLERANCE = 0.05; // ±5%

// Helper shared by /api/billing/submit and the internal poller: a failed check whose
// note indicates the transaction simply isn't visible yet should stay "pending"
// (it may confirm soon) rather than being flagged for manual review.
export function isPendingNote(note: string): boolean {
  const n = note.toLowerCase();
  return n.includes("not found") || n.includes("no usdt transfers found");
}

// ── BTC via blockchain.info ──────────────────────────────────────────────────

async function getBtcPriceUsd(): Promise<number> {
  const res = await fetch("https://blockchain.info/ticker", { next: { revalidate: 0 } });
  const data = (await res.json()) as Record<string, { last: number }>;
  return data.USD.last;
}

export async function verifyBtcPayment(
  txHash: string,
  toAddress: string,
  amountUsd: number
): Promise<{ ok: boolean; note: string }> {
  try {
    const btcPrice = await getBtcPriceUsd();
    const expectedBtc = amountUsd / btcPrice;

    // Fetch wallet's recent transactions
    const res = await fetch(`https://blockchain.info/rawaddr/${toAddress}?limit=50`, {
      next: { revalidate: 0 },
    });
    if (!res.ok) return { ok: false, note: `blockchain.info error: ${res.status}` };
    const data = (await res.json()) as {
      txs: Array<{ hash: string; out: Array<{ addr: string; value: number }> }>;
    };

    const tx = data.txs.find((t) => t.hash === txHash);
    if (!tx) return { ok: false, note: "Transaction not found in recent wallet history" };

    // Sum outputs to our address (value is in satoshis)
    const receivedSatoshis = tx.out
      .filter((o) => o.addr === toAddress)
      .reduce((sum, o) => sum + o.value, 0);
    const receivedBtc = receivedSatoshis / 100_000_000;

    const ratio = receivedBtc / expectedBtc;
    if (ratio < 1 - TOLERANCE || ratio > 1 + TOLERANCE) {
      return {
        ok: false,
        note: `Amount out of tolerance: received ${receivedBtc.toFixed(8)} BTC, expected ~${expectedBtc.toFixed(8)} BTC (±5%)`,
      };
    }
    return { ok: true, note: `Received ${receivedBtc.toFixed(8)} BTC — within tolerance` };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ── USDT-TRC20 via Tronscan ──────────────────────────────────────────────────

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

export async function verifyUsdtPayment(
  txHash: string,
  toAddress: string,
  amountUsd: number
): Promise<{ ok: boolean; note: string }> {
  try {
    const res = await fetch(
      `https://apilist.tronscanapi.com/api/transfer/trc20?address=${toAddress}&trc20Id=${USDT_TRC20_CONTRACT}&count=true&limit=50&start=0`,
      { next: { revalidate: 0 } }
    );
    if (!res.ok) return { ok: false, note: `Tronscan error: ${res.status}` };
    const data = (await res.json()) as {
      confirmed?: boolean;
      token_transfers?: Array<{
        transaction_id: string;
        quant: string; // amount in base units (6 decimals for USDT-TRC20)
        confirmed: boolean;
      }>;
    };

    // Tronscan returns this shape when address has no transactions
    if (typeof data.confirmed !== "boolean" && !data.token_transfers) {
      return { ok: false, note: "No USDT transfers found for this address" };
    }

    const tx = (data.token_transfers ?? []).find((t) => t.transaction_id === txHash);
    if (!tx) return { ok: false, note: "Transaction not found in recent transfers" };

    // USDT-TRC20 uses 6 decimal places
    const receivedUsdt = Number(tx.quant) / 1_000_000;
    const ratio = receivedUsdt / amountUsd;
    if (ratio < 1 - TOLERANCE || ratio > 1 + TOLERANCE) {
      return {
        ok: false,
        note: `Amount out of tolerance: received ${receivedUsdt.toFixed(2)} USDT, expected ~${amountUsd.toFixed(2)} USDT (±5%)`,
      };
    }
    return { ok: true, note: `Received ${receivedUsdt.toFixed(2)} USDT — within tolerance` };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : "Unknown error" };
  }
}