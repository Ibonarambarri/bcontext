/**
 * QuickBooks Online — `quickbooks` → Nango `quickbooks` (OAuth2; proxy base
 * https://quickbooks.api.intuit.com; connection_config.realmId is the company
 * id, `config.realm_id` is the fallback when Nango did not capture it).
 *
 * One query per entity (Invoice, Estimate, Bill, Payment — or the
 * `config.entities` allow-list) through the SQL-ish query endpoint:
 *   GET /v3/company/{realmId}/query?query=SELECT * FROM Invoice
 *       WHERE MetaData.LastUpdatedTime > '<since>' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 100
 * Amounts are rounded to whole currency units — NEXO needs "invoice 1042 to
 * Acme is overdue", not cents. Customer / vendor names only, never emails.
 *
 * Assumptions: the datetime literal accepts an ISO string with a `+00:00`
 * offset (Intuit's examples use `-08:00`), and the response envelope is
 * `{ QueryResponse: { <Entity>: [...] } }`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, str, type NangoAdapter } from "./shared";

interface QboRef {
  value?: string;
  name?: string;
}
interface QboLine {
  Description?: string;
  Amount?: number;
  DetailType?: string;
}
interface QboEntity {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  TxnStatus?: string;
  EmailStatus?: string;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  CustomerRef?: QboRef;
  VendorRef?: QboRef;
  CurrencyRef?: QboRef;
  PaymentMethodRef?: QboRef;
  Line?: QboLine[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export const QUICKBOOKS_ENTITIES = ["Invoice", "Estimate", "Bill", "Payment"] as const;
type QboEntityName = (typeof QUICKBOOKS_ENTITIES)[number];

const APP_PATH: Record<QboEntityName, string> = {
  Invoice: "invoice",
  Estimate: "estimate",
  Bill: "bill",
  Payment: "recvpayment",
};

/** QuickBooks wants an ISO datetime with an explicit offset in the WHERE literal. */
export function quickbooksSinceLiteral(since: Date): string {
  return `${since.toISOString().replace(/\.\d{3}Z$/, "")}+00:00`;
}

export function quickbooksQuery(entity: string, since: Date, max: number): string {
  return `SELECT * FROM ${entity} WHERE MetaData.LastUpdatedTime > '${quickbooksSinceLiteral(since)}' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS ${max}`;
}

function money(amount: number | undefined, currency?: string): string | null {
  if (typeof amount !== "number") return null;
  return `≈${Math.round(amount)} ${currency ?? ""}`.trim();
}

/** Invoice/Estimate/Bill/Payment → the lines NEXO needs. */
export function quickbooksEntityText(entity: QboEntityName, e: QboEntity): string {
  const currency = e.CurrencyRef?.value;
  const party = e.CustomerRef?.name ?? e.VendorRef?.name;
  const lines: Array<string | null> = [
    `Type: ${entity}${e.DocNumber ? ` #${e.DocNumber}` : ""}`,
    party ? `${e.VendorRef ? "Vendor" : "Customer"}: ${party}` : null,
    e.TxnDate ? `Date: ${e.TxnDate}${e.DueDate ? ` · Due: ${e.DueDate}` : ""}` : null,
    money(e.TotalAmt, currency) ? `Total: ${money(e.TotalAmt, currency)}` : null,
    typeof e.Balance === "number" && entity !== "Payment" ? `Balance due: ${money(e.Balance, currency)}` : null,
    e.TxnStatus ? `Status: ${e.TxnStatus}` : null,
    e.EmailStatus ? `Email status: ${e.EmailStatus}` : null,
    e.PaymentMethodRef?.name ? `Method: ${e.PaymentMethodRef.name}` : null,
    e.CustomerMemo?.value ? `Memo: ${e.CustomerMemo.value}` : null,
    e.PrivateNote ? `Note: ${e.PrivateNote}` : null,
  ];
  const items = (e.Line ?? [])
    .filter((l) => l.Description || typeof l.Amount === "number")
    .filter((l) => l.DetailType !== "SubTotalLineDetail")
    .slice(0, 12)
    .map((l) => `- ${l.Description ?? "(line)"}${typeof l.Amount === "number" ? ` · ${money(l.Amount, currency)}` : ""}`);
  if (items.length) lines.push("", "Lines:", ...items);
  return clip(lines.filter((l): l is string => l !== null).join("\n"));
}

export const quickbooksAdapter: NangoAdapter = {
  id: "quickbooks",
  provider: "quickbooks",
  sourceHint: "quickbooks:transactions",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const realmId = str(connectionConfig.realmId) || configString(config, "realm_id");
    if (!realmId) return { signals: [], stats: { missing_realm_id: 1 } };
    const wanted = allowList(config, "entities");
    const entities = QUICKBOOKS_ENTITIES.filter((e) => !wanted || wanted.map((w) => w.toLowerCase()).includes(e.toLowerCase()));
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    for (const entity of entities) {
      const res = await client.proxy<{ QueryResponse?: Record<string, QboEntity[] | number | undefined> }>({
        method: "GET",
        providerConfigKey: "quickbooks",
        connectionId,
        path: `/v3/company/${encodeURIComponent(realmId)}/query`,
        query: { query: quickbooksQuery(entity, since, Math.min(100, limit)), minorversion: 73 },
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`quickbooks ${entity} query failed (${res.status})`);
      const rows = res.data?.QueryResponse?.[entity];
      const list = Array.isArray(rows) ? rows : [];
      stats[entity.toLowerCase()] = list.length;
      for (const e of list) {
        const party = e.CustomerRef?.name ?? e.VendorRef?.name;
        signals.push({
          external_id: `${entity.toLowerCase()}:${e.Id}`,
          title: `${entity}${e.DocNumber ? ` #${e.DocNumber}` : ` ${e.Id}`}${party ? ` · ${party}` : ""}`,
          text: quickbooksEntityText(entity, e),
          url: `https://app.qbo.intuit.com/app/${APP_PATH[entity]}?txnId=${encodeURIComponent(e.Id)}`,
          at: e.MetaData?.LastUpdatedTime,
          kind_hint: entity.toLowerCase(),
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
