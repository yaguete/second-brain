import { sendError } from "../../../shared/utils.js";
import { ynabFetch, ynabPost, ynabPut, ynabDelete } from "../client.js";
import { mapScheduledTransaction } from "../utils.js";

export function register(app) {
  app.get("/v1/scheduled-transactions", async (req, res) => {
    const { budget_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/scheduled_transactions`);
      const scheduled_transactions = data?.data?.scheduled_transactions?.map(mapScheduledTransaction) ?? [];
      res.json({ scheduled_transactions });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/scheduled-transactions/:scheduled_transaction_id", async (req, res) => {
    const { budget_id } = req.query;
    const { scheduled_transaction_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/scheduled_transactions/${scheduled_transaction_id}`);
      res.json({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post("/v1/scheduled-transactions", async (req, res) => {
    const { budget_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const body = req.body;
      const data = await ynabPost(`/budgets/${budget_id}/scheduled_transactions`, body);
      res.status(201).json({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.put("/v1/scheduled-transactions/:scheduled_transaction_id", async (req, res) => {
    const { budget_id } = req.query;
    const { scheduled_transaction_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const body = req.body;
      const data = await ynabPut(`/budgets/${budget_id}/scheduled_transactions/${scheduled_transaction_id}`, body);
      res.json({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.delete("/v1/scheduled-transactions/:scheduled_transaction_id", async (req, res) => {
    const { budget_id } = req.query;
    const { scheduled_transaction_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabDelete(`/budgets/${budget_id}/scheduled_transactions/${scheduled_transaction_id}`);
      res.json({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Savings Rate (tasa de ahorro)
  // ─────────────────────────────────────────────────────────────────────────────
}
