'use strict';
/**
 * Generic report exporters. Any report object with the shape produced by reportService
 * (title, subtitle, summary[], sections[{title, columns, rows, totals}]) can be streamed
 * as a PDF (PDFKit) or an Excel workbook (ExcelJS).
 */
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const money = require('../utils/money');
const dates = require('../utils/dates');
const { titleCase } = require('../utils/viewHelpers');
const { resolveStored } = require('../middleware/upload');

const BRAND = '#0f5c4d';
const MUTED = '#6b7280';

function cell(value, type, currency) {
  if (value === undefined || value === null || value === '') return '';
  switch (type) {
    case 'money': return typeof value === 'number' ? money.format(value, currency) : String(value);
    case 'date': return dates.formatDate(value);
    case 'percent': return `${value}%`;
    case 'status': return titleCase(value);
    case 'number': return String(value);
    default: return String(value);
  }
}

function safeName(s) {
  return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/* ---------------------------------- PDF ----------------------------------- */

function pdfHeader(doc, report, org) {
  const logo = org && org.logo ? resolveStored(org.logo) : null;
  const top = doc.y;
  if (logo && /\.(png|jpe?g)$/i.test(logo)) {
    try { doc.image(logo, doc.page.margins.left, top, { fit: [48, 48] }); } catch (e) { /* ignore unreadable logo */ }
  }
  const x = doc.page.margins.left + (logo ? 58 : 0);
  doc.fillColor(BRAND).fontSize(15).font('Helvetica-Bold').text(org ? org.name : 'Quranic', x, top);
  if (org && org.address) doc.fillColor(MUTED).fontSize(8.5).font('Helvetica').text(org.address, x);
  doc.moveDown(0.6);
  doc.x = doc.page.margins.left;
  doc.fillColor('#111827').fontSize(13).font('Helvetica-Bold').text(report.title);
  if (report.subtitle) doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(report.subtitle);
  doc.fillColor(MUTED).fontSize(7.5).text(`Generated ${new Date().toUTCString()}`);
  doc.moveDown(0.5);
}

function pdfTable(doc, section, currency) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const cols = section.columns;
  const weights = cols.map((c) => (['money', 'number', 'percent', 'date', 'status'].includes(c.type) ? 1 : 1.6));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalW) * width);
  const rowH = 16;
  const align = (c) => (['money', 'number', 'percent'].includes(c.type) ? 'right' : 'left');

  const ensure = (h) => {
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); return true; }
    return false;
  };
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(left, y, width, rowH).fill(BRAND);
    let x = left;
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c, i) => { doc.text(c.label, x + 3, y + 4.5, { width: widths[i] - 6, align: align(c), lineBreak: false, ellipsis: true }); x += widths[i]; });
    doc.y = y + rowH;
  };
  const drawRow = (row, bold, shade) => {
    if (ensure(rowH)) drawHeader();
    const y = doc.y;
    if (shade) doc.rect(left, y, width, rowH).fill(bold ? '#e6f0ed' : '#f8faf9');
    let x = left;
    doc.fillColor('#111827').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    cols.forEach((c, i) => {
      doc.text(cell(row[c.key], c.type, currency), x + 3, y + 4.5, { width: widths[i] - 6, align: align(c), lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    doc.y = y + rowH;
  };

  ensure(rowH * 3);
  doc.x = left;
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text(section.title);
  doc.moveDown(0.3);
  drawHeader();
  if (!section.rows.length) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8).text('No records for this selection.', left + 3, doc.y + 4);
    doc.moveDown(0.8);
  }
  section.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
  if (section.totals && section.rows.length) drawRow(section.totals, true, true);
  doc.x = left;
  doc.moveDown(1);
}

function streamPdf(res, report, { org, currency = 'USD' } = {}) {
  const wide = report.sections.some((s) => s.columns.length > 6);
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: report.title, Author: 'Quranic' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(report.title)}-${dates.toISODate(new Date())}.pdf"`);
  doc.pipe(res);
  pdfHeader(doc, report, org);

  if (report.summary && report.summary.length) {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const per = Math.min(4, report.summary.length);
    const boxW = width / per;
    let y = doc.y;
    report.summary.forEach((s, i) => {
      if (i > 0 && i % per === 0) y += 40;
      const x = left + (i % per) * boxW;
      doc.rect(x + 2, y, boxW - 4, 36).fill('#f1f6f4');
      doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(s.label, x + 8, y + 6, { width: boxW - 16, lineBreak: false, ellipsis: true });
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(11).text(cell(s.value, s.type, currency), x + 8, y + 17, { width: boxW - 16, lineBreak: false });
    });
    doc.y = y + 46;
    doc.x = left;
  }
  report.sections.forEach((s) => pdfTable(doc, s, currency));

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.fillColor(MUTED).fontSize(7).font('Helvetica')
      .text(`${org ? org.name : 'Quranic'} · ${report.title} · Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 24, { align: 'center', width: doc.page.width - 72, lineBreak: false });
  }
  doc.end();
}

/* --------------------------------- Excel ---------------------------------- */

async function streamXlsx(res, report, { org, currency = 'USD' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quranic';
  wb.created = new Date();
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  const numFmt = `"${currency} "#,##0.00`;

  ws.addRow([org ? org.name : 'Quranic']).font = { bold: true, size: 14, color: { argb: 'FF0F5C4D' } };
  ws.addRow([report.title]).font = { bold: true, size: 12 };
  if (report.subtitle) ws.addRow([report.subtitle]).font = { italic: true, color: { argb: 'FF6B7280' } };
  ws.addRow([]);

  if (report.summary && report.summary.length) {
    report.summary.forEach((s) => {
      const r = ws.addRow([s.label, s.type === 'money' ? s.value / 100 : s.value]);
      r.getCell(1).font = { bold: true };
      if (s.type === 'money') r.getCell(2).numFmt = numFmt;
    });
    ws.addRow([]);
  }

  report.sections.forEach((section) => {
    ws.addRow([section.title]).font = { bold: true, size: 12, color: { argb: 'FF0F5C4D' } };
    const header = ws.addRow(section.columns.map((c) => c.label));
    header.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5C4D' } };
    });
    const write = (row, bold) => {
      const r = ws.addRow(section.columns.map((c) => {
        const v = row[c.key];
        if (v === undefined || v === null) return '';
        if (c.type === 'money' && typeof v === 'number') return v / 100; // minor units -> major for spreadsheet math
        if (c.type === 'date' && v) return new Date(v);
        if (c.type === 'status') return titleCase(v);
        return v;
      }));
      section.columns.forEach((c, i) => {
        if (c.type === 'money') r.getCell(i + 1).numFmt = numFmt;
        if (c.type === 'date') r.getCell(i + 1).numFmt = 'dd mmm yyyy';
      });
      if (bold) r.font = { bold: true };
    };
    section.rows.forEach((row) => write(row));
    if (section.totals && section.rows.length) write(section.totals, true);
    ws.addRow([]);
  });

  ws.columns.forEach((col, i) => { col.width = i === 0 ? 26 : 18; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(report.title)}-${dates.toISODate(new Date())}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

/** Simple list export (students, teachers, ...) through the same pipeline. */
function listReport(title, columns, rows, subtitle) {
  return { title, subtitle, summary: [{ label: 'Records', value: rows.length, type: 'number' }], sections: [{ title, columns, rows }] };
}

/** Pick the output based on ?format=pdf|xlsx; returns false when HTML should be rendered. */
async function respond(req, res, report, opts) {
  if (req.query.format === 'pdf') { streamPdf(res, report, opts); return true; }
  if (req.query.format === 'xlsx') { await streamXlsx(res, report, opts); return true; }
  return false;
}

module.exports = { streamPdf, streamXlsx, listReport, respond, cell };
