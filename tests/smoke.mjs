// Смоук-набор автотестов «Мои финансы».
//
// Назначение — не полная замена TEST-PLAN.md (67 проверок), а быстрый ответ
// на вопрос «не сломалось ли остальное» после добавления фичи. Покрыты
// главные утверждения по каждой из четырёх фич и регресс по старому
// функционалу. Идентификаторы совпадают с пунктами TEST-PLAN.md:
// упавший тест сразу указывает на проверку плана и годится в баг-репорт.
//
// Правило набора: тест опирается только на DOM и на то, что доступно
// пользователю. Исходный код приложения не читается и не подменяется.

import { test } from './lib/runner.mjs';
import { F1, F2, STORAGE_KEY } from './lib/app.mjs';
import { sleep } from './lib/cdp.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** «57 000,00 ₽» → 57000. Неразрывные пробелы уже сняты в App.text(). */
const money = (s) => {
  if (s === null || s === undefined) return NaN;
  const t = String(s).replace(/[^\d,.\-−]/g, '').replace('−', '-').replace(/\./g, '').replace(',', '.');
  return Number(t);
};

const F1_TOTAL = { income: 57000, expense: 2000, balance: 55000 };

// ————————————————————————————————————————————————————————————————
// Базовое поведение
// ————————————————————————————————————————————————————————————————

test('ПР-A-01', 'Чистая загрузка: временных элементов на экране нет', async ({ app }, a) => {
  await app.open(null);

  for (const id of ['filtersStale', 'storageAlert', 'filtersPanel', 'fileInput']) {
    const box = await app.box(id);
    a.ok(box && !box.visible, `#${id} не виден (display=${box?.display}, ${box?.width}×${box?.height})`);
  }
  a.ok(await app.visible('tableEmpty'), '#tableEmpty виден');
  a.eq(await app.text('tableEmpty'), 'Записей пока нет.', 'текст пустой таблицы');
  a.ok(await app.visible('chartEmpty'), '#chartEmpty виден');

  const s = await app.sums();
  a.eq([money(s.income), money(s.expense), money(s.balance)], [0, 0, 0], 'итоги — три нуля');
  a.eq(await app.rowCount(), 0, 'строк в таблице');
});

test('ПР-B-01', 'Добавление дохода и расхода: итоги, таблица, хранилище', async ({ app }, a) => {
  await app.open(null);
  const today = await app.value('fDate');
  a.match(today, /^\d{4}-\d{2}-\d{2}$/, 'дата в форме заполнена по умолчанию');

  await app.addRecord({ type: 'expense', amount: '1200', category: 'Продукты', comment: 'смоук-расход' });
  await app.addRecord({ type: 'income', amount: '5000', category: 'Зарплата', comment: 'смоук-доход' });

  a.eq(await app.text('formError'), '', 'форма не ругается');
  const s = await app.sums();
  a.eq(s.income, '5 000,00 ₽', '#sumIncome');
  a.eq(s.expense, '1 200,00 ₽', '#sumExpense');
  a.eq(s.balance, '3 800,00 ₽', '#sumBalance');
  a.eq(await app.rowCount(), 2, 'строк в таблице');
  a.ok(!(await app.visible('tableEmpty')), 'пустое состояние снято');

  const st = await app.storage();
  a.ok((st.data || '').includes('Продукты') && (st.data || '').includes('Зарплата'),
    `обе записи в ${STORAGE_KEY}`);
});

test('ПР-B-02', 'Диаграмма и легенда считают записи по вкладкам', async ({ app }, a) => {
  await app.open(null);
  await app.addRecord({ type: 'expense', amount: '1200', category: 'Продукты' });
  await app.addRecord({ type: 'income', amount: '5000', category: 'Зарплата' });

  a.ok(!(await app.visible('chartEmpty')), '#chartEmpty скрыт при наличии данных');
  const expenseLegend = (await app.legend()).join(' | ');
  a.match(expenseLegend, /Продукты/, 'на вкладке расходов — «Продукты»');
  a.match(expenseLegend, /1 200,00/, 'сумма сегмента расходов');

  await app.click('tabIncome');
  const incomeLegend = (await app.legend()).join(' | ');
  a.match(incomeLegend, /Зарплата/, 'на вкладке доходов — «Зарплата»');
  a.match(incomeLegend, /5 000,00/, 'сумма сегмента доходов');
  const tabs = await app.tabs();
  a.eq([tabs.expense.pressed, tabs.income.pressed], ['false', 'true'], 'aria-pressed вкладок');
});

