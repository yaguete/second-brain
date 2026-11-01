import { PublicError, mcpFail } from "../../shared/utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pool } from "../../shared/db.js";
import { brainVectorSearch } from "./service.js";

export function createBrainMcpServer() {
  const mcp = new McpServer({ name: "brain", version: "1.0.0" });

  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  const fail = mcpFail;

  mcp.registerTool(
    "search_brain",
    {
      title: "Search Brain",
      description:
        "Semantic search over the user's Obsidian wiki (sources, entities, concepts, synthesis) indexed as brain RAG. Use for personal knowledge, work context, projects, people, and synthesized notes.",
      inputSchema: z.object({
        query: z.string().describe("Natural language question or keywords"),
        page_type: z
          .string()
          .optional()
          .describe("Filter: 'source', 'entity', 'concept', 'synthesis'"),
        tag: z.string().optional().describe("Filter chunks that include this tag in frontmatter tags"),
        since_date: z
          .string()
          .optional()
          .describe("Legacy filter from date YYYY-MM-DD or YYYY-MM (uses COALESCE(event_date, document_date))"),
        until_date: z
          .string()
          .optional()
          .describe("Legacy filter until date (uses COALESCE(event_date, document_date))"),
        since_event_date: z.string().optional().describe("Filter event_date from YYYY-MM-DD or YYYY-MM"),
        until_event_date: z.string().optional().describe("Filter event_date until date"),
        since_document_date: z.string().optional().describe("Filter document_date from YYYY-MM-DD or YYYY-MM"),
        until_document_date: z.string().optional().describe("Filter document_date until date"),
        limit: z.number().optional().describe("Max results (default 10)")
      }),
      annotations: { readOnlyHint: true }
    },
    async ({
      query,
      page_type,
      tag,
      since_date,
      until_date,
      since_event_date,
      until_event_date,
      since_document_date,
      until_document_date,
      limit
    }) => {
      try {
        const results = await brainVectorSearch(query, {
          limit: limit || 10,
          pageType: page_type || undefined,
          tag: tag || undefined,
          sinceDate: since_date || undefined,
          untilDate: until_date || undefined,
          sinceEventDate: since_event_date || undefined,
          untilEventDate: until_event_date || undefined,
          sinceDocumentDate: since_document_date || undefined,
          untilDocumentDate: until_document_date || undefined
        });
        return ok({ query, count: results.length, results });
      } catch (e) {
        return fail(e);
      }
    }
  );

  mcp.registerTool(
    "list_brain_pages",
    {
      title: "List Brain Pages",
      description: "List indexed wiki pages (grouped by source file) in the brain RAG index.",
      inputSchema: z.object({
        page_type: z.string().optional().describe("Filter by page type: source, entity, concept, synthesis")
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ page_type }) => {
      try {
        if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
        let sql = `SELECT source, page_type, title, document_date, event_date, COUNT(*) AS chunk_count
                   FROM brain_chunks`;
        const params = [];
        if (page_type) {
          sql += ` WHERE page_type = $1`;
          params.push(page_type);
        }
        sql += ` GROUP BY source, page_type, title, document_date, event_date
                 ORDER BY event_date DESC NULLS LAST, document_date DESC NULLS LAST, source`;
        const { rows } = await pool.query(sql, params);
        return ok({
          count: rows.length,
          documents: rows.map((r) => ({
            source: r.source,
            page_type: r.page_type,
            title: r.title,
            document_date: r.document_date,
            event_date: r.event_date,
            chunk_count: parseInt(r.chunk_count, 10)
          }))
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  mcp.registerTool(
    "get_brain_page",
    {
      title: "Get Brain Page",
      description: "Full text of an indexed wiki page by source filename (e.g. entity-foo.md).",
      inputSchema: z.object({
        source: z.string().describe("Wiki markdown filename, e.g. 'entity-harbor-permits.md'")
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ source }) => {
      try {
        if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
        const { rows } = await pool.query(
          `SELECT content, page_type, title, tags, document_date, event_date
           FROM brain_chunks
           WHERE source = $1
           ORDER BY chunk_index NULLS LAST, created_at, id`,
          [source]
        );
        if (rows.length === 0) throw new PublicError(404, "not_found", `Page '${source}' not found`);
        const fullText = rows.map((r) => r.content).join("\n\n");
        return ok({
          source,
          page_type: rows[0].page_type,
          title: rows[0].title,
          tags: rows[0].tags,
          document_date: rows[0].document_date,
          event_date: rows[0].event_date,
          chunk_count: rows.length,
          content: fullText
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  mcp.registerTool(
    "find_related",
    {
      title: "Find Related Brain Pages",
      description: "Semantic search phrased as 'related to X' — same embedding search as search_brain with an explicit use-case hint for the model.",
      inputSchema: z.object({
        topic: z.string().describe("Topic, entity name, or concept to find related wiki content for"),
        page_type: z.string().optional().describe("Optional filter: source, entity, concept, synthesis"),
        limit: z.number().optional().describe("Max results (default 8)")
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ topic, page_type, limit }) => {
      try {
        const results = await brainVectorSearch(topic, {
          limit: limit || 8,
          pageType: page_type || undefined
        });
        return ok({ topic, count: results.length, results });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return mcp;
}
