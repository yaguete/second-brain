import { PublicError, UpstreamError, sendError } from "../../../shared/utils.js";
import { ynabFetch, ynabPost, ynabPatch, ynabPut } from "../client.js";
import { mapTransaction, getPeriodKey, muToUnits } from "../utils.js";

export function register(app) {
  app.get("/v1/spending-trend", async (req, res) => {
    const {
      budget_id, category_id, payee_id, account_id, payee_name_contains,
      since_date, until_date, group_by = "month", type = "outflow",
      exclude_transfers, exclude_reconciliations,
      exclude_category_ids, exclude_payee_ids, exclude_payee_names
    } = req.query;

    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!["day", "week", "month"].includes(group_by)) {
      return res.status(400).json({ error: "group_by must be 'day', 'week', or 'month'" });
    }
    if (!["inflow", "outflow", "all"].includes(type)) {
      return res.status(400).json({ error: "type must be 'inflow', 'outflow', or 'all'" });
    }

    // Parsear listas de exclusión (comma-separated)
    const excludeCategoryIds = exclude_category_ids ? exclude_category_ids.split(",").map(s => s.trim()) : [];
    const excludePayeeIds = exclude_payee_ids ? exclude_payee_ids.split(",").map(s => s.trim()) : [];
    const excludePayeeNames = exclude_payee_names ? exclude_payee_names.split(",").map(s => s.trim().toLowerCase()) : [];

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      // Obtener nombre del filtro si aplica
      let filter_type = null;
      let filter_id = null;
      let filter_name = null;

      if (account_id) {
        filter_type = "account";
        filter_id = account_id;
        const accountData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
        filter_name = accountData?.data?.account?.name;
      } else if (category_id) {
        filter_type = "category";
        filter_id = category_id;
        const categoryData = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}`);
        filter_name = categoryData?.data?.category?.name;
      } else if (payee_id) {
        filter_type = "payee";
        filter_id = payee_id;
        const payeeData = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}`);
        filter_name = payeeData?.data?.payee?.name;
      }

      // Determinar path según filtro
      let path = `/budgets/${budget_id}/transactions${qs}`;
      if (account_id) path = `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}`;
      else if (category_id) path = `/budgets/${budget_id}/categories/${category_id}/transactions${qs}`;
      else if (payee_id) path = `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`;

      const data = await ynabFetch(path);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar por until_date
      if (until_date) {
        transactions = transactions.filter(t => t.date <= until_date);
      }

      // Filtrar por payee_name_contains
      if (payee_name_contains) {
        const search = payee_name_contains.toLowerCase();
        transactions = transactions.filter(t => t.payee_name?.toLowerCase().includes(search));
      }

      // Filtrar por tipo
      if (type === "outflow") {
        transactions = transactions.filter(t => t.amount < 0);
      } else if (type === "inflow") {
        transactions = transactions.filter(t => t.amount > 0);
      }

      // Excluir transferencias (tienen transfer_account_id)
      if (exclude_transfers === "true") {
        transactions = transactions.filter(t => !t.transfer_account_id);
      }

      // Excluir reconciliaciones
      if (exclude_reconciliations === "true") {
        transactions = transactions.filter(t =>
          !t.payee_name?.toLowerCase().includes("reconciliation") &&
          !t.payee_name?.toLowerCase().includes("starting balance")
        );
      }

      // Excluir categorías específicas
      if (excludeCategoryIds.length > 0) {
        transactions = transactions.filter(t => !excludeCategoryIds.includes(t.category_id));
      }

      // Excluir payees por ID
      if (excludePayeeIds.length > 0) {
        transactions = transactions.filter(t => !excludePayeeIds.includes(t.payee_id));
      }

      // Excluir payees por nombre (substring, case-insensitive)
      if (excludePayeeNames.length > 0) {
        transactions = transactions.filter(t => {
          const payeeLower = t.payee_name?.toLowerCase() || "";
          return !excludePayeeNames.some(name => payeeLower.includes(name));
        });
      }

      // Agregar por período
      const byPeriod = new Map();
      for (const t of transactions) {
        const key = getPeriodKey(t.date, group_by);
        const existing = byPeriod.get(key);
        if (existing) {
          existing.total += t.amount;
          existing.count += 1;
        } else {
          byPeriod.set(key, { period: key, total: t.amount, count: 1 });
        }
      }

      // Ordenar por período
      const periods_milliunits = Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
      const periods = periods_milliunits.map(p => ({
        period: p.period,
        total: muToUnits(p.total),
        count: p.count
      }));

      const grand_total = transactions.reduce((s, t) => s + t.amount, 0);
      const avg_per_period = periods.length > 0 ? grand_total / periods.length : 0;

      const response = {
        group_by,
        type,
        since_date: since_date || null,
        until_date: until_date || null,
        transaction_count: transactions.length,
        period_count: periods.length,
        grand_total_milliunits: grand_total,
        grand_total: muToUnits(grand_total),
        avg_per_period_milliunits: Math.round(avg_per_period),
        avg_per_period: muToUnits(avg_per_period),
        periods_milliunits,
        periods
      };

      // Añadir info del filtro si aplica
      if (filter_type) {
        response.filter_type = filter_type;
        response.filter_id = filter_id;
        response.filter_name = filter_name;
      }
      if (payee_name_contains) {
        response.payee_name_contains = payee_name_contains;
      }

      res.json(response);
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Transactions (Read)
  // ─────────────────────────────────────────────────────────────────────────────

  function mapTransaction(t) {
    return {
      id: t.id,
      date: t.date,
      amount: t.amount,
      amount_units: muToUnits(t.amount),
      memo: t.memo,
      cleared: t.cleared,
      approved: t.approved,
      account_id: t.account_id,
      account_name: t.account_name,
      payee_id: t.payee_id,
      payee_name: t.payee_name,
      category_id: t.category_id,
      category_name: t.category_name,
      transfer_account_id: t.transfer_account_id,
      import_id: t.import_id,
      deleted: t.deleted,
      subtransactions: t.subtransactions?.map(s => ({
        id: s.id,
        amount: s.amount,
        amount_units: muToUnits(s.amount),
        memo: s.memo,
        payee_id: s.payee_id,
        payee_name: s.payee_name,
        category_id: s.category_id,
        category_name: s.category_name,
        transfer_account_id: s.transfer_account_id
      })) ?? []
    };
  }

  app.get("/v1/transactions-sum", async (req, res) => {
    const {
      budget_id, since_date, until_date, account_id, category_id, payee_id, payee_name_contains, type = "all",
      exclude_transfers, exclude_reconciliations,
      exclude_category_ids, exclude_payee_ids, exclude_payee_names
    } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!["inflow", "outflow", "all"].includes(type)) {
      return res.status(400).json({ error: "type must be 'inflow', 'outflow', or 'all'" });
    }

    // Parsear listas de exclusión
    const excludeCategoryIds = exclude_category_ids ? exclude_category_ids.split(",").map(s => s.trim()) : [];
    const excludePayeeIds = exclude_payee_ids ? exclude_payee_ids.split(",").map(s => s.trim()) : [];
    const excludePayeeNames = exclude_payee_names ? exclude_payee_names.split(",").map(s => s.trim().toLowerCase()) : [];

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      let path = `/budgets/${budget_id}/transactions${qs}`;
      if (account_id) path = `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}`;
      else if (category_id) path = `/budgets/${budget_id}/categories/${category_id}/transactions${qs}`;
      else if (payee_id) path = `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`;

      const data = await ynabFetch(path);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar por until_date
      if (until_date) {
        transactions = transactions.filter(t => t.date <= until_date);
      }

      // Filtrar por payee_name_contains
      if (payee_name_contains) {
        const search = payee_name_contains.toLowerCase();
        transactions = transactions.filter(t => t.payee_name?.toLowerCase().includes(search));
      }

      // Filtrar por tipo
      if (type === "outflow") {
        transactions = transactions.filter(t => t.amount < 0);
      } else if (type === "inflow") {
        transactions = transactions.filter(t => t.amount > 0);
      }

      // Excluir transferencias
      if (exclude_transfers === "true") {
        transactions = transactions.filter(t => !t.transfer_account_id);
      }

      // Excluir reconciliaciones
      if (exclude_reconciliations === "true") {
        transactions = transactions.filter(t =>
          !t.payee_name?.toLowerCase().includes("reconciliation") &&
          !t.payee_name?.toLowerCase().includes("starting balance")
        );
      }

      // Excluir categorías específicas
      if (excludeCategoryIds.length > 0) {
        transactions = transactions.filter(t => !excludeCategoryIds.includes(t.category_id));
      }

      // Excluir payees por ID
      if (excludePayeeIds.length > 0) {
        transactions = transactions.filter(t => !excludePayeeIds.includes(t.payee_id));
      }

      // Excluir payees por nombre
      if (excludePayeeNames.length > 0) {
        transactions = transactions.filter(t => {
          const payeeLower = t.payee_name?.toLowerCase() || "";
          return !excludePayeeNames.some(name => payeeLower.includes(name));
        });
      }

      const total = transactions.reduce((s, t) => s + t.amount, 0);

      res.json({
        count: transactions.length,
        total_milliunits: total,
        total: muToUnits(total)
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Market P&L (ganancias/pérdidas de inversiones via reconciliaciones)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/transactions", async (req, res) => {
    const { budget_id, since_date, until_date, type, account_id, category_id, payee_id, payee_name_contains } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      if (type) params.set("type", type);
      const qs = params.toString() ? `?${params}` : "";

      let path = `/budgets/${budget_id}/transactions${qs}`;
      if (account_id) path = `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}`;
      else if (category_id) path = `/budgets/${budget_id}/categories/${category_id}/transactions${qs}`;
      else if (payee_id) path = `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`;

      const data = await ynabFetch(path);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar por until_date (YNAB no lo soporta nativamente)
      if (until_date) {
        transactions = transactions.filter(t => t.date <= until_date);
      }

      // Filtrar por payee_name_contains (búsqueda parcial case-insensitive)
      if (payee_name_contains) {
        const search = payee_name_contains.toLowerCase();
        transactions = transactions.filter(t => t.payee_name?.toLowerCase().includes(search));
      }

      res.json({ transactions: transactions.map(mapTransaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/transactions/:transaction_id", async (req, res) => {
    const { budget_id } = req.query;
    const { transaction_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/transactions/${transaction_id}`);
      res.json({ transaction: mapTransaction(data?.data?.transaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Transactions (Write)
  // ─────────────────────────────────────────────────────────────────────────────

  async function ynabPost(path, body) {
    if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

    const resp = await fetch(`${YNAB_BASE}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${YNAB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    if (!resp.ok) {
      const msg = json?.error?.detail || json?.error?.name || resp.statusText;
      throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
    }

    return json;
  }

  async function ynabPatch(path, body) {
    if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

    const resp = await fetch(`${YNAB_BASE}${path}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${YNAB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    if (!resp.ok) {
      const msg = json?.error?.detail || json?.error?.name || resp.statusText;
      throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
    }

    return json;
  }

  async function ynabPut(path, body) {
    if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

    const resp = await fetch(`${YNAB_BASE}${path}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${YNAB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    if (!resp.ok) {
      const msg = json?.error?.detail || json?.error?.name || resp.statusText;
      throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
    }

    return json;
  }

  async function ynabDelete(path) {
    if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

    const resp = await fetch(`${YNAB_BASE}${path}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${YNAB_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    if (!resp.ok) {
      const msg = json?.error?.detail || json?.error?.name || resp.statusText;
      throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
    }

    return json;
  }

  app.post("/v1/transactions", async (req, res) => {
    const { budget_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const body = req.body;
      const data = await ynabPost(`/budgets/${budget_id}/transactions`, body);

      const result = {};
      if (data?.data?.transaction) {
        result.transaction = mapTransaction(data.data.transaction);
      }
      if (data?.data?.transactions) {
        result.transactions = data.data.transactions.map(mapTransaction);
      }
      if (data?.data?.duplicate_import_ids) {
        result.duplicate_import_ids = data.data.duplicate_import_ids;
      }

      res.status(201).json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.patch("/v1/transactions", async (req, res) => {
    const { budget_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const body = req.body;
      const data = await ynabPatch(`/budgets/${budget_id}/transactions`, body);

      const result = {};
      if (data?.data?.transaction) {
        result.transaction = mapTransaction(data.data.transaction);
      }
      if (data?.data?.transactions) {
        result.transactions = data.data.transactions.map(mapTransaction);
      }

      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.put("/v1/transactions/:transaction_id", async (req, res) => {
    const { budget_id } = req.query;
    const { transaction_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const body = req.body;
      const data = await ynabPut(`/budgets/${budget_id}/transactions/${transaction_id}`, body);
      res.json({ transaction: mapTransaction(data?.data?.transaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scheduled Transactions
  // ─────────────────────────────────────────────────────────────────────────────

  function mapScheduledTransaction(t) {
    return {
      id: t.id,
      date_first: t.date_first,
      date_next: t.date_next,
      frequency: t.frequency,
      amount: t.amount,
      amount_units: muToUnits(t.amount),
      memo: t.memo,
      flag_color: t.flag_color,
      account_id: t.account_id,
      account_name: t.account_name,
      payee_id: t.payee_id,
      payee_name: t.payee_name,
      category_id: t.category_id,
      category_name: t.category_name,
      transfer_account_id: t.transfer_account_id,
      deleted: t.deleted,
      subtransactions: t.subtransactions?.map(s => ({
        id: s.id,
        amount: s.amount,
        amount_units: muToUnits(s.amount),
        memo: s.memo,
        payee_id: s.payee_id,
        payee_name: s.payee_name,
        category_id: s.category_id,
        category_name: s.category_name,
        transfer_account_id: s.transfer_account_id
      })) ?? []
    };
  }

  app.get("/v1/search-transactions", async (req, res) => {
    const { budget_id, query, since_date, until_date, account_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!query) return res.status(400).json({ error: "query is required" });

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      const path = account_id
        ? `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}`
        : `/budgets/${budget_id}/transactions${qs}`;

      const data = await ynabFetch(path);
      let transactions = data?.data?.transactions ?? [];

      if (until_date) transactions = transactions.filter(t => t.date <= until_date);

      const search = query.toLowerCase();
      transactions = transactions.filter(t =>
        (t.memo?.toLowerCase().includes(search)) ||
        (t.payee_name?.toLowerCase().includes(search)) ||
        (t.category_name?.toLowerCase().includes(search))
      );

      res.json({ query, count: transactions.length, transactions: transactions.map(mapTransaction) });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Update Category Budget
  // ─────────────────────────────────────────────────────────────────────────────
}
