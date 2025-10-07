import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";

// ----- Types -----
type Stats = {
  readonly countNumbers: number;
  readonly invalidCells: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
};

type ColumnAcc = {
  countNumbers: number;
  invalidCells: number;
  sum: number;
  min: number | null;
  max: number | null;
};

type Report = {
  readonly rowsProcessed: number;
  readonly columns: Record<string, Stats>;
};

// ----- Args: --input <file> [--out <file>] -----
function parseArgs(a: readonly string[]) {
  const out: { input?: string; out?: string; help?: true } = {};
  for (let i = 2; i < a.length; i++) {
    const tok = a[i]!; // loop guard ensures in-bounds
    if (tok === "--help" || tok === "-h") {
      out.help = true;
      continue;
    }
    if (tok === "--input" && typeof a[i + 1] === "string") {
      out.input = a[++i] as string; // safe after check
      continue;
    }
    if (tok === "--out" && typeof a[i + 1] === "string") {
      out.out = a[++i] as string; // safe after check
      continue;
    }
    // convenience: allow a bare positional path if input not set
    if (!tok.startsWith("--") && out.input === undefined) out.input = tok;
  }
  return out;
}

function printHelp() {
  console.log(
    `ts-csv-stats

Usage:
  node dist/cli.js --input <file.csv> [--out report.json]
  node dist/cli.js --help

Notes:
  • First non-empty row is treated as header.
  • Quoted fields with "" escapes are supported.
  • Non-numeric cells increase 'invalidCells' but do not fail the run.`
  );
}

// ----- Tiny CSV line parser with quotes/"" escapes -----
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"'; // escaped quote
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

function initAcc(headers: readonly string[]): Record<string, ColumnAcc> {
  const acc: Record<string, ColumnAcc> = {};
  for (const h of headers) {
    acc[h] = { countNumbers: 0, invalidCells: 0, sum: 0, min: null, max: null };
  }
  return acc;
}

function finalizeStats(acc: Record<string, ColumnAcc>): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (const [name, a] of Object.entries(acc)) {
    const mean = a.countNumbers > 0 ? a.sum / a.countNumbers : null;
    out[name] = Object.freeze({
      countNumbers: a.countNumbers,
      invalidCells: a.invalidCells,
      min: a.min,
      max: a.max,
      mean
    });
  }
  return out;
}

async function main() {
  const args = parseArgs(argv);
  if (args.help || !args.input) {
    printHelp();
    if (!args.input) exit(2);
  }

  // 1) Read the whole file
  const raw = await readFile(args.input!, "utf8");

  // 2) Split lines; first non-empty is header
  const lines = raw.split(/\r?\n/).map((s: string) => s.trim());
  const firstDataLineIndex = lines.findIndex((l: string) => l.length > 0);
  if (firstDataLineIndex === -1) {
    console.error("Empty file (no header found).");
    exit(2);
  }

  const headerLine = lines[firstDataLineIndex]!;
  const headers = parseCsvLine(headerLine);
  if (headers.length === 0) {
    console.error("Header row is empty after parsing.");
    exit(2);
  }

  const acc = initAcc(headers);

  // 3) Process rows
  let rowsProcessed = 0;
  for (let i = firstDataLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const cols = parseCsvLine(line);
    const row = headers.map((_, j) => (j < cols.length ? cols[j] : ""));

    rowsProcessed++;
    for (let c = 0; c < headers.length; c++) {
      const name = headers[c]!;        // header exists by loop invariant
      const cell = (row[c] ?? "") as string; // align to non undefined
      const trimmed = cell.trim();
      const num = trimmed.length ? Number(trimmed) : NaN;

      if (Number.isFinite(num)) {
        const a = acc[name]!;
        a.countNumbers++;
        a.sum += num;
        a.min = a.min === null ? num : Math.min(a.min, num);
        a.max = a.max === null ? num : Math.max(a.max, num);
      } else if (trimmed !== "") {
        acc[name]!.invalidCells++;
      }
    }
  }

  // 4) Report
  const report: Report = Object.freeze({
    rowsProcessed,
    columns: finalizeStats(acc)
  });

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    await writeFile(args.out, json, "utf8");
    console.error(`Wrote report to: ${args.out}`);
  } else {
    console.log(json);
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) console.error("Fatal:", err.message);
  else console.error("Fatal:", err);
  exit(1);
});
// ----- End of CLI code -----