/**
 * Xero — `xero` → Nango `xero` (OAuth2; proxy base https://api.xero.com).
 *
 * A Xero token spans organisations ("tenants"): `GET /connections` lists
 * them and every accounting call carries `xero-tenant-id` (the first tenant,
 * or `config.tenant_id`). Invoices, quotes and contacts modified since the
 * cursor come from the Accounting API with `If-Modified-Since` (Xero takes an
 * ISO-8601 instant without milliseconds), newest first, up to 3 pages each.
 * Amounts are rounded to whole currency units; contact emails are never
 * copied.
 *
 * Xero serialises dates as `/Date(1699000000000+0000)/` — `xeroDate` turns
 * that (or a plain ISO string) into ISO.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface XeroConnection {
  tenantId?: string;
  tenantName?: string;
  tenantType?: string;
}
interface XeroContactRef {
  ContactID?: string;
  Name?: string;
}
interface XeroLineItem {
  Description?: string;
  Quantity?: number;
  LineAmount?: number;
}
interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Reference?: string;
  Contact?: XeroContactRef;
  Date?: string;
  DueDate?: string;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  CurrencyCode?: string;
  LineItems?: XeroLineItem[];
  UpdatedDateUTC?: string;
}
interface XeroQuote {
  QuoteID: string;
  QuoteNumber?: string;
  Status?: string;
  Title?: string;
  Summary?: string;
  Terms?: string;
  Reference?: string;
  Contact?: XeroContactRef;
  Date?: string;
  ExpiryDate?: string;
  Total?: number;
  CurrencyCode?: string;
  LineItems?: XeroLineItem[];
  UpdatedDateUTC?: string;
}
interface XeroContact {
  ContactID: string;
  Name?: string;
  ContactStatus?: string;
  IsSupplier?: boolean;
  IsCustomer?: boolean;
  UpdatedDateUTC?: string;
  Balances?: { AccountsReceivable?: { Outstanding?: number; Overdue?: number }; AccountsPayable?: { Outstanding?: number; Overdue?: number } };
}

export const XERO_RESOURCES = ["invoices", "quotes", "contacts"] as const;
type XeroResource = (typeof XERO_RESOURCES)[number];

/** `/Date(1699000000000+0000)/` or ISO → ISO; unknown → undefined. */
export function xeroDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(raw);
  if (m) return new Date(Number(m[1])).toISOString();
  // Xero's plain ISO strings carry no zone and are UTC.
  const parsed = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Xero's If-Modified-Since wants an ISO instant without milliseconds. */
export function xeroIfModifiedSince(since: Date): string {
  return since.toISOString().replace(/\.\d{3}Z$/, "");
}

function money(amount: number | undefined, currency?: string): string | null {
  if (typeof amount !== "number") return null;
  return `≈${Math.round(amount)} ${currency ?? ""}`.trim();
}

function lineItems(items: XeroLineItem[] | undefined, currency?: string): string[] {
  return (items ?? [])
    .filter((l) => l.Description)
    .slice(0, 12)
    .map((l) => `- ${l.Description}${typeof l.LineAmount === "number" ? ` · ${money(l.LineAmount, currency)}` : ""}`);
}

export function xeroInvoiceText(i: XeroInvoice): string {
  const kind = i.Type === "ACCPAY" ? "Bill (payable)" : "Invoice (receivable)";
  const lines: Array<string | null> = [
    `Type: ${kind}${i.InvoiceNumber ? ` #${i.InvoiceNumber}` : ""} · Status: ${i.Status ?? "?"}`,
    i.Contact?.Name ? `Contact: ${i.Contact.Name}` : null,
    xeroDate(i.Date) ? `Date: ${xeroDate(i.Date)?.slice(0, 10)}${xeroDate(i.DueDate) ? ` · Due: ${xeroDate(i.DueDate)?.slice(0, 10)}` : ""}` : null,
    money(i.Total, i.CurrencyCode) ? `Total: ${money(i.Total, i.CurrencyCode)}` : null,
    typeof i.AmountDue === "number" ? `Amount due: ${money(i.AmountDue, i.CurrencyCode)}` : null,
    i.Reference ? `Reference: ${i.Reference}` : null,
  ];
  const items = lineItems(i.LineItems, i.CurrencyCode);
  if (items.length) lines.push("", "Lines:", ...items);
  return clip(lines.filter((l): l is string => l !== null).join("\n"));
}

export function xeroQuoteText(q: XeroQuote): string {
  const lines: Array<string | null> = [
    `Type: Quote${q.QuoteNumber ? ` #${q.QuoteNumber}` : ""} · Status: ${q.Status ?? "?"}`,
    q.Contact?.Name ? `Contact: ${q.Contact.Name}` : null,
    q.Title ? `Title: ${q.Title}` : null,
    xeroDate(q.Date) ? `Date: ${xeroDate(q.Date)?.slice(0, 10)}${xeroDate(q.ExpiryDate) ? ` · Expires: ${xeroDate(q.ExpiryDate)?.slice(0, 10)}` : ""}` : null,
    money(q.Total, q.CurrencyCode) ? `Total: ${money(q.Total, q.CurrencyCode)}` : null,
    q.Reference ? `Reference: ${q.Reference}` : null,
    q.Summary ? `Summary: ${q.Summary}` : null,
    q.Terms ? `Terms: ${q.Terms}` : null,
  ];
  const items = lineItems(q.LineItems, q.CurrencyCode);
  if (items.length) lines.push("", "Lines:", ...items);
  return clip(lines.filter((l): l is string => l !== null).join("\n"));
}

