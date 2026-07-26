// CLAUDE.md: money is stored as integer pesewas everywhere; this is the
// ONE place it gets divided by 100 for display — never do that inline in a
// component. Dates display DD-MMM-YYYY (CLAUDE.md localization rule).

export function formatGhs(pesewas: number | string | null | undefined): string {
  const value = Number(pesewas ?? 0) / 100;
  return new Intl.NumberFormat('en-GH', {
    style: 'currency',
    currency: 'GHS',
    minimumFractionDigits: 2,
  }).format(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = MONTHS[d.getUTCMonth()];
  return `${day}-${month}-${d.getUTCFullYear()}`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${formatDate(d)} ${time}`;
}

export function formatBps(bps: number | string | null | undefined): string {
  return `${(Number(bps ?? 0) / 100).toFixed(2)}%`;
}
