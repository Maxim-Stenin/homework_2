// Обёртка над страницей приложения «Мои финансы».
// Всё — со стороны пользователя: только DOM, id из §1.5 TEST-PLAN.md.
// Исходный код приложения здесь не читается и не используется.
import { sleep } from './cdp.mjs';

/** Фикстура Ф1 — базовый набор, §1.3 TEST-PLAN.md. */
export const F1 = [
  'date,type,category,amount,comment',
  '2026-08-01,expense,Продукты,1000.00,граница «с»',
  '2026-08-05,income,Зарплата,50000.00,доход внутри',
  '2026-08-10,expense,Кафе,500.00,внутри',
  '2026-08-20,expense,Такси,300.00,граница «по»',
  '2026-08-25,expense,Аптека,200.00,вне периода',
  '2026-08-28,income,Подработка,7000.00,доход вне периода',
].join('\n');

/** Фикстура Ф2 — регистр и пробелы в категории. */
export const F2 = F1 + '\n2026-08-12,expense, кафе ,250.00,регистр и пробелы';

export const STORAGE_KEY = 'finance.csv';

/** Неразрывные пробелы из ru-RU-форматирования приводятся к обычным. */
export const norm = (s) => (s ?? '').replace(/[  ]/g, ' ').trim();

export class App {
  constructor(page, baseUrl) {
    this.page = page;
    this.url = `${baseUrl}/index.html`;
  }

  /** Открыть приложение с заданным содержимым хранилища (null — пустое). */
  async open(csv = null) {
    const seed = csv === null
      ? `try { localStorage.clear(); } catch (e) {}`
      : `try { localStorage.clear(); localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(csv)}); } catch (e) {}`;
    const id = await this.page.addPreload(seed);
    await this.page.goto(this.url);
    // Снимаем засев: иначе он сработает и на перезагрузке и затрёт то,
    // что проверяем на живучесть (грабли из сессии 7).
    await this.page.removePreload(id);
  }

  reload() { return this.page.reload(); }

  emulateColorScheme(value) { return this.page.emulateColorScheme(value); }

  setFileInput(selector, files) { return this.page.setFileInput(selector, files); }

  // ——— чтение экрана ———