test('ПР-A-02', 'Загрузка с данными: 6 записей Ф1, плашка не поднята', async ({ app }, a) => {
  await app.open(F1);
  a.eq(await app.rowCount(), 6, 'строк в таблице');
  const s = await app.sums();
  a.eq([money(s.income), money(s.expense), money(s.balance)],
    [F1_TOTAL.income, F1_TOTAL.expense, F1_TOTAL.balance], 'итоги по Ф1');
  a.ok(!(await app.visible('filtersStale')), 'плашка «устарел» не видна');
  a.ok(!(await app.visible('storageAlert')), 'сообщение хранилища не видно');
  const c = await app.filtersCount();
  a.ok(!c.visible || c.text === '0', `счётчик фильтров пуст (виден=${c.visible}, текст=${c.text})`);
});

// ————————————————————————————————————————————————————————————————
// Фильтрация
// ————————————————————————————————————————————————————————————————

test('ПР-F-01', 'Панель фильтров открывается и закрывается, фильтров ровно три', async ({ app }, a) => {
  await app.open(F1);
  a.eq(await app.attr('filtersToggle', 'aria-expanded'), 'false', 'панель закрыта на старте');

  await app.click('filtersToggle');
  a.eq(await app.attr('filtersToggle', 'aria-expanded'), 'true', 'aria-expanded после открытия');
  const panel = await app.box('filtersPanel');
  a.ok(panel.visible, `панель раскрыта (display=${panel.display}, ${panel.width}×${panel.height})`);
  for (const id of ['filterType', 'filterCategory', 'filterFrom', 'filterTo', 'filtersReset']) {
    a.ok(await app.visible(id), `#${id} виден в панели`);
  }
  const controls = await app.page.eval(`const p = document.getElementById('filtersPanel');
    return [...p.querySelectorAll('input, select')].map((el) => el.id || el.type);`);
  a.eq(controls.length, 4, `полей ввода в панели ровно 4 (три фильтра): ${controls.join(', ')}`);

  await app.click('filtersToggle');
  a.eq(await app.attr('filtersToggle', 'aria-expanded'), 'false', 'aria-expanded после закрытия');
  a.ok(!(await app.visible('filtersPanel')), 'панель закрылась');
});

test('ПР-F-02', 'Фильтр по типу «Расходы»: таблица, итоги, диаграмма, вкладка, счётчик', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });

  const rows = await app.rows();
  a.eq(rows.length, 4, 'в таблице только расходы — 4 строки');
  const cats = rows.map((r) => r[1]).sort();
  a.eq(cats, ['Аптека', 'Кафе', 'Продукты', 'Такси'], 'категории строк');

  const s = await app.sums();
  a.eq(money(s.expense), 2000, '#sumExpense');
  a.eq(money(s.income), 0, '#sumIncome');
  a.eq(money(s.balance), -2000, '#sumBalance');

  const tabs = await app.tabs();
  a.ok(tabs.income.disabled, '#tabIncome погашена (disabled)');
  a.ok(!tabs.income.hidden && tabs.income.visible, '#tabIncome не скрыта и осталась в разметке');
  a.ok(!tabs.expense.disabled, '#tabExpense активна');

  const c = await app.filtersCount();
  a.eq(c.text, '1', 'счётчик активных фильтров');
  a.ok(c.visible, 'счётчик виден');
});

