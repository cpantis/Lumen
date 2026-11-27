/**
 * Static check that the English UI has no Romanian left:
 *  1. every tr("…") literal has an English translation in src/i18n/en.ts;
 *  2. no string literal / JSX text in src/ (outside src/i18n) contains Romanian
 *     diacritics or common Romanian words unless it is wrapped in tr("…").
 *   npx tsx scripts/check-english.ts   (exit 1 when something is found)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EN } from "../src/i18n/en";

const RO = /[ăâîșşțţĂÂÎȘŞȚŢ]|\b(timp|pas|intrare|ieșire|goluri|cadre|mesaje|salt|potrivire|pentru|nicio|niciun|intervale|instantaneu|nr\.|frecventa|latenta|adancime|imagine|valori|mediu|medie)\b/i;
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f)) files.push(p);
  }
};
walk("src");
const issues: string[] = [];
/** allowed: the name of the Romanian language in the language selector */
const ALLOW = new Set(["Română"]);
for (const f of files) {
  if (f.startsWith(join("src", "i18n"))) continue;
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  // 1. tr("…") without translation
  for (const m of src.matchAll(/\btr\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*\)/g)) {
    const key = m[2].replace(/\\(["'`\\])/g, "$1");
    if (!(key in EN)) issues.push(`${f}:${src.slice(0, m.index).split("\n").length}: tr() without English: ${key.slice(0, 100)}`);
  }
  // 2. Romanian outside tr(), comments excluded
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (/^\s*\*/.test(line) || /^\s*\/\*/.test(line)) return;
    const stripped = code.replace(/\btr\(\s*(["'`])(?:\\.|(?!\1).)*\1\s*\)/g, "").replace(/\btrField\([^)]*\)/g, "").replace(/\/[^/\n]*\/[gimsuy]*/g, (r) => (/[ăâîșț]/.test(r) ? "" : r));
    for (const lit of stripped.matchAll(/(["'`])((?:\\.|(?!\1).)+)\1|>([^<>{}]+)</g)) {
      const s = lit[2] ?? lit[3] ?? "";
      if (RO.test(s) && !ALLOW.has(s.trim())) issues.push(`${f}:${i + 1}: ${s.trim().slice(0, 100)}`);
    }
  });
}
for (const x of issues) console.log(x);
console.log(`\n${issues.length} Romanian text(s) found`);
process.exit(issues.length ? 1 : 0);