  text(id) {
    return this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      return el ? el.textContent.replace(/[\\u00A0\\u202F]/g, ' ').trim() : null;`);
  }

  value(id) {
    return this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      return el ? el.value : null;`);
  }

  attr(id, name) {
    return this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      return el ? el.getAttribute(${JSON.stringify(name)}) : null;`);
  }

  prop(id, name) {
    return this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      return el ? el[${JSON.stringify(name)}] : null;`);
  }

  /**
   * Видимость — по вычисленному стилю и коробке, а не по атрибуту `hidden`
   * (находка Н-15: атрибут может стоять, а элемент быть виден).
   */
  box(id) {
    return this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { display: cs.display, visibility: cs.visibility, width: r.width, height: r.height,
               visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 };`);
  }

  async visible(id) {
    const b = await this.box(id);
    return !!b && b.visible;
  }

  /** Итоги тремя строками, в том виде, в каком их видит пользователь. */
  async sums() {
    return {
      income: await this.text('sumIncome'),
      expense: await this.text('sumExpense'),
      balance: await this.text('sumBalance'),
    };
  }

  /** Строки таблицы: дата, категория, комментарий, сумма. */
  rows() {
    return this.page.eval(`return [...document.querySelectorAll('#tbody tr')].map((tr) =>
      [...tr.cells].map((td) => td.textContent.replace(/[\\u00A0\\u202F]/g, ' ').trim()));`);
  }

  async rowCount() { return (await this.rows()).length; }

  /** Легенда диаграммы: подписи сегментов текстом. */
  legend() {
    return this.page.eval(`const el = document.getElementById('legend');
      if (!el) return [];
      const items = el.children.length ? [...el.children] : [];
      return items.map((n) => n.textContent.replace(/[\\u00A0\\u202F]/g, ' ').replace(/\\s+/g, ' ').trim());`);
  }

  /** Счётчик активных фильтров: текст и видимость. */
  async filtersCount() {
    const box = await this.box('filtersCount');
    const text = await this.text('filtersCount');
    return { text, visible: !!box && box.visible };
  }

  /** Список категорий в фильтре — подписи опций. */
  filterCategories() {
    return this.page.eval(`const el = document.getElementById('filterCategory');
      return el ? [...el.options].map((o) => ({ value: o.value, label: o.textContent.trim() })) : null;`);
  }

  /** Состояние вкладок диаграммы. */
  tabs() {
    return this.page.eval(`const g = (id) => { const el = document.getElementById(id); return el && {
        inDom: true, disabled: el.disabled, hidden: el.hasAttribute('hidden'),
        pressed: el.getAttribute('aria-pressed'),
        visible: getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 }; };
      return { expense: g('tabExpense'), income: g('tabIncome') };`);
  }

  /** Состояние переключателя темы. */
  theme() {
    return this.page.eval(`const p = (id) => { const el = document.getElementById(id); return el && el.getAttribute('aria-pressed'); };
      return { auto: p('themeAuto'), light: p('themeLight'), dark: p('themeDark'),
               dataTheme: document.documentElement.getAttribute('data-theme'),
               background: getComputedStyle(document.body).backgroundColor };`);
  }

  /** Всё состояние фильтров одним снимком. */
  filters() {
    return this.page.eval(`const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      return { type: v('filterType'), category: v('filterCategory'), from: v('filterFrom'), to: v('filterTo') };`);
  }

  /** Содержимое хранилища глазами пользователя (через DevTools, не через код приложения). */
  storage() {
    return this.page.eval(`try {
        return { keys: Object.keys(localStorage).sort(), data: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) };
      } catch (e) { return { keys: null, data: null, error: String(e) }; }`);
  }

  // ——— действия ———

  async click(id) {
    const ok = await this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false; el.click(); return true;`);
    if (!ok) throw new Error(`Кнопка #${id} не найдена`);
    await sleep(90);
  }

  /** Ввод в поле с событиями input и change — как при наборе с клавиатуры. */
  async fill(id, value) {
    const ok = await this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      el.focus();
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return true;`);
    if (!ok) throw new Error(`Поле #${id} не найдено`);
    await sleep(90);
  }

  /**
   * Выбрать опцию списка по видимой подписи, а не по внутреннему значению:
   * значения `value` — деталь реализации, подпись — то, что видит пользователь.
   */
  async chooseOption(id, labelRe) {
    const chosen = await this.page.eval(`const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return null;
      const re = new RegExp(${JSON.stringify(labelRe.source)}, ${JSON.stringify(labelRe.flags)});
      const opt = [...el.options].find((o) => re.test(o.textContent.trim()));
      if (!opt) return null;
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: opt.value, label: opt.textContent.trim() };`);
    if (!chosen) throw new Error(`В списке #${id} нет опции по образцу ${labelRe}`);
    await sleep(110);
    return chosen;
  }

  /** Добавить запись через форму — тем же путём, что и пользователь. */
  async addRecord({ type = 'expense', amount, category, date, comment = '' }) {
    await this.chooseOption('fType', type === 'income' ? /Доход/i : /Расход/i);
    await this.fill('fAmount', String(amount));
    await this.fill('fCategory', category);
    if (date) await this.fill('fDate', date);
    await this.fill('fComment', comment);
    const ok = await this.page.eval(`const form = document.getElementById('addForm');
      if (!form) return false;
      const btn = form.querySelector('button[type=submit]') || form.querySelector('button');
      if (btn) { btn.click(); return true; }
      form.requestSubmit();
      return true;`);
    if (!ok) throw new Error('Форма #addForm не найдена');
    await sleep(140);
  }

  /** Удалить строку таблицы по номеру (с 1) — кнопкой в самой строке. */
  async deleteRow(n, confirmIt = true) {
    this.page.dialogAnswer = confirmIt;
    const ok = await this.page.eval(`const tr = document.querySelectorAll('#tbody tr')[${n - 1}];
      if (!tr) return false;
      const btn = tr.querySelector('button');
      if (!btn) return false;
      btn.click();
      return true;`);
    if (!ok) throw new Error(`Строка ${n} или кнопка удаления в ней не найдена`);
    await sleep(200);
  }

  async openFilters() {
    if ((await this.attr('filtersToggle', 'aria-expanded')) !== 'true') await this.click('filtersToggle');
  }

  async setFilter({ type, category, from, to } = {}) {
    await this.openFilters();
    if (type !== undefined) await this.chooseOption('filterType', type);
    if (category !== undefined) await this.chooseOption('filterCategory', category);
    if (from !== undefined) await this.fill('filterFrom', from);
    if (to !== undefined) await this.fill('filterTo', to);
  }
}