test('ПР-F-03', 'Фильтр по типу «Доходы» — зеркальная проверка', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Доход/i });

  a.eq(await app.rowCount(), 2, 'в таблице два дохода');
  const s = await app.sums();
  a.eq(money(s.income), 57000, '#sumIncome');
  a.eq(money(s.expense), 0, '#sumExpense');

  const tabs = await app.tabs();
  a.ok(tabs.expense.disabled, '#tabExpense погашена');
  a.ok(!tabs.expense.hidden && tabs.expense.visible, '#tabExpense видна');
  a.eq((await app.filtersCount()).text, '1', 'счётчик');
});

test('ПР-F-04', 'Возврат типа в «Все» снимает гашение вкладок', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });
  await app.chooseOption('filterType', /^Все|Все типы/i);

  const tabs = await app.tabs();
  a.ok(!tabs.expense.disabled && !tabs.income.disabled, 'обе вкладки активны');
  a.eq(await app.rowCount(), 6, 'вернулись все 6 записей');
  const c = await app.filtersCount();
  a.ok(!c.visible || c.text === '0', `счётчик обнулён (виден=${c.visible}, текст=${c.text})`);
});

test('ПР-F-05', 'Период охватывает часть записей, границы включаются', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ from: '2026-08-01', to: '2026-08-20' });

  const rows = await app.rows();
  a.eq(rows.length, 4, 'строк в периоде');
  const dates = rows.map((r) => r[0]).sort();
  a.ok(dates.some((d) => d.includes('01')), 'граница «с» (01.08) включена');
  a.ok(dates.some((d) => d.includes('20')), 'граница «по» (20.08) включена');
  a.ok(!rows.some((r) => r[1] === 'Аптека' || r[1] === 'Подработка'), 'записи вне периода не показаны');

  const s = await app.sums();
  a.eq([money(s.income), money(s.expense), money(s.balance)], [50000, 1800, 48200], 'итоги по периоду');
  a.eq((await app.filtersCount()).text, '2', 'счётчик — две границы периода');
});

test('ПР-F-06', 'Пустой результат фильтрации — отдельное состояние с выходом', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ from: '2026-08-01', to: '2026-08-05', category: /Аптека/i });

  a.eq(await app.rowCount(), 0, 'таблица пуста');
  a.ok(await app.visible('tableEmpty'), 'пустое состояние показано');
  const text = await app.text('tableEmpty');
  a.notMatch(text, /^Записей пока нет\.$/, `текст отличается от «записей нет»: ${JSON.stringify(text)}`);

  a.ok(await app.visible('filtersReset'), '#filtersReset — способ вернуться к полному списку — виден');
  await app.click('filtersReset');
  a.eq(await app.rowCount(), 6, 'после сброса вернулись все 6 записей');
});

test('ПР-F-15', 'Фильтр по категории', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ category: /^Кафе$/i });

  const rows = await app.rows();
  a.eq(rows.length, 1, 'строк категории «Кафе»');
  a.eq(rows[0][1], 'Кафе', 'категория строки');
  a.eq(money((await app.sums()).expense), 500, 'итог расходов пересчитан по фильтру');
  a.eq((await app.filtersCount()).text, '1', 'счётчик');
});

test('ПР-N-11', 'Комбинация всех трёх фильтров, счётчик = 4', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i, category: /^Кафе$/i, from: '2026-08-01', to: '2026-08-20' });

  const rows = await app.rows();
  a.eq(rows.length, 1, 'одна строка');
  a.eq(rows[0][1], 'Кафе', 'это «Кафе»');
  const s = await app.sums();
  a.eq([money(s.expense), money(s.income)], [500, 0], 'итоги');
  a.ok((await app.tabs()).income.disabled, '#tabIncome погашена');
  a.eq((await app.filtersCount()).text, '4', 'счётчик — четыре составляющие');
});

