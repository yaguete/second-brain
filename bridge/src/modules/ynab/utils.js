export function normalizeMonth(month) {
    if (!month || month === "current") return "current";
    // si viene como YYYY-MM, conviértelo a YYYY-MM-01
    if (/^\d{4}-\d{2}$/.test(month)) return `${month}-01`;
    return month;
  }

export function muToUnits(milliunits) {
// YNAB: 1 unidad monetaria (1€) = 1000 milliunits
return Math.round((Number(milliunits || 0) / 1000) * 100) / 100; // redondeo 2 decimales
}


export function getWeekNumber(dateStr) {
  const date = new Date(dateStr);
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - startOfYear) / (24 * 60 * 60 * 1000));
  return Math.ceil((days + startOfYear.getDay() + 1) / 7);
}

export function getPeriodKey(dateStr, groupBy) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  switch (groupBy) {
    case "day":
      return `${year}-${month}-${day}`;
    case "week":
      const week = String(getWeekNumber(dateStr)).padStart(2, "0");
      return `${year}-W${week}`;
    case "month":
    default:
      return `${year}-${month}`;
  }
}


export function mapTransaction(t) {
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


export function mapScheduledTransaction(t) {
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