export function xeroContactText(c: XeroContact): string {
  const roles = [c.IsCustomer ? "customer" : null, c.IsSupplier ? "supplier" : null].filter(Boolean).join(", ");
  const ar = c.Balances?.AccountsReceivable;
  const ap = c.Balances?.AccountsPayable;
  return [
    `Type: Contact${roles ? ` (${roles})` : ""} · Status: ${c.ContactStatus ?? "?"}`,
    ar && (ar.Outstanding || ar.Overdue) ? `Receivable: outstanding ≈${Math.round(ar.Outstanding ?? 0)} · overdue ≈${Math.round(ar.Overdue ?? 0)}` : null,
    ap && (ap.Outstanding || ap.Overdue) ? `Payable: outstanding ≈${Math.round(ap.Outstanding ?? 0)} · overdue ≈${Math.round(ap.Overdue ?? 0)}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export const xeroAdapter: NangoAdapter = {
  id: "xero",
  provider: "xero",
  sourceHint: "xero:accounting",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    let tenantId = configString(config, "tenant_id");
    let tenantName: string | undefined;
    if (!tenantId) {
      const conn = await client.proxy<XeroConnection[]>({ method: "GET", providerConfigKey: "xero", connectionId, path: "/connections" });
      if (!conn.ok) throw new Error(`xero connections failed (${conn.status})`);
      const first = (Array.isArray(conn.data) ? conn.data : []).find((c) => c.tenantId);
      tenantId = first?.tenantId ?? null;
      tenantName = first?.tenantName;
    }
    if (!tenantId) return { signals: [], stats: { missing_tenant: 1 } };

    const wanted = allowList(config, "resources");
    const resources = XERO_RESOURCES.filter((r) => !wanted || wanted.map((w) => w.toLowerCase()).includes(r));
    const headers = {
      "xero-tenant-id": tenantId,
      "If-Modified-Since": xeroIfModifiedSince(since),
      Accept: "application/json",
    };
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    const isRecent = (raw: string | undefined) => {
      const at = xeroDate(raw);
      return !at || new Date(at) > since;
    };

    for (const resource of resources) {
      for (let page = 1; page <= 3 && signals.length < limit; page += 1) {
        const path = resource === "invoices" ? "/api.xro/2.0/Invoices" : resource === "quotes" ? "/api.xro/2.0/Quotes" : "/api.xro/2.0/Contacts";
        const res = await client.proxy<{ Invoices?: XeroInvoice[]; Quotes?: XeroQuote[]; Contacts?: XeroContact[] }>({
          method: "GET",
          providerConfigKey: "xero",
          connectionId,
          path,
          query: { order: "UpdatedDateUTC DESC", page },
          headers,
        });
        if (res.status === 304) break;
        if (!res.ok) throw new Error(`xero ${resource} failed (${res.status})`);
        const rows: Array<XeroInvoice | XeroQuote | XeroContact> =
          resource === "invoices" ? (res.data?.Invoices ?? []) : resource === "quotes" ? (res.data?.Quotes ?? []) : (res.data?.Contacts ?? []);
        stats[resource] = (stats[resource] ?? 0) + rows.length;
        for (const row of rows) {
          if (!isRecent(row.UpdatedDateUTC)) continue;
          if (resource === "invoices") {
            const i = row as XeroInvoice;
            const receivable = i.Type !== "ACCPAY";
            signals.push({
              external_id: `invoice:${i.InvoiceID}`,
              title: `${receivable ? "Invoice" : "Bill"}${i.InvoiceNumber ? ` #${i.InvoiceNumber}` : ""}${i.Contact?.Name ? ` · ${i.Contact.Name}` : ""}`,
              text: xeroInvoiceText(i),
              url: `https://go.xero.com/${receivable ? "AccountsReceivable" : "AccountsPayable"}/View.aspx?InvoiceID=${encodeURIComponent(i.InvoiceID)}`,
              at: xeroDate(i.UpdatedDateUTC),
              kind_hint: receivable ? "invoice" : "bill",
            });
          } else if (resource === "quotes") {
            const q = row as XeroQuote;
            signals.push({
              external_id: `quote:${q.QuoteID}`,
              title: `Quote${q.QuoteNumber ? ` #${q.QuoteNumber}` : ""}${q.Contact?.Name ? ` · ${q.Contact.Name}` : ""}${q.Title ? ` · ${q.Title}` : ""}`,
              text: xeroQuoteText(q),
              at: xeroDate(q.UpdatedDateUTC),
              kind_hint: "quote",
            });
          } else {
            const c = row as XeroContact;
            signals.push({
              external_id: `contact:${c.ContactID}`,
              title: `Contact · ${c.Name ?? c.ContactID}`,
              text: xeroContactText(c),
              url: `https://go.xero.com/Contacts/View/${encodeURIComponent(c.ContactID)}`,
              at: xeroDate(c.UpdatedDateUTC),
              kind_hint: "contact",
            });
          }
          if (signals.length >= limit) break;
        }
        if (rows.length < 100) break;
      }
    }
    if (tenantName) stats.tenant_named = 1;
    return { signals: signals.slice(0, limit), stats };
  },
};