test('ПР-F-07', 'Запись мимо фильтра: первая строка, плашка, итоги её не учли', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });
  const before = await app.sums();

  await app.addRecord({ type: 'income', amount: '999', category: 'Премия', date: '2026-08-02', comment: 'мимо фильтра' });

  const rows = await app.rows();
  a.eq(rows[0][1], 'Премия', 'новая запись — первая строка, в обход сортировки по дате');
  const stale = await app.box('filtersStale');
  a.ok(stale.visible, `плашка «устарел» видна (display=${stale.display}, ${stale.width}×${stale.height})`);
  a.ok(await app.visible('filtersRefresh'), 'кнопка «Обновить» на плашке видна');
  a.ok(await app.visible('filtersClose'), 'крестик на плашке виден');

  const after = await app.sums();
  a.eq(money(after.income), 0, '#sumIncome не изменился — итоги запись не учли');
  a.eq(after.expense, before.expense, '#sumExpense не изменился');
});

test('ПР-F-08', '«Обновить» пересобирает список, запись остаётся в данных', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });
  await app.addRecord({ type: 'income', amount: '999', category: 'Премия', date: '2026-08-02' });

  await app.click('filtersRefresh');

  const rows = await app.rows();
  a.ok(!rows.some((r) => r[1] === 'Премия'), 'посторонняя запись ушла из таблицы');
  a.eq(rows.length, 4, 'остались 4 расхода');
  a.ok(!(await app.visible('filtersStale')), 'плашка снята');
  a.eq((await app.filtersCount()).text, '1', 'фильтр остался активным');
  const st = await app.storage();
  a.match(st.data, /Премия/, 'запись осталась в хранилище, а не удалена');
});

test('ПР-F-09', 'Крестик закрывает только плашку, список не пересобран', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });
  await app.addRecord({ type: 'income', amount: '999', category: 'Премия', date: '2026-08-02' });

  await app.click('filtersClose');

  a.ok(!(await app.visible('filtersStale')), 'плашка исчезла');
  const rows = await app.rows();
  a.eq(rows[0][1], 'Премия', 'посторонняя запись по-прежнему первой строкой');
  a.eq(money((await app.sums()).income), 0, 'итоги её по-прежнему не учитывают');
  a.eq((await app.filtersCount()).text, '1', 'фильтр активен');
});

test('ПР-F-10', 'Удаление при активном фильтре: фильтр цел, плашка поднята', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });
  const target = (await app.rows()).findIndex((r) => r[1] === 'Кафе');
  a.ok(target >= 0, 'строка «Кафе» есть в отфильтрованной таблице');

  await app.deleteRow(target + 1, true);

  a.ok(app.page.dialogs.length > 0, `удаление спросило подтверждение (${app.page.dialogs.length} диалог)`);
  const rows = await app.rows();
  a.ok(!rows.some((r) => r[1] === 'Кафе'), '«Кафе» исчезло из таблицы');
  a.eq((await app.filtersCount()).text, '1', 'фильтр не сброшен');
  a.ok(await app.visible('filtersStale'), 'плашка «устарел» появилась');
  const st = await app.storage();
  a.notMatch(st.data, /Кафе/, 'запись удалена и из хранилища');
});

test('ПР-N-05', 'Перевёрнутый период: ошибка видна, список не изменился', async ({ app }, a) => {
  await app.open(F1);
  // «Список не изменился» считается от состояния прямо перед вводом второй
  // границы: одна заполненная граница — уже действующий фильтр.
  await app.setFilter({ from: '2026-08-20' });
  const before = await app.rows();
  a.eq(before.length, 3, 'до ввода второй границы в списке 3 записи');

  await app.fill('filterTo', '2026-08-01');

  const err = await app.text('filtersError');
  a.ok(err && err.length > 0, `#filtersError показывает ошибку: ${JSON.stringify(err)}`);
  a.ok(await app.visible('filtersError'), 'ошибка видна на экране');
  a.eq(await app.rows(), before, 'список не изменился — ни «пусто», ни «всё заново»');

  // ПР-N-06: исправление периода снимает ошибку
  await app.fill('filterTo', '2026-08-25');
  a.eq(await app.text('filtersError'), '', 'после исправления ошибка снята');
  a.eq(await app.rowCount(), 2, 'список пересобран по корректному периоду 20.08 … 25.08');
});

