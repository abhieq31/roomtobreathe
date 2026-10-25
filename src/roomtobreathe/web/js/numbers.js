// How people write crowd sizes: "60,000", "1,00,000", "1.5 lakh", "50k", "2 crore", "10 thousand".
const UNITS = { k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6, mn: 1e6, million: 1e6 };

export function parsePeople(t) {
  const s = String(t ?? "").toLowerCase().replace(/[,\s_']/g, "").replace(/people|persons?$/, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([a-z]*)$/);
  if (!m || (m[2] && !(m[2] in UNITS))) return null;
  const v = Math.round(Number(m[1]) * (m[2] ? UNITS[m[2]] : 1));
  return v > 0 ? v : null;
}
