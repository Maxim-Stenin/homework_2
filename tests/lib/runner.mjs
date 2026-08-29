// Крошечный раннер: регистрация проверок, ассерты, отчёт, код возврата.
// Каждый тест назван идентификатором проверки из TEST-PLAN.md — так падение
// теста сразу указывает на пункт плана и годится в баг-репорт.

const suite = [];

/** register('ПР-F-02', 'Фильтр по типу «Расходы»', async (app, t) => { ... }) */
export function test(id, title, fn) {
  suite.push({ id, title, fn });
}

export function listTests() { return suite; }

class Assertions {
  constructor() { this.notes = []; this.failures = []; }

  note(line) { this.notes.push(line); }

  ok(cond, what) {
    if (cond) this.notes.push(`  ✓ ${what}`);
    else this.failures.push(`${what} — не выполнено`);
    return cond;
  }

  eq(actual, expected, what) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (same) this.notes.push(`  ✓ ${what}: ${fmt(actual)}`);
    else this.failures.push(`${what}: ожидалось ${fmt(expected)}, получено ${fmt(actual)}`);
    return same;
  }

  match(actual, re, what) {
    const hit = re.test(actual ?? '');
    if (hit) this.notes.push(`  ✓ ${what}: ${fmt(actual)}`);
    else this.failures.push(`${what}: ${fmt(actual)} не подходит под ${re}`);
    return hit;
  }

  notMatch(actual, re, what) {
    const hit = re.test(actual ?? '');
    if (!hit) this.notes.push(`  ✓ ${what}: ${fmt(actual)}`);
    else this.failures.push(`${what}: ${fmt(actual)} не должно подходить под ${re}`);
    return !hit;
  }
}

const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

export async function runAll(makeContext, { only = null } = {}) {
  const results = [];
  const chosen = only ? suite.filter((t) => only.some((p) => t.id.includes(p))) : suite;
  if (!chosen.length) throw new Error('Под фильтр не подошла ни одна проверка');

  for (const t of chosen) {
    const started = Date.now();
    const a = new Assertions();
    let error = null;
    try {
      const ctx = await makeContext();
      await t.fn(ctx, a);
    } catch (e) {
      error = e;
    }
    const failed = error || a.failures.length > 0;
    const r = { ...t, notes: a.notes, failures: a.failures, error, ms: Date.now() - started, failed };
    results.push(r);
    print(r);
  }
  return results;
}

function print(r) {
  const mark = r.failed ? 'FAIL' : 'PASS';
  console.log(`${mark}  ${r.id} · ${r.title}  (${r.ms} мс)`);
  for (const n of r.notes) console.log(n);
  for (const f of r.failures) console.log(`  ✗ ${f}`);
  if (r.error) console.log(`  ✗ исключение: ${r.error.stack || r.error}`);
}

export function summary(results) {
  const failed = results.filter((r) => r.failed);
  console.log('');
  console.log('='.repeat(72));
  console.log(`ИТОГО: проверок ${results.length}, провалов ${failed.length}`);
  if (failed.length) {
    console.log('Упали:');
    for (const r of failed) console.log(`  - ${r.id} · ${r.title}`);
  }
  console.log('='.repeat(72));
  return failed.length === 0;
}