test('ПР-N-07', 'Категории сопоставляются по canon: регистр и пробелы не различаются', async ({ app }, a) => {
  await app.open(F2);
  const options = await app.filterCategories();
  const kafe = options.filter((o) => /кафе/i.test(o.label));
  a.eq(kafe.length, 1, `«Кафе» встречается в списке фильтра один раз: ${JSON.stringify(kafe)}`);

  await app.setFilter({ category: /кафе/i });
  const rows = await app.rows();
  a.eq(rows.length, 2, 'в таблице обе записи — «Кафе» и « кафе »');
  a.eq(money((await app.sums()).expense), 750, 'итог расходов — 750,00');
  const legend = (await app.legend()).join(' | ');
  a.match(legend, /750,00/, 'в легенде один сегмент на 750,00');
});

test('ПР-F-14', 'Фильтр не переживает перезагрузку и не пишется в хранилище', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i, from: '2026-08-01', to: '2026-08-20' });
  a.eq(await app.rowCount(), 3, 'фильтр применён до перезагрузки');

  await app.reload();

  a.eq(await app.rowCount(), 6, 'после перезагрузки видны все 6 записей');
  const f = await app.filters();
  a.ok(!f.from && !f.to, 'границы периода пусты');
  const c = await app.filtersCount();
  a.ok(!c.visible || c.text === '0', 'счётчик обнулён');
  const st = await app.storage();
  a.ok(!st.keys.some((k) => /filter/i.test(k)), `в localStorage нет ключа фильтра: ${st.keys.join(', ')}`);
});

test('ПР-F-17', '«Сбросить фильтры» возвращает исходное состояние', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i, category: /^Кафе$/i, from: '2026-08-01', to: '2026-08-20' });

  await app.click('filtersReset');

  const f = await app.filters();
  a.ok(!f.category && !f.from && !f.to, `категория и период очищены: ${JSON.stringify(f)}`);
  a.eq(await app.rowCount(), 6, 'все 6 записей Ф1');
  const s = await app.sums();
  a.eq([money(s.income), money(s.expense)], [57000, 2000], 'итоги полные');
  const tabs = await app.tabs();
  a.ok(!tabs.expense.disabled && !tabs.income.disabled, 'обе вкладки активны');
  a.eq(await app.text('filtersError'), '', '#filtersError пуст');
  a.ok(!(await app.visible('filtersStale')), 'плашка не видна');
  const c = await app.filtersCount();
  a.ok(!c.visible || c.text === '0', 'счётчик обнулён');
});

test('ПР-F-11', 'Выгрузка CSV при активном фильтре отдаёт то, что на экране', async ({ app, downloads }, a) => {
  await app.open(F1);
  await app.setFilter({ from: '2026-08-01', to: '2026-08-20' });
  await app.page.setDownloadDir(downloads);

  await app.click('btnSave');
  const file = await waitForDownload(downloads, /\.csv$/i);
  a.ok(!!file, `файл выгрузки появился: ${file}`);

  const raw = await readFile(join(downloads, file), 'utf8');
  const text = raw.replace(/^﻿/, '');
  a.ok(raw.charCodeAt(0) === 0xfeff, 'BOM на месте');
  const lines = text.trim().split(/\r?\n/);
  a.eq(lines[0], 'date,type,category,amount,comment', 'заголовок не изменился');
  a.eq(lines.length - 1, 4, 'в файле ровно 4 строки — те же, что на экране');
  a.notMatch(text, /2026-08-25|2026-08-28/, 'записей вне периода в файле нет');
  a.match(text, /1000\.00/, 'суммы с двумя знаками');
});

