/**
 * §11 report exports.
 *
 * ---------------------------------------------------------------------------
 * CSV is real. PDF and Excel are NOT built, and say so.
 *
 * §4.1 sells "PDF + Excel export" on Professional and above, and the plan flags
 * now gate correctly. But neither format is generated here:
 *
 *   PDF   needs a rendering library, and §5.2's branding (logo, signature,
 *         footer) which is empty on every tenant. An unbranded PDF is not the
 *         feature that was sold — it is a worse version of the CSV.
 *   Excel needs a writer. exceljs is a real dependency with a real footprint,
 *         and every spreadsheet on earth opens CSV — so it buys formatting, not
 *         capability, and formatting is exactly what wants the branding that
 *         does not exist yet.
 *
 * They return 501 NOT_IMPLEMENTED, which is honest and greppable. The
 * alternative — quietly serving a CSV with a .pdf extension — is how a customer
 * discovers the gap in front of their own boss.
 * ---------------------------------------------------------------------------
 */
import { ApiError } from '../http/api-error.js'

export type ExportFormat = 'csv' | 'pdf' | 'excel'

export interface ExportResult {
  body: string
  contentType: string
  filename: string
}

/**
 * RFC 4180 escaping.
 *
 * Not optional and not cosmetic: this data is Bookends' — names, outlet codes,
 * and §6's Hindi and Gujarati topic names. A comma in "Patel, Asha" or a
 * newline in a supervisor's remark silently shifts every later column, and the
 * reader sees a plausible spreadsheet with the wrong numbers in it.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''

  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}

/**
 * Builds a CSV document.
 *
 * CRLF line endings per RFC 4180 — Excel on Windows is the actual consumer, and
 * it is the one that cares.
 *
 * The BOM is deliberate and it is the difference between working and not: Excel
 * reads a UTF-8 CSV as the system codepage unless a BOM tells it otherwise, so
 * without this every Hindi and Gujarati topic name (§6) arrives as mojibake in
 * the one place the customer is most likely to look.
 */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [csvRow(header), ...rows.map(csvRow)]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Safe for a Content-Disposition header and for a Windows filesystem. */
export function exportFilename(kind: string, id: string, format: ExportFormat): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const safeKind = kind.replace(/[^a-z0-9-]/gi, '')
  return `${safeKind}-${id.slice(0, 8)}-${stamp}.${format === 'excel' ? 'xlsx' : format}`
}

/**
 * Refuses a format this system cannot honestly produce.
 *
 * Called AFTER the plan gate, so the answers are distinguishable: a Starter
 * tenant asking for PDF is told to upgrade (403), and a Professional tenant
 * asking for PDF is told it does not exist yet (501). Reversing that order
 * would tell a paying customer to buy something they already have.
 */
export function assertFormatSupported(format: ExportFormat): asserts format is 'csv' {
  if (format === 'csv') return

  throw ApiError.notImplemented(
    `${format.toUpperCase()} export is not built yet. Use format=csv — every spreadsheet opens it, ` +
      `and it carries the same data.`
  )
}
