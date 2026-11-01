import { PublicError, mcpFail } from "../../shared/utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pool } from "../../shared/db.js";
import { vectorSearch } from "./service.js";

export function createJobMcpServer() {
  const mcp = new McpServer({ name: "job", version: "1.0.0" });

  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  const fail = mcpFail;

  mcp.registerTool("search_documents", {
    title: "Search Documents",
    description: "Search your personal job-related documents (payslips, contracts, leave records, tax certificates, etc.) using semantic/meaning-based search. Returns the most relevant text fragments. Use when the user asks about salary, deductions, contract terms, leave periods, retention certificates, or any work-related document info.",
    inputSchema: z.object({
      query: z.string().describe("Natural language question or keywords to search for in the documents"),
      document_type: z.string().optional().describe("Filter by type: 'nomina', 'contrato', 'excedencia', 'certificado_retenciones', 'vida_laboral', 'finiquito', 'otro', or any custom type"),
      since_date: z.string().optional().describe("Filter documents from this date (YYYY-MM or YYYY-MM-DD)"),
      until_date: z.string().optional().describe("Filter documents up to this date"),
      limit: z.number().optional().describe("Max results (default 10)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ query, document_type, since_date, until_date, limit }) => {
    try {
      const results = await vectorSearch(query, {
        limit: limit || 10,
        documentType: document_type || undefined,
        sinceDate: since_date || undefined,
        untilDate: until_date || undefined
      });
      return ok({ query, count: results.length, results });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("list_documents", {
    title: "List Documents",
    description: "List all indexed job-related documents (payslips, contracts, etc.) showing what is available. Use when the user asks 'what documents do you have?' or 'which payslips are indexed?'.",
    inputSchema: z.object({
      document_type: z.string().optional().describe("Filter by type: 'nomina', 'contrato', 'excedencia', 'certificado_retenciones', 'vida_laboral', 'finiquito', 'otro'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ document_type }) => {
    try {
      if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
      let sql = `SELECT source, document_type, document_date, COUNT(*) AS chunk_count
                 FROM doc_chunks WHERE COALESCE(document_type, '') NOT LIKE 'factura_%'`;
      const params = [];
      if (document_type) { sql += ` AND document_type = $1`; params.push(document_type); }
      sql += ` GROUP BY source, document_type, document_date ORDER BY document_date DESC NULLS LAST, source`;
      const { rows } = await pool.query(sql, params);
      return ok({ count: rows.length, documents: rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, chunk_count: parseInt(r.chunk_count) })) });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_document_content", {
    title: "Get Document Content",
    description: "Retrieve the full text content of a specific document by its source name (filename). Use when the user says 'show me the contract', 'read my March payslip', or 'summarize the leave document'. Call list_documents first if you don't know the exact source name.",
    inputSchema: z.object({
      source: z.string().describe("Document source name (filename), e.g. 'nomina_2025_03.pdf' or 'contrato_2024.pdf'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ source }) => {
    try {
      if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
      const { rows } = await pool.query(
        "SELECT content, document_type, document_date FROM doc_chunks WHERE source = $1 AND COALESCE(document_type, '') NOT LIKE 'factura_%' ORDER BY created_at",
        [source]
      );
      if (rows.length === 0) throw new PublicError(404, "not_found", `Document '${source}' not found`);
      const fullText = rows.map(r => r.content).join("\n\n");
      return ok({ source, document_type: rows[0].document_type, document_date: rows[0].document_date, chunk_count: rows.length, content: fullText });
    } catch (e) { return fail(e); }
  });

  return mcp;
}
