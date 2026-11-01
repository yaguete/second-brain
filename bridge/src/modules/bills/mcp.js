import { PublicError, mcpFail } from "../../shared/utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pool } from "../../shared/db.js";
import { openai, embed } from "../../shared/openai.js";
import { BILL_TYPE_PREFIX } from "./constants.js";
import { getBillChunks, getBillsByFilter, getOrExtractBill } from "./service.js";

export function createBillsMcpServer() {
  const mcp = new McpServer({ name: "bills", version: "1.0.0" });

  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  const fail = mcpFail;

  mcp.registerTool("search_bills", {
    title: "Search Bills",
    description: "Search personal utility bills and invoices (water, electricity, gas, rent, etc.) using semantic/meaning-based search. Returns the most relevant text fragments. Use when the user asks about utility costs, billing amounts, consumption, invoice details, or any household bill info.",
    inputSchema: z.object({
      query: z.string().describe("Natural language question or keywords to search for in the bills"),
      bill_type: z.string().optional().describe("Filter by type: 'agua', 'electricidad', 'gas', 'otro'"),
      since_date: z.string().optional().describe("Filter bills from this date (YYYY-MM)"),
      until_date: z.string().optional().describe("Filter bills up to this date (YYYY-MM)"),
      limit: z.number().optional().describe("Max results (default 10)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ query, bill_type, since_date, until_date, limit }) => {
    try {
      if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
      if (!openai) throw new PublicError(500, "not_configured", "OPENAI_API_KEY not configured");

      const docType = bill_type ? `${BILL_TYPE_PREFIX}${bill_type}` : undefined;
      const queryEmbedding = await embed(query);
      const vecStr = `[${queryEmbedding.join(",")}]`;

      let sql = `SELECT source, document_type, document_date, content,
        1 - (embedding <=> $1::vector) AS score
        FROM doc_chunks WHERE document_type LIKE $2`;
      const params = [vecStr, `${BILL_TYPE_PREFIX}%`];
      let idx = 3;

      if (docType) { sql += ` AND document_type = $${idx}`; params.push(docType); idx++; }
      if (since_date) { sql += ` AND document_date >= $${idx}`; params.push(since_date); idx++; }
      if (until_date) { sql += ` AND document_date <= $${idx}`; params.push(until_date); idx++; }

      sql += ` ORDER BY embedding <=> $1::vector LIMIT $${idx}`;
      params.push(limit || 10);

      const { rows } = await pool.query(sql, params);
      const results = rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, content: r.content, score: Math.round(r.score * 1000) / 1000 }));
      return ok({ query, count: results.length, results });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("list_bills", {
    title: "List Bills",
    description: "List all indexed utility bills and invoices showing what is available. Use when the user asks 'what bills do you have?' or 'which electricity invoices are indexed?'.",
    inputSchema: z.object({
      bill_type: z.string().optional().describe("Filter by type: 'agua', 'electricidad', 'gas', 'otro'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ bill_type }) => {
    try {
      if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
      let sql = `SELECT source, document_type, document_date, COUNT(*) AS chunk_count
                 FROM doc_chunks WHERE document_type LIKE $1`;
      const params = [`${BILL_TYPE_PREFIX}%`];
      if (bill_type) { sql += ` AND document_type = $2`; params.push(`${BILL_TYPE_PREFIX}${bill_type}`); }
      sql += ` GROUP BY source, document_type, document_date ORDER BY document_date DESC NULLS LAST, source`;
      const { rows } = await pool.query(sql, params);
      return ok({ count: rows.length, documents: rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, chunk_count: parseInt(r.chunk_count) })) });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_bill_content", {
    title: "Get Bill Content",
    description: "Retrieve the full text content of a specific bill by its filename. Use when the user asks to see a specific invoice or wants all details from a particular bill.",
    inputSchema: z.object({
      source: z.string().describe("Filename of the bill (e.g. 'AB 07.02.2024.pdf')")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ source }) => {
    try {
      if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
      const { rows } = await pool.query(
        "SELECT content, document_type, document_date FROM doc_chunks WHERE source = $1 AND document_type LIKE $2 ORDER BY created_at",
        [source, `${BILL_TYPE_PREFIX}%`]
      );
      if (rows.length === 0) throw new PublicError(404, "not_found", `Bill '${source}' not found`);
      const fullText = rows.map(r => r.content).join("\n\n");
      return ok({ source, document_type: rows[0].document_type, document_date: rows[0].document_date, chunk_count: rows.length, content: fullText });
    } catch (e) { return fail(e); }
  });

  // ── get_bill_consumption ──────────────────────────────────────────────────

  mcp.registerTool("get_bill_consumption", {
    title: "Get Bill Consumption",
    description: "Extract structured consumption data (kWh, m³, liters) from a specific utility bill. Use when the user asks 'how much electricity did I use?' or 'what was my water consumption in February?'.",
    inputSchema: z.object({
      source: z.string().describe("Filename of the bill (e.g. 'EL 19.08.2024.pdf')")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ source }) => {
    try {
      const bill = await getBillChunks(source);
      const payload = await getOrExtractBill(source, bill.text, "bills:consumption");
      return ok({
        source,
        bill_type: payload.bill_type ?? null,
        date: bill.document_date,
        consumption: payload.consumption ?? null,
        details: Array.isArray(payload.details) ? payload.details : []
      });
    } catch (e) { return fail(e); }
  });

  // ── get_bill_breakdown ────────────────────────────────────────────────────

  mcp.registerTool("get_bill_breakdown", {
    title: "Get Bill Breakdown",
    description: "Extract the full cost breakdown of a specific bill: total amount, line items (peak/valley hours, fixed charges, equipment rental, etc.), and taxes (IVA, IEE). Use when the user asks 'how much was my electricity bill?' or 'what are the charges on my water bill?'.",
    inputSchema: z.object({
      source: z.string().describe("Filename of the bill (e.g. 'AB 07.02.2024.pdf')")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ source }) => {
    try {
      const bill = await getBillChunks(source);
      const payload = await getOrExtractBill(source, bill.text, "bills:breakdown");
      return ok({
        source,
        bill_type: payload.bill_type ?? null,
        date: bill.document_date,
        total: payload.total ?? null,
        currency: payload.currency || "EUR",
        subtotal_before_tax: payload.subtotal_before_tax ?? null,
        items: Array.isArray(payload.items) ? payload.items : [],
        taxes: Array.isArray(payload.taxes) ? payload.taxes : []
      });
    } catch (e) { return fail(e); }
  });

  // ── get_consumption_trend ─────────────────────────────────────────────────

  mcp.registerTool("get_consumption_trend", {
    title: "Consumption Trend",
    description: "Show how consumption (kWh, m³, liters) has evolved over time for a specific utility type. Use when the user asks 'how has my electricity usage changed?' or 'show me water consumption trend'.",
    inputSchema: z.object({
      bill_type: z.string().describe("Type: 'agua', 'electricidad', 'gas'"),
      since_date: z.string().optional().describe("Start date (YYYY-MM)"),
      until_date: z.string().optional().describe("End date (YYYY-MM)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ bill_type, since_date, until_date }) => {
    try {
      const bills = await getBillsByFilter({ bill_type, since_date, until_date });
      if (bills.length === 0) return ok({ bill_type, count: 0, data_points: [], message: "No bills found for the given filters" });

      const dataPoints = [];
      for (const b of bills) {
        try {
          const payload = await getOrExtractBill(b.source, b.full_text, "bills:consumption_trend");
          const cons = payload.consumption || {};
          dataPoints.push({
            source: b.source,
            date: b.document_date,
            value: cons.value ?? null,
            unit: cons.unit ?? null
          });
        } catch {
          dataPoints.push({ source: b.source, date: b.document_date, value: null, unit: null });
        }
      }

      const valid = dataPoints.filter(d => d.value !== null);
      const avg = valid.length > 0 ? Math.round((valid.reduce((s, d) => s + d.value, 0) / valid.length) * 100) / 100 : null;
      const min = valid.length > 0 ? Math.min(...valid.map(d => d.value)) : null;
      const max = valid.length > 0 ? Math.max(...valid.map(d => d.value)) : null;

      return ok({ bill_type, count: dataPoints.length, unit: valid[0]?.unit || null, average: avg, min, max, data_points: dataPoints });
    } catch (e) { return fail(e); }
  });

  // ── get_spending_summary ──────────────────────────────────────────────────

  mcp.registerTool("get_spending_summary", {
    title: "Bills Spending Summary",
    description: "Get total spending on utility bills grouped by type (water, electricity, gas) over a period. Use when the user asks 'how much have I spent on utilities?' or 'what's my total electricity cost this year?'.",
    inputSchema: z.object({
      since_date: z.string().optional().describe("Start date (YYYY-MM)"),
      until_date: z.string().optional().describe("End date (YYYY-MM)"),
      bill_type: z.string().optional().describe("Filter by type: 'agua', 'electricidad', 'gas', 'otro'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ since_date, until_date, bill_type }) => {
    try {
      const bills = await getBillsByFilter({ bill_type, since_date, until_date });
      if (bills.length === 0) return ok({ count: 0, by_type: {}, grand_total: 0, message: "No bills found for the given filters" });

      const byType = {};
      let grandTotal = 0;

      for (const b of bills) {
        const shortType = b.document_type.replace(BILL_TYPE_PREFIX, "");
        if (!byType[shortType]) byType[shortType] = { count: 0, total: 0, bills: [] };

        try {
          const payload = await getOrExtractBill(b.source, b.full_text, "bills:spending_summary");
          const amount = payload.total || 0;
          byType[shortType].count++;
          byType[shortType].total = Math.round((byType[shortType].total + amount) * 100) / 100;
          byType[shortType].bills.push({ source: b.source, date: b.document_date, total: amount });
          grandTotal += amount;
        } catch {
          byType[shortType].count++;
          byType[shortType].bills.push({ source: b.source, date: b.document_date, total: null });
        }
      }

      for (const t of Object.keys(byType)) {
        byType[t].average = byType[t].count > 0 ? Math.round((byType[t].total / byType[t].count) * 100) / 100 : 0;
      }

      return ok({ count: bills.length, grand_total: Math.round(grandTotal * 100) / 100, currency: "EUR", by_type: byType });
    } catch (e) { return fail(e); }
  });

  // ── compare_bills ─────────────────────────────────────────────────────────

  mcp.registerTool("compare_bills", {
    title: "Compare Bills",
    description: "Compare two specific bills side by side: cost, consumption, and percentage changes. Use when the user asks 'compare my last two electricity bills' or 'how does this month's water bill compare to last month?'.",
    inputSchema: z.object({
      source_a: z.string().describe("Filename of the first bill"),
      source_b: z.string().describe("Filename of the second bill")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ source_a, source_b }) => {
    try {
      const [billA, billB] = await Promise.all([getBillChunks(source_a), getBillChunks(source_b)]);
      const [dataA, dataB] = await Promise.all([
        getOrExtractBill(source_a, billA.text, "bills:compare"),
        getOrExtractBill(source_b, billB.text, "bills:compare")
      ]);

      const costDelta = (dataA.total != null && dataB.total != null) ? Math.round((dataA.total - dataB.total) * 100) / 100 : null;
      const costPctChange = (dataB.total != null && dataB.total !== 0 && costDelta != null)
        ? Math.round(((dataA.total - dataB.total) / Math.abs(dataB.total)) * 10000) / 100 : null;

      const consA = dataA.consumption?.value;
      const consB = dataB.consumption?.value;
      const consDelta = (consA != null && consB != null) ? Math.round((consA - consB) * 100) / 100 : null;
      const consPctChange = (consB != null && consB !== 0 && consDelta != null)
        ? Math.round(((consA - consB) / Math.abs(consB)) * 10000) / 100 : null;

      return ok({
        bill_a: { source: source_a, date: billA.document_date, type: billA.document_type, total: dataA.total ?? null, consumption: dataA.consumption ?? null },
        bill_b: { source: source_b, date: billB.document_date, type: billB.document_type, total: dataB.total ?? null, consumption: dataB.consumption ?? null },
        comparison: {
          cost_delta: costDelta, cost_pct_change: costPctChange,
          consumption_delta: consDelta, consumption_pct_change: consPctChange,
          consumption_unit: dataA.consumption?.unit || dataB.consumption?.unit || null
        }
      });
    } catch (e) { return fail(e); }
  });

  return mcp;
}
