/** Withings Measure API type IDs → human label + unit (see Withings docs / MCP tool). */
export const WITHINGS_MEAS_TYPES = {
  1: { name: "weight", label: "Peso", unit: "kg" },
  5: { name: "fat_free_mass", label: "Masa libre de grasa", unit: "kg" },
  6: { name: "fat_ratio", label: "Grasa corporal", unit: "%" },
  8: { name: "fat_mass", label: "Masa grasa", unit: "kg" },
  11: { name: "heart_pulse", label: "Pulso cardíaco", unit: "bpm" },
  12: { name: "temperature", label: "Temperatura", unit: "°C" },
  54: { name: "spo2", label: "SpO2", unit: "%" },
  71: { name: "body_temperature", label: "Temperatura corporal", unit: "°C" },
  76: { name: "muscle_mass", label: "Masa muscular", unit: "kg" },
  77: { name: "hydration", label: "Hidratación", unit: "kg" },
  88: { name: "bone_mass", label: "Masa ósea", unit: "kg" },
  91: { name: "pulse_wave_velocity", label: "Velocidad de onda de pulso", unit: "m/s" }
};

/** Body-composition types (exclude pulse/SpO2 from "peso corporal" narratives). */
export const WITHINGS_BODY_COMP_TYPES = new Set([1, 5, 6, 8, 76, 77, 88]);

/**
 * Decode Withings raw measure: value * 10^unit.
 * @param {{ value: number, type: number, unit: number }} m
 */
export function decodeWithingsMeasure(m) {
  const meta = WITHINGS_MEAS_TYPES[m.type] || {
    name: `type_${m.type}`,
    label: `Tipo ${m.type}`,
    unit: "?"
  };
  const decoded = m.value * Math.pow(10, m.unit);
  return {
    type: m.type,
    type_name: meta.name,
    type_label: meta.label,
    unit: meta.unit,
    value_raw: m.value,
    unit_exponent: m.unit,
    value: Math.round(decoded * 1000) / 1000,
    is_body_composition: WITHINGS_BODY_COMP_TYPES.has(m.type)
  };
}

/**
 * Flatten getmeas response for LLM/analytics consumers.
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function normalizeWithingsBodyMeasurements(raw) {
  const groups = raw?.measuregrps;
  if (!Array.isArray(groups)) {
    return {
      readings: [],
      weight_readings: [],
      body_composition_readings: [],
      other_readings: [],
      has_weight: false,
      note: "Sin measuregrps en la respuesta Withings"
    };
  }

  const readings = [];
  for (const g of groups) {
    const dateUnix = g.date;
    const dateIso = dateUnix ? new Date(dateUnix * 1000).toISOString() : null;
    const dateYmd = dateIso ? dateIso.slice(0, 10) : null;
    for (const m of g.measures || []) {
      const decoded = decodeWithingsMeasure(m);
      readings.push({
        date: dateYmd,
        date_iso: dateIso,
        device: g.model || null,
        ...decoded
      });
    }
  }

  readings.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const weight_readings = readings.filter((r) => r.type === 1);
  const body_composition_readings = readings.filter((r) => r.is_body_composition);
  const other_readings = readings.filter((r) => !r.is_body_composition);

  return {
    readings,
    weight_readings,
    body_composition_readings,
    other_readings,
    has_weight: weight_readings.length > 0,
    note:
      weight_readings.length === 0 && other_readings.length > 0
        ? "No hay pesajes (tipo 1) en el periodo; solo otras medidas (p. ej. pulso del ScanWatch, tipo 11)."
        : null
  };
}