test('ПР-F-12', 'Загрузка CSV сбрасывает фильтр', async ({ app, fixtureFile }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i, from: '2026-08-01', to: '2026-08-20' });

  app.page.dialogAnswer = true;
  await app.click('btnLoad');
  await app.setFileInput('#fileInput', [fixtureFile]);
  await sleep(400);

  a.ok(app.page.dialogs.length > 0, 'замена списка спросила подтверждение');
  const f = await app.filters();
  a.ok(!f.category && !f.from && !f.to, `фильтры очищены: ${JSON.stringify(f)}`);
  const c = await app.filtersCount();
  a.ok(!c.visible || c.text === '0', 'счётчик обнулён');
  a.eq(await app.rowCount(), 6, 'в таблице все 6 записей из файла');
  const s = await app.sums();
  a.eq([money(s.income), money(s.expense)], [57000, 2000], 'итоги полные');
  a.ok(!(await app.visible('filtersStale')), 'плашка «устарел» не показана');
});

// ————————————————————————————————————————————————————————————————
// Тёмная тема
// ————————————————————————————————————————————————————————————————

test('ПР-T-01', 'Три состояния переключателя, aria-pressed следует за выбором', async ({ app }, a) => {
  await app.open(F1);
  const count = await app.page.eval(`const g = document.getElementById('themeSwitch');
    return g ? g.querySelectorAll('button').length : -1;`);
  a.eq(count, 3, 'кнопок в #themeSwitch ровно три');

  for (const [id, key] of [['themeLight', 'light'], ['themeDark', 'dark'], ['themeAuto', 'auto']]) {
    await app.click(id);
    const t = await app.theme();
    const on = Object.entries({ auto: t.auto, light: t.light, dark: t.dark }).filter(([, v]) => v === 'true');
    a.eq(on.map(([k]) => k), [key], `после нажатия #${id} включена ровно одна кнопка`);
  }
});

test('ПР-T-02', 'Выбранная тема переживает перезагрузку, деньги не тронуты', async ({ app }, a) => {
  await app.open(F1);
  const before = await app.storage();

  await app.click('themeDark');
  const dark = await app.theme();
  a.eq(dark.dark, 'true', 'тёмная выбрана');

  await app.reload();
  const after = await app.theme();
  a.eq(after.dark, 'true', 'после перезагрузки переключатель по-прежнему в «тёмная»');
  a.eq(after.background, dark.background, 'фон совпадает с тёмным до перезагрузки');

  const st = await app.storage();
  a.eq(st.data, before.data, `${STORAGE_KEY} не изменён байт в байт`);
  const themeKeys = st.keys.filter((k) => k !== STORAGE_KEY);
  a.eq(themeKeys.length, 1, `выбор темы лежит отдельным ключом: ${themeKeys.join(', ')}`);
});

test('ПР-T-04', 'Режим «авто» следует за системной темой без перезагрузки', async ({ app }, a) => {
  await app.emulateColorScheme('light');
  await app.open(F1);
  await app.click('themeAuto');
  const light = await app.theme();

  await app.emulateColorScheme('dark');
  await sleep(250);
  const dark = await app.theme();
  a.ok(dark.background !== light.background,
    `фон сменился без перезагрузки: ${light.background} → ${dark.background}`);
  a.eq(dark.auto, 'true', 'переключатель остался в «авто»');

  await app.emulateColorScheme('light');
  await sleep(250);
  const back = await app.theme();
  a.eq(back.background, light.background, 'возврат системной светлой темы отработал');
  a.eq(app.page.exceptions.length, 0, 'необработанных исключений нет');
});

// ————————————————————————————————————————————————————————————————
// Вёрстка и адаптив
// ————————————————————————————————————————————————————————————————

test('ПР-D-01', 'Ширина 375 px: нет горизонтальной прокрутки страницы', async ({ app }, a) => {
  await app.page.setViewport(375, 812, true);
  await app.open(F1);
  await app.addRecord({
    type: 'expense', amount: '99999999', category: 'Категория ровно тридцать два!',
    comment: 'Очень длинный комментарий, '.repeat(8),
  });

  const closed = await app.page.eval(`return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };`);
  a.ok(closed.sw <= closed.cw + 1, `панель закрыта: scrollWidth ${closed.sw} ≤ clientWidth ${closed.cw}`);

  await app.click('filtersToggle');
  const opened = await app.page.eval(`return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };`);
  a.ok(opened.sw <= opened.cw + 1, `панель открыта: scrollWidth ${opened.sw} ≤ clientWidth ${opened.cw}`);
  for (const id of ['filterType', 'filterCategory', 'filterFrom', 'filterTo']) {
    const b = await app.box(id);
    a.ok(b.visible && b.width > 0, `#${id} не обрезан (${Math.round(b.width)}×${Math.round(b.height)})`);
  }
  await app.page.clearViewport();
});

