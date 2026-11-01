'use strict';
const PDFDocument = require('pdfkit');
const money = require('../utils/money');
const dates = require('../utils/dates');
const { titleCase } = require('../utils/viewHelpers');
const { resolveStored } = require('../middleware/upload');

const BRAND = '#0f5c4d';
const MUTED = '#6b7280';

/** Render a student payment receipt (A5) from its immutable snapshot. */
function stream(res, receipt, { download = false } = {}) {
  const s = receipt.snapshot;
  const cur = s.currency || 'USD';
  const doc = new PDFDocument({ size: 'A5', margin: 32, info: { Title: `Receipt ${receipt.receiptNo}`, Author: s.schoolName } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="receipt-${receipt.receiptNo}.pdf"`);
  doc.pipe(res);

  const left = doc.page.margins.left;
  const width = doc.page.width - left * 2;

  // header
  const logo = s.schoolLogo ? resolveStored(s.schoolLogo) : null;
  if (logo && /\.(png|jpe?g)$/i.test(logo)) {
    try { doc.image(logo, left, 30, { fit: [44, 44] }); } catch (e) { /* ignore */ }
  }
  const hx = left + (logo ? 52 : 0);
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(14).text(s.schoolName || '', hx, 32, { width: width - 52 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text([s.schoolAddress, s.schoolPhone].filter(Boolean).join(' · '), hx, doc.y, { width: width - 52 });

  doc.moveDown(1.2);
  const ty = Math.max(doc.y, 84);
  doc.rect(left, ty, width, 26).fill(BRAND);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text('PAYMENT RECEIPT', left + 10, ty + 8);
  doc.font('Helvetica').fontSize(10).text(receipt.receiptNo, left, ty + 8, { width: width - 10, align: 'right' });

  if (receipt.status === 'void') {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
      .fillColor('#dc2626').opacity(0.18).font('Helvetica-Bold').fontSize(80)
      .text('VOID', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' }).restore();
    doc.opacity(1);
  }

  // details grid
  let y = ty + 38;
  const row = (label, value, x, w) => {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label.toUpperCase(), x, y, { width: w });
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9.5).text(value || '—', x, y + 10, { width: w });
  };
  const half = width / 2;
  const pairs = [
    ['Student name', s.studentName, 'Student ID', s.studentCode],
    ['Class', s.className, 'Payment category', titleCase(s.category)],
    ['Billing period', (s.periods || []).map(dates.periodLabel).join(', ') || '—', 'Payment date', dates.formatDate(s.paymentDate)],
    ['Payment method', s.method, 'Transaction reference', s.transactionRef],
  ];
  pairs.forEach(([l1, v1, l2, v2]) => { row(l1, v1, left, half - 8); row(l2, v2, left + half, half); y += 30; });

  // lines
  y += 4;
  doc.rect(left, y, width, 16).fill('#e6f0ed');
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(7.5);
  const cols = [['Invoice', 0.22], ['Description', 0.38], ['Invoice total', 0.2], ['Applied', 0.2]];
  let x = left;
  cols.forEach(([l, w], i) => { doc.text(l, x + 4, y + 5, { width: width * w - 8, align: i >= 2 ? 'right' : 'left' }); x += width * w; });
  y += 18;
  doc.font('Helvetica').fontSize(8).fillColor('#111827');
  (s.lines || []).forEach((ln) => {
    x = left;
    const vals = [ln.invoiceNo, ln.description, money.format(ln.total, cur), money.format(ln.applied, cur)];
    vals.forEach((v, i) => { doc.text(v, x + 4, y, { width: width * cols[i][1] - 8, align: i >= 2 ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += width * cols[i][1]; });
    y += 14;
  });
  doc.moveTo(left, y + 2).lineTo(left + width, y + 2).strokeColor('#d1d5db').stroke();

  // totals
  y += 10;
  const totals = [
    ['Total amount', money.format(s.totalAmount, cur), false],
    ['Amount paid', money.format(s.amountPaid, cur), true],
    ['Remaining balance', money.format(s.remainingBalance, cur), false],
  ];
  totals.forEach(([l, v, strong]) => {
    doc.fillColor(strong ? BRAND : '#374151').font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 11 : 9)
      .text(l, left + width * 0.45, y, { width: width * 0.3 })
      .text(v, left + width * 0.75, y, { width: width * 0.25, align: 'right' });
    y += strong ? 18 : 15;
  });

  y += 18;
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Received by: ${s.receivedBy || ''}`, left, y);
  doc.moveTo(left + width * 0.6, y + 22).lineTo(left + width, y + 22).strokeColor('#9ca3af').stroke();
  doc.text('Signature & stamp', left + width * 0.6, y + 26, { width: width * 0.4, align: 'center' });

  if (s.footer) doc.fillColor(MUTED).fontSize(7.5).text(s.footer, left, doc.page.height - 56, { width, align: 'center' });
  doc.fontSize(6.5).text(`Printed ${new Date().toUTCString()} · Copy #${(receipt.printCount || 0) + 1} · Powered by Quranic`, left, doc.page.height - 42, { width, align: 'center' });
  doc.end();
}

module.exports = { stream };
