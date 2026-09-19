/**
 * Global search (requirement 27). One pass over the indexes, ranked, capped.
 * Everything is in memory, so this stays instant at thousands of records.
 */

import { formatDate, dateOfIso } from '../core/dates.js';
import { reservationStatusOf } from '../core/schema.js';
import { toMoney, formatMoney } from '../core/money.js';

const LIMIT = 24;

export function globalSearch(store, term) {
  const raw = String(term || '').trim();
  if (raw.length < 2) return [];
  const q = raw.toLowerCase();
  const digits = q.replace(/\D/g, '');
  const results = [];

  const push = (r) => { if (results.length < LIMIT * 3) results.push(r); };

  for (const g of store.db.live('guests')) {
    const name = String(g.fullName || '').toLowerCase();
    const idText = [g.cnic, g.passport, g.phone, g.whatsapp, g.code].join(' ').toLowerCase();
    const idDigits = idText.replace(/\D/g, '');
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.indexOf(q) > -1) score = 60;
    else if (idText.indexOf(q) > -1) score = 70;
    else if (digits.length >= 4 && idDigits.indexOf(digits) > -1) score = 65;
    if (score) push({
      type: 'guest', score, id: g.id,
      title: g.fullName,
      subtitle: [g.phone, g.city].filter(Boolean).join(' · ') || g.code,
      badge: 'Guest', route: { screen: 'guests', guestId: g.id }
    });
  }

  for (const r of store.db.all('reservations')) {
    if (r.archivedAt) continue;
    const code = String(r.code || '').toLowerCase();
    const reg = String(r.registerNo || '').toLowerCase();
    const inv = String(r.invoiceNo || '').toLowerCase();
    let score = 0;
    if (code === q || reg === q || inv === q) score = 100;
    else if (code.indexOf(q) > -1 || reg.indexOf(q) > -1 || inv.indexOf(q) > -1) score = 75;
    if (!score) continue;
    const guest = store.db.get('guests', r.guestId);
    const unit = store.db.get('units', r.unitId);
    push({
      type: 'reservation', score, id: r.id,
      title: `${r.code} · ${guest ? guest.fullName : 'Unknown guest'}`,
      subtitle: `${unit ? unit.code : '—'} · ${formatDate(r.checkIn)} → ${formatDate(r.checkOut)} · ${reservationStatusOf(r.status).label}`,
      badge: 'Booking', route: { screen: 'reservations', reservationId: r.id }
    });
  }

  for (const u of store.db.live('units')) {
    const code = String(u.code || '').toLowerCase();
    let score = 0;
    if (code === q) score = 95;
    else if (code.startsWith(q)) score = 70;
    else if (code.indexOf(q) > -1) score = 50;
    if (!score) continue;
    push({
      type: 'unit', score, id: u.id,
      title: u.code,
      subtitle: `${(store.db.get('unitTypes', u.unitTypeId) || {}).name || '—'} · ${u.status}`,
      badge: 'Unit', route: { screen: 'units', unitId: u.id }
    });
  }

  for (const p of store.db.all('payments')) {
    if (p.voided) continue;
    const code = String(p.code || '').toLowerCase();
    if (code !== q && code.indexOf(q) === -1) continue;
    const guest = store.db.get('guests', p.guestId);
    push({
      type: 'payment', score: code === q ? 100 : 70, id: p.id,
      title: `${p.code} · ${formatMoney(toMoney(p.amount), store.currency())}`,
      subtitle: `${guest ? guest.fullName : '—'} · ${formatDate(dateOfIso(p.at))}`,
      badge: 'Receipt', route: { screen: 'payments', paymentId: p.id }
    });
  }

  for (const i of store.db.all('invoices')) {
    const no = String(i.no || '').toLowerCase();
    if (no !== q && no.indexOf(q) === -1) continue;
    push({
      type: 'invoice', score: no === q ? 100 : 70, id: i.id,
      title: `${i.no} · ${i.guestName}`,
      subtitle: `${i.unitCode} · ${formatMoney(toMoney(i.totalAtIssue), store.currency())}`,
      badge: 'Invoice', route: { screen: 'reservations', reservationId: i.reservationId }
    });
  }

  return results.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title))).slice(0, LIMIT);
}