// ————————————————————————————————————————————————————————————————
// Отказ хранилища
// ————————————————————————————————————————————————————————————————

test('ПР-S-01', 'Переполнение квоты: сообщение видно, запись осталась на экране', async ({ app }, a) => {
  await app.open(F1);
  const before = (await app.storage()).data;

  // Квота забивается посторонними ключами, а не порчей finance.csv, и добивается
  // всё более мелкими кусками: иначе после отказа на крупном куске места
  // остаётся больше, чем нужно приложению, и отказа записи не случится.
  const ballast = await app.page.eval(`let n = 0;
    for (const size of [256 * 1024, 8 * 1024, 256, 16, 1]) {
      const chunk = 'x'.repeat(size);
      try { for (let i = 0; i < 5000; i++) { localStorage.setItem('ballast-' + n, chunk); n++; } }
      catch (e) { /* на этом размере места больше нет — переходим к мельче */ }
    }
    return n;`);
  a.ok(ballast > 0, `хранилище забито балластом: ${ballast} ключей`);

  await app.addRecord({ type: 'expense', amount: '888', category: 'Переполнение', date: '2026-08-27' });

  const alert = await app.box('storageAlert');
  a.ok(alert.visible, `#storageAlert виден (display=${alert.display})`);
  const msg = await app.text('storageAlert');
  a.match(msg, /не сохранен/i, `сообщение говорит, что данные не сохранены: ${JSON.stringify(msg)}`);
  a.match(msg, /перезагрузк/i, 'сообщение предупреждает о пропаже при перезагрузке');

  const rows = await app.rows();
  a.ok(rows.some((r) => r[1] === 'Переполнение'), 'запись осталась на экране');
  a.eq(money((await app.sums()).expense), 2888, 'запись учтена в итогах');

  const after = (await app.storage()).data;
  a.eq(after, before, `${STORAGE_KEY} не испорчен и новой записи не содержит`);
  a.eq(app.page.exceptions.length, 0, 'необработанных исключений нет');
});

// ————————————————————————————————————————————————————————————————
// Регресс
// ————————————————————————————————————————————————————————————————

test('ПР-R-05', 'Валидация суммы, категории и даты не изменилась', async ({ app }, a) => {
  await app.open(null);

  const today = await app.value('fDate');
  a.eq(await app.attr('fDate', 'max'), today, 'max у #fDate — сегодняшняя дата');

  await app.addRecord({ type: 'expense', amount: '100000000', category: 'Лимит' });
  a.match(await app.text('formError'), /99 999 999/, 'сумма сверх лимита отклонена сообщением');
  a.eq(await app.rowCount(), 0, 'запись не создана');
  a.eq(await app.value('fAmount'), '100000000', 'введённое не искажено молча');

  for (const bad of ['0', '-5', '12abc', '1e5', '1,2,3']) {
    await app.addRecord({ type: 'expense', amount: bad, category: 'Плохая сумма' });
    a.ok((await app.text('formError')).length > 0 && (await app.rowCount()) === 0,
      `сумма ${JSON.stringify(bad)} отклонена`);
  }

  await app.addRecord({ type: 'expense', amount: '10', category: 'ц'.repeat(33) });
  a.match(await app.text('formError'), /32/, 'категория длиннее 32 символов отклонена');
  a.eq(await app.prop('fCategory', 'maxLength'), -1, 'поле не обрезает введённое молча (maxlength не появился)');

  await app.addRecord({ type: 'expense', amount: '10', category: 'Будущее', date: '2027-01-01' });
  a.match(await app.text('formError'), /будущ/i, 'дата в будущем отклонена');
  a.eq(await app.rowCount(), 0, 'ни одна кривая запись не создалась');

  // Дату задаём явно: после отказа форма сохраняет введённое, и в поле
  // осталась забракованная дата из будущего.
  await app.addRecord({ type: 'expense', amount: '99999999', category: 'Предел', date: today });
  a.eq(await app.text('formError'), '', 'предельная сумма ошибок не вызвала');
  a.eq(await app.rowCount(), 1, 'предельная сумма 99999999 принята');
});

