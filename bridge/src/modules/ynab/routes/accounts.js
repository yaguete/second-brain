import { sendError } from "../../../shared/utils.js";
import { ynabFetch } from "../client.js";
import { muToUnits } from "../utils.js";

export function register(app) {
  app.get("/v1/accounts", async (req, res) => {
    const { budget_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/accounts`);
      const accounts = data?.data?.accounts?.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        on_budget: a.on_budget,
        closed: a.closed,
        balance: a.balance,
        balance_units: muToUnits(a.balance),
        cleared_balance: a.cleared_balance,
        cleared_balance_units: muToUnits(a.cleared_balance),
        uncleared_balance: a.uncleared_balance,
        uncleared_balance_units: muToUnits(a.uncleared_balance)
      })) ?? [];
      res.json({ accounts });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/accounts/:account_id", async (req, res) => {
    const { budget_id } = req.query;
    const { account_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
      const a = data?.data?.account;
      res.json({
        account: {
          id: a.id,
          name: a.name,
          type: a.type,
          on_budget: a.on_budget,
          closed: a.closed,
          balance: a.balance,
          balance_units: muToUnits(a.balance),
          cleared_balance: a.cleared_balance,
          cleared_balance_units: muToUnits(a.cleared_balance),
          uncleared_balance: a.uncleared_balance,
          uncleared_balance_units: muToUnits(a.uncleared_balance)
        }
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/account-balance-at-date", async (req, res) => {
    const { budget_id, account_id, date } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!account_id) return res.status(400).json({ error: "account_id is required" });
    if (!date) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });

    try {
      // 1. Obtener saldo actual
      const accountData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
      const account = accountData?.data?.account;
      const currentBalance = account.balance;

      // 2. Obtener transacciones desde esa fecha
      const txnData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}/transactions?since_date=${date}`);
      const transactions = txnData?.data?.transactions ?? [];

      // 3. Sumar transacciones posteriores (incluyendo el día indicado)
      const sumAfter = transactions.reduce((s, t) => s + t.amount, 0);

      // 4. Saldo histórico = actual - lo que pasó después
      const balanceAtDate = currentBalance - sumAfter;

      res.json({
        account_id: account.id,
        account_name: account.name,
        date,
        current_balance_milliunits: currentBalance,
        current_balance: muToUnits(currentBalance),
        transactions_since: transactions.length,
        balance_at_date_milliunits: balanceAtDate,
        balance_at_date: muToUnits(balanceAtDate)
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Categories
  // ─────────────────────────────────────────────────────────────────────────────
}