test('ПР-R-08', 'Импорт по-прежнему «всё или ничего»', async ({ app, brokenFile }, a) => {
  await app.open(F1);
  const before = await app.storage();

  app.page.dialogAnswer = true;
  await app.click('btnLoad');
  await app.setFileInput('#fileInput', [brokenFile]);
  await sleep(400);

  a.ok((await app.text('formError')).length > 0, `отказ показан: ${JSON.stringify(await app.text('formError'))}`);
  a.match(await app.text('formError'), /3/, 'в сообщении назван номер битой строки');
  a.eq(await app.rowCount(), 6, 'список не изменён');
  a.eq((await app.storage()).data, before.data, 'хранилище не тронуто');
});

test('ПР-R-09', 'Отказ в диалоге подтверждения ничего не меняет', async ({ app }, a) => {
  await app.open(F1);
  const before = await app.storage();

  await app.deleteRow(1, false);
  a.ok(app.page.dialogs.length > 0, 'подтверждение спрошено');
  a.eq(await app.rowCount(), 6, 'после отказа запись на месте');
  a.eq((await app.storage()).data, before.data, 'хранилище не тронуто');
});

test('ПР-R-10', 'Наружу ничего не ходит, консоль чистая', async ({ app }, a) => {
  await app.open(F1);
  await app.setFilter({ type: /Расход/i });
  await app.addRecord({ type: 'income', amount: '999', category: 'Премия', date: '2026-08-02' });
  await app.click('filtersRefresh');
  await app.click('tabExpense');
  await app.click('themeDark');
  await app.click('filtersReset');

  const external = app.page.requests.filter((u) => !u.startsWith(app.url.replace('/index.html', '')) && !u.startsWith('data:'));
  a.eq(external, [], `внешних запросов нет: всего ${app.page.requests.length}`);
  const own = app.page.requests.filter((u) => /\.(html|css|js)$/.test(u));
  a.eq(own.length, 3, `своих файлов ровно три: ${own.map((u) => u.split('/').pop()).join(', ')}`);

  const errors = app.page.console.filter((m) => m.type === 'error');
  a.eq(errors, [], 'в консоли нет сообщений уровня error');
  a.eq(app.page.exceptions, [], 'необработанных исключений нет');
});

test('ПР-R-13', 'Опорные id из тест-плана на месте', async ({ app }, a) => {
  await app.open(F1);
  const ids = [
    'sumIncome', 'sumExpense', 'sumBalance', 'addForm', 'fType', 'fAmount', 'fCategory',
    'fDate', 'fComment', 'catList', 'formError', 'filters', 'tabExpense', 'tabIncome',
    'donut', 'legend', 'chartEmpty', 'btnSave', 'btnLoad', 'fileInput', 'tbody', 'tableEmpty',
    'themeSwitch', 'themeAuto', 'themeLight', 'themeDark', 'storageAlert',
    'filtersToggle', 'filtersCount', 'filtersPanel', 'filterType', 'filterCategory',
    'filterFrom', 'filterTo', 'filtersReset', 'filtersError', 'filtersStale',
    'filtersRefresh', 'filtersClose',
  ];
  const missing = await app.page.eval(`const ids = ${JSON.stringify(ids)};
    return ids.filter((id) => !document.getElementById(id));`);
  a.eq(missing, [], `все ${ids.length} id из §1.5 TEST-PLAN.md присутствуют`);
});

async function waitForDownload(dir, re, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await readdir(dir).catch(() => []);
    const hit = files.find((f) => re.test(f) && !f.endsWith('.crdownload'));
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}
