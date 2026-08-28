'use strict';

var STORAGE_KEY = 'finance.csv';
/* Палитра диаграммы из DESIGN.md: семь сегментов, ни одного розового.
   Кобальт · хвоя · бирюза · охра · кирпич · индиго · олива, восьмым — серый
   «Дымка» под «прочее». Соседние цвета различаются и по тону, и по светлоте. */
var COLORS = ['#1E5AA8','#0F7A5C','#3E8EA8','#B08A2E','#B04527','#4A4A8C','#6B7A3A','#54708E'];

/* Правила из SPEC.md, часть А. Живут одной константой, чтобы форма и импорт
   проверяли данные ОДИНАКОВО: расхождение между этими путями и было причиной
   BUG-013, BUG-014, BUG-015. */
var MAX_AMOUNT = 99999999;      // пункт 3
var MAX_CATEGORY = 32;          // пункт 6
var CSV_HEADER = 'date,type,category,amount,comment';

/* Пункт 1: сумма — обычная запись числа и ничего кроме.
   Белый список вместо чёрного: parseFloat принимал '12abc', '1_000', '1e5', '.5', '007',
   и список таких входов открыт (R3 добавил к нему '12 руб' и '1,2,3' уже после прогона). */
var AMOUNT_RE = /^(0|[1-9]\d*)([.,]\d+)?$/;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

var transactions = [];   // {date:'YYYY-MM-DD', type:'income'|'expense', category, amount, comment}
var chartMode = 'expense';

/* ---------- CSV ---------- */

function csvEscape(value) {
  var s = String(value == null ? '' : value);
  if (/[",;\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(list) {
  var lines = [CSV_HEADER];
  list.forEach(function (t) {
    lines.push([t.date, t.type, csvEscape(t.category), t.amount.toFixed(2), csvEscape(t.comment)].join(','));
  });
  return lines.join('\n');
}

// Разбор строки CSV с учётом кавычек и переводов строк внутри полей.
function parseCSV(text) {
  var rows = [], row = [], field = '', inQuotes = false, i = 0;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/* ---------- проверки, общие для формы и импорта ---------- */

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* Пункты 1, 2, 3. Возвращает {ok, value} либо {ok:false, error}. */
function checkAmount(raw) {
  var s = String(raw == null ? '' : raw).trim().replace(/\s/g, '');
  if (!s) return { ok: false, error: 'Введите сумму больше нуля.' };
  if (!AMOUNT_RE.test(s)) {
    return { ok: false, error: 'Сумма записывается цифрами, например 1200 или 1200.50.' };
  }
  var value = parseFloat(s.replace(',', '.'));
  if (!isFinite(value)) return { ok: false, error: 'Введите сумму больше нуля.' };
  // Пункт 2: округление до копеек. Пункт 1: после округления сумма обязана остаться
  // больше нуля — иначе '0.001' создавал запись на 0,00 ₽ (BUG-012).
  var rounded = Math.round(value * 100) / 100;
  if (rounded <= 0) return { ok: false, error: 'Введите сумму больше нуля.' };
  if (rounded > MAX_AMOUNT) {
    return { ok: false, error: 'Сумма не может превышать 99 999 999.' };
  }
  return { ok: true, value: rounded };
}

/* Пункты 5 и 6. Пробелы по краям срезаются (пункт 4). */
function checkCategory(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'Укажите категорию.' };
  if (s.length > MAX_CATEGORY) {
    return { ok: false, error: 'Категория не длиннее ' + MAX_CATEGORY + ' символов.' };
  }
  return { ok: true, value: s };
}

/* Пункты 7 и 8. Дата обязательна, реальна и не в будущем. */
function checkDate(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'Укажите дату.' };
  if (!DATE_RE.test(s)) return { ok: false, error: 'Дата указывается в виде ГГГГ-ММ-ДД.' };
  var parts = s.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var real = d.getFullYear() === Number(parts[0])
    && d.getMonth() === Number(parts[1]) - 1
    && d.getDate() === Number(parts[2]);
  if (!real) return { ok: false, error: 'Такой даты не существует.' };
  if (s > todayISO()) return { ok: false, error: 'Дата не может быть в будущем.' };
  return { ok: true, value: s };
}

function checkType(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s !== 'income' && s !== 'expense') {
    return { ok: false, error: 'Тип записи бывает только income или expense.' };
  }
  return { ok: true, value: s };
}

/* Пункт 4: «Кафе», «кафе» и « кафе » — одна категория.
   Написание берётся у той записи, что появилась первой. */
function categoryKey(name) {
  return String(name).trim().toLowerCase();
}

function canonicalCategory(name, list) {
  var key = categoryKey(name);
  for (var i = 0; i < list.length; i++) {
    if (categoryKey(list[i].category) === key) return list[i].category;
  }
  return String(name).trim();
}

/* ---------- разбор файла ---------- */

/* Возвращает {ok:true, list} либо {ok:false, error} и НИЧЕГО не меняет.
   Порядок «сначала разобрать всё, потом применить» — это и есть запрет частичной
   загрузки из пункта 11: список заменяется только целиком и только из проверенного
   набора. Раньше битые строки молча выбрасывались (R1), а нечитаемый файл
   обнулял историю (BUG-002). */
function parseTransactions(text) {
  var rows = parseCSV(String(text == null ? '' : text));
  if (!rows.length) return { ok: false, error: 'файл пуст' };

  var header = rows[0].map(function (c) { return String(c).trim().toLowerCase(); });
  if (header[0] !== 'date' || header.length < 5) {
    return { ok: false, error: 'первая строка не похожа на заголовок «' + CSV_HEADER + '»' };
  }

  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    // Полностью пустая строка в конце файла — не ошибка, это перевод строки.
    if (r.length === 1 && String(r[0]).trim() === '') continue;

    var where = 'строка ' + (i + 1) + ': ';
    if (r.length < 5) return { ok: false, error: where + 'ожидалось 5 столбцов, получено ' + r.length };

    var date = checkDate(r[0]);
    if (!date.ok) return { ok: false, error: where + date.error.toLowerCase() };
    var type = checkType(r[1]);
    if (!type.ok) return { ok: false, error: where + type.error.toLowerCase() };
    var category = checkCategory(r[2]);
    if (!category.ok) return { ok: false, error: where + category.error.toLowerCase() };
    var amount = checkAmount(r[3]);
    if (!amount.ok) return { ok: false, error: where + amount.error.toLowerCase() };

    list.push({
      date: date.value,
      type: type.value,
      category: canonicalCategory(category.value, list),
      amount: amount.value,
      comment: r[4] == null ? '' : String(r[4])
    });
  }
  return { ok: true, list: list };
}

/* ---------- хранение ---------- */

function save() {
  try { localStorage.setItem(STORAGE_KEY, toCSV(transactions)); } catch (e) { /* приватный режим */ }
}

function load() {
  var text;
  try { text = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
  if (!text) return;
  var parsed = parseTransactions(text);
  // Испорченное хранилище не перезаписывается: список остаётся пустым, но данные
  // в localStorage целы, и их ещё можно достать руками.
  if (parsed.ok) transactions = parsed.list;
}

/* ---------- формат ---------- */

function money(value) {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}

function humanDate(iso) {
  var parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

function showError(message) {
  document.getElementById('formError').textContent = message;
}

/* ---------- шов фильтрации ---------- */

/* ЕДИНСТВЕННАЯ точка, через которую отрисовка и выгрузка берут список записей.
   Заведена ДО фильтрации, чтобы ветка feature/filters меняла одну функцию,
   а не четыре места в трёх чужих зонах.

   purpose — зачем список спрашивают. Значения: 'table' (таблица),
   'stats' (итоги и диаграмма), 'export' (выгрузка CSV). Разделены потому, что
   по SPEC они РАСХОДЯТСЯ: при устаревшем результате фильтрации посторонняя
   запись видна в таблице, но в итоги и диаграмму не входит.

   Владелец функции — feature/filters. Другие ветки её не трогают.

   'stats' — ВСЕГДА строгий результат фильтра, даже когда таблица заморожена.
   'table' — замороженный снимок, пока плашка «устарел» имеет силу.
   'export' — то же, что таблица: «в файле ровно то, что на экране» (SPEC, Сц-9). */
function listFor(purpose) {
  // Функция вызывается на старте, до кода зоны filters: переменные объявлены,
  // но ещё не инициализированы — тогда фильтра нет и список полный.
  if (!filterState) return transactions;
  if (purpose === 'stats') return filterApply(transactions);
  if (filterFrozenList) return filterFrozenList;
  return filterApply(transactions);
}

/* ---------- отрисовка ---------- */

function renderTotals() {
  var income = 0, expense = 0;
  listFor('stats').forEach(function (t) {
    if (t.type === 'income') income += t.amount; else expense += t.amount;
  });
  var balance = income - expense;
  document.getElementById('sumIncome').textContent = money(income);
  document.getElementById('sumExpense').textContent = money(expense);
  var balanceEl = document.getElementById('sumBalance');
  balanceEl.textContent = money(balance);
  balanceEl.className = 'value' + (balance < 0 ? ' neg' : '');
}

function groupByCategory(type) {
  var map = {}, order = [];
  listFor('stats').forEach(function (t) {
    if (t.type !== type) return;
    var key = categoryKey(t.category);
    if (!map[key]) { map[key] = { name: t.category, sum: 0 }; order.push(key); }
    map[key].sum += t.amount;
  });
  return order
    .map(function (key) { return map[key]; })
    .sort(function (a, b) { return b.sum - a.sum; });
}

function renderChart() {
  var svg = document.getElementById('donut');
  var legend = document.getElementById('legend');
  var empty = document.getElementById('chartEmpty');
  var groups = groupByCategory(chartMode);
  var total = groups.reduce(function (acc, g) { return acc + g.sum; }, 0);

  svg.innerHTML = '';
  legend.innerHTML = '';

  if (total <= 0) {
    empty.hidden = false;
    svg.style.display = 'none';
    return;
  }
  empty.hidden = true;
  svg.style.display = '';

  var NS = 'http://www.w3.org/2000/svg';
  var radius = 70, stroke = 34;
  var circumference = 2 * Math.PI * radius, offset = 0;

  groups.forEach(function (g, i) {
    var color = COLORS[i % COLORS.length];
    var length = (g.sum / total) * circumference;

    var arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', '100');
    arc.setAttribute('cy', '100');
    arc.setAttribute('r', String(radius));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', color);
    arc.setAttribute('stroke-width', String(stroke));
    arc.setAttribute('stroke-dasharray', length + ' ' + (circumference - length));
    arc.setAttribute('stroke-dashoffset', String(-offset));
    arc.setAttribute('transform', 'rotate(-90 100 100)');
    svg.appendChild(arc);
    offset += length;

    var li = document.createElement('li');
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = g.name;
    name.title = g.name;
    var sum = document.createElement('span');
    sum.className = 'sum';
    sum.textContent = money(g.sum);
    var pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = Math.round((g.sum / total) * 100) + '%';
    li.append(dot, name, sum, pct);
    legend.appendChild(li);
  });

  var label = document.createElementNS(NS, 'text');
  label.setAttribute('x', '100');
  label.setAttribute('y', '105');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('font-size', '15');
  label.setAttribute('fill', '#1c1e21');
  label.textContent = money(total);
  svg.appendChild(label);
  fitLabelInsideHole(label, radius, stroke);
}

/* R4: подпись стоит в ОТВЕРСТИИ кольца, а не на кольце, поэтому мерить её надо
   против внутреннего диаметра (2×70 − 34 = 106), а не против внешних 200 px.
   Сначала уменьшается кегль, и только если этого мало — сжимается сама надпись. */
function fitLabelInsideHole(label, radius, stroke) {
  var maxWidth = 2 * radius - stroke - 10;   // 96 px: отверстие минус поля
  var width;
  try { width = label.getBBox().width; } catch (e) { return; }
  if (!width || width <= maxWidth) return;

  var size = Math.max(8, Math.floor(15 * maxWidth / width));
  label.setAttribute('font-size', String(size));
  if (label.getBBox().width > maxWidth) {
    label.setAttribute('textLength', String(maxWidth));
    label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  }
}

function renderTable() {
  var tbody = document.getElementById('tbody');
  var empty = document.getElementById('tableEmpty');
  var rows = listFor('table');
  tbody.innerHTML = '';

  /* ЗОНА filters — пустое состояние. По SPEC «записей пока нет» и «под фильтр
     ничего не подошло» это РАЗНЫЕ состояния с разным текстом (Сц-4).
     Развести их — задача feature/filters; больше сюда никто не пишет. */
  if (rows.length === 0) {
    empty.hidden = false;
    filterFillEmptyState(empty);
    return;
  }
  empty.hidden = true;

  var sorted = rows.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });

  sorted.forEach(function (t) {
    var tr = document.createElement('tr');

    var tdDate = document.createElement('td');
    tdDate.className = 'date';
    tdDate.textContent = humanDate(t.date);

    var tdCat = document.createElement('td');
    tdCat.className = 'category';
    tdCat.textContent = t.category;

    var tdComment = document.createElement('td');
    tdComment.className = 'comment';
    tdComment.textContent = t.comment;

    var tdAmount = document.createElement('td');
    tdAmount.className = 'amount ' + t.type;
    tdAmount.textContent = (t.type === 'income' ? '+' : '−') + ' ' + money(t.amount);

    var tdDel = document.createElement('td');
    tdDel.className = 'del-col';
    var del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Удалить запись';
    del.setAttribute('aria-label', 'Удалить запись ' + t.category + ' от ' + humanDate(t.date));
    del.addEventListener('click', function () {
      // BUG-003: удаление необратимо, поэтому спрашивается подтверждение (пункт 13).
      var question = 'Удалить запись «' + t.category + '» от ' + humanDate(t.date)
        + ' на ' + money(t.amount) + '?\n\nОтменить удаление будет нельзя.';
      if (!window.confirm(question)) return;
      var index = transactions.indexOf(t);
      if (index !== -1) transactions.splice(index, 1);
      save();
      renderAll();
    });
    tdDel.appendChild(del);

    tr.append(tdDate, tdCat, tdComment, tdAmount, tdDel);
    tbody.appendChild(tr);
  });
}

function renderCategories() {
  var list = document.getElementById('catList');
  var seen = {};
  list.innerHTML = '';
  transactions.forEach(function (t) {
    var key = categoryKey(t.category);
    if (seen[key]) return;
    seen[key] = true;
    var option = document.createElement('option');
    option.value = t.category;
    list.appendChild(option);
  });
}

function renderAll() {
  renderTotals();
  renderChart();
  renderTable();
  renderCategories();
}

/* ---------- события ---------- */

document.getElementById('addForm').addEventListener('submit', function (e) {
  e.preventDefault();

  var amount = checkAmount(document.getElementById('fAmount').value);
  if (!amount.ok) { showError(amount.error); document.getElementById('fAmount').focus(); return; }

  var category = checkCategory(document.getElementById('fCategory').value);
  if (!category.ok) { showError(category.error); document.getElementById('fCategory').focus(); return; }

  var date = checkDate(document.getElementById('fDate').value);
  if (!date.ok) { showError(date.error); document.getElementById('fDate').focus(); return; }

  var type = checkType(document.getElementById('fType').value);
  if (!type.ok) { showError(type.error); document.getElementById('fType').focus(); return; }

  showError('');

  transactions.push({
    date: date.value,
    type: type.value,
    category: canonicalCategory(category.value, transactions),
    amount: amount.value,
    comment: document.getElementById('fComment').value.trim()
  });
  save();
  renderAll();

  document.getElementById('fAmount').value = '';
  document.getElementById('fCategory').value = '';
  document.getElementById('fComment').value = '';
  document.getElementById('fAmount').focus();
});

document.getElementById('tabExpense').addEventListener('click', function () { setChartMode('expense'); });
document.getElementById('tabIncome').addEventListener('click', function () { setChartMode('income'); });

function setChartMode(mode) {
  // ЗОНА filters: фильтр по типу навязывает режим и гасит вторую вкладку (SPEC, Сц-2).
  chartMode = filterForceChartMode(mode);
  document.getElementById('tabExpense').setAttribute('aria-pressed', String(chartMode === 'expense'));
  document.getElementById('tabIncome').setAttribute('aria-pressed', String(chartMode === 'income'));
  filterUpdateChartTabs();
  renderChart();
}

document.getElementById('btnSave').addEventListener('click', function () {
  // При активном фильтре выгружается отфильтрованный список — решение человека, SPEC Сц-9.
  var blob = new Blob(['﻿' + toCSV(listFor('export'))], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'transactions.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});

document.getElementById('btnLoad').addEventListener('click', function () {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', function (e) {
  var file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  var reader = new FileReader();
  reader.onerror = function () {
    showError('Файл не загружен: не удалось его прочитать. Список записей не изменён.');
  };
  reader.onload = function () {
    var parsed = parseTransactions(String(reader.result));

    // BUG-002 и R1: файл, который не разобрался целиком, не применяется вообще.
    if (!parsed.ok) {
      showError('Файл не загружен: ' + parsed.error + '. Список записей не изменён.');
      return;
    }

    // BUG-001: замена списка — потеря данных, поэтому только после подтверждения (пункт 10).
    var question = 'Загрузка заменит все записи в приложении ('
      + transactions.length + ' шт.) на записи из файла (' + parsed.list.length + ' шт.).'
      + '\n\nПродолжить?';
    if (!window.confirm(question)) {
      showError('Загрузка отменена. Список записей не изменён.');
      return;
    }

    transactions = parsed.list;
    filterReset();          // ЗОНА filters: загрузка CSV сбрасывает фильтр (SPEC, Сц-10)
    showError('');
    save();
    renderAll();
  };
  reader.readAsText(file, 'utf-8');
});

/* ---------- старт ---------- */

document.getElementById('fDate').value = todayISO();
document.getElementById('fDate').max = todayISO();   // BUG-005: будущее недоступно и в календаре
load();
renderAll();

/* ============================================================================
   ЗОНЫ ПАРАЛЛЕЛЬНОЙ РАБОТЫ. Всё, что ВЫШЕ этой черты, — общий код: он правится
   только в перечисленных ниже точках и только названным владельцем. Ниже —
   по блоку на ветку; каждая пишет только в свой блок.

   Точечные исключения выше черты, согласованные заранее:
     feature/filters  — тело listFor(), пустое состояние в renderTable(),
                        гашение вкладки в setChartMode(), сброс фильтра
                        при загрузке CSV;
     feature/storage  — тело save();
     feature/design   — константа COLORS (палитра диаграммы), и только она;
     feature/theme    — ничего выше черты; тема живёт в своём блоке и в CSS.
   ============================================================================ */

/* ===== ЗОНА filters. Владелец — feature/filters.
   Состояние фильтра, чтение панели, счётчик, плашка «устарел». ===== */

/* Фильтров ровно три: тип, категория, период «с»/«по» (решение человека, SPEC п.1).
   Фильтр живёт только в памяти: перезагрузка страницы возвращает полный список
   (SPEC, Сц-11) — поэтому ни localStorage, ни URL здесь не участвуют. */
var filterState = { type: 'all', category: '', from: '', to: '' };

/* Замороженный список таблицы. Не null — значит показанный список расходится
   со строгим результатом фильтра (SPEC, «устаревание результата»).
   Итоги и диаграмма его не видят: listFor('stats') всегда считает строго. */
var filterFrozenList = null;
var filterStaleShown = false;                    // видна ли сама плашка
var filterPrevTransactions = transactions.slice();  // снимок для поиска добавленных/удалённых

function filterEl(id) { return document.getElementById(id); }

/* Канон категорий — тот же, что во всём приложении: регистр и пробелы не различаются. */
function filterMatches(t) {
  if (filterState.type !== 'all' && t.type !== filterState.type) return false;
  if (filterState.category && categoryKey(t.category) !== filterState.category) return false;
  // Даты в ISO: строковое сравнение = хронологическое. Границы включаются,
  // пустая граница = открытый интервал с этой стороны.
  if (filterState.from && t.date < filterState.from) return false;
  if (filterState.to && t.date > filterState.to) return false;
  return true;
}

function filterApply(list) {
  if (filterCount() === 0) return list;
  return list.filter(filterMatches);
}

/* Счётчик на кнопке: тип ≠ «все», выбранная категория и каждая заполненная граница. */
function filterCount() {
  var n = 0;
  if (filterState.type !== 'all') n++;
  if (filterState.category) n++;
  if (filterState.from) n++;
  if (filterState.to) n++;
  return n;
}

function filterDropStale() {
  filterFrozenList = null;
  filterStaleShown = false;
}

/* ---------- диаграмма под фильтром по типу ---------- */

function filterForceChartMode(mode) {
  if (filterState && filterState.type !== 'all') return filterState.type;
  return mode;
}

/* Вторая вкладка не исчезает, а гаснет: исчезающий элемент дезориентирует сильнее. */
function filterUpdateChartTabs() {
  if (!filterState) return;
  filterEl('tabExpense').disabled = filterState.type === 'income';
  filterEl('tabIncome').disabled = filterState.type === 'expense';
}

/* ---------- пустое состояние таблицы ---------- */

/* «Записей пока нет» и «под фильтр ничего не подошло» — разные состояния (SPEC, Сц-4). */
function filterFillEmptyState(el) {
  el.textContent = '';
  if (!filterState || filterCount() === 0 || transactions.length === 0) {
    el.textContent = 'Записей пока нет.';
    return;
  }
  var text = document.createElement('span');
  text.textContent = 'Под выбранный фильтр не подошла ни одна запись.';
  var back = document.createElement('button');
  back.type = 'button';
  back.className = 'secondary filters-back';
  back.textContent = 'Показать все записи';
  back.addEventListener('click', function () { filterReset(); renderAll(); });
  el.append(text, document.createElement('br'), back);
}

/* ---------- учёт добавленных и удалённых записей ---------- */

/* Вызывается перед каждой отрисовкой. Сравнивает список со снимком: так добавление
   и удаление ловятся, не трогая чужой код формы и кнопки удаления. */
function filterSyncChanges() {
  var current = transactions;
  var prev = filterPrevTransactions;
  var added = current.filter(function (t) { return prev.indexOf(t) === -1; });
  var removed = prev.filter(function (t) { return current.indexOf(t) === -1; });
  filterPrevTransactions = current.slice();

  if (filterCount() === 0) { filterDropStale(); return; }
  if (!added.length && !removed.length) return;

  // Что сейчас показано в таблице, за вычетом удалённых записей.
  var shown = (filterFrozenList || filterApply(prev)).filter(function (t) {
    return current.indexOf(t) !== -1;
  });

  var stray = added.filter(function (t) { return !filterMatches(t); });

  if (filterFrozenList) {
    // Список уже заморожен — новые записи встают сверху, подходят они или нет.
    filterFrozenList = added.concat(shown);
  } else if (stray.length) {
    // Запись не подходит под фильтр, но обязана быть видна — самой верхней строкой.
    filterFrozenList = added.concat(shown);
  }

  // Плашка: посторонняя запись (Сц-5) или удаление при активном фильтре (Сц-8).
  if (stray.length || removed.length) filterStaleShown = true;
}

/* ---------- панель ---------- */

function filterRenderCategories() {
  var select = filterEl('filterCategory');
  var seen = {};
  var chosen = filterState.category;
  select.innerHTML = '';
  var all = document.createElement('option');
  all.value = '';
  all.textContent = 'Все категории';
  select.appendChild(all);
  transactions.forEach(function (t) {
    var key = categoryKey(t.category);
    if (seen[key]) return;
    seen[key] = true;
    var option = document.createElement('option');
    option.value = key;
    option.textContent = t.category;
    select.appendChild(option);
  });
  // Выбранной категории может уже не быть ни в одной записи — вариант сохраняется,
  // иначе фильтр молча слетел бы, а список молча вырос.
  if (chosen && !seen[chosen]) {
    var kept = document.createElement('option');
    kept.value = chosen;
    kept.textContent = chosen;
    select.appendChild(kept);
  }
  select.value = chosen;
}

function filterRenderPanel() {
  var count = filterCount();
  var badge = filterEl('filtersCount');
  badge.textContent = String(count);
  badge.hidden = count === 0;
  filterEl('filtersToggle').setAttribute('aria-label',
    count === 0 ? 'Фильтры' : 'Фильтры, активных: ' + count);

  filterEl('filterType').value = filterState.type;
  filterEl('filterFrom').value = filterState.from;
  filterEl('filterTo').value = filterState.to;
  filterRenderCategories();

  filterEl('filtersStale').hidden = !filterStaleShown;
  filterUpdateChartTabs();
}

function filterShowError(message) {
  filterEl('filtersError').textContent = message || '';
}

/* Читает панель и применяет. Период задом наперёд — ошибка, список не меняется. */
function filterApplyFromPanel() {
  var from = filterEl('filterFrom').value;
  var to = filterEl('filterTo').value;
  if (from && to && from > to) {
    filterShowError('Дата «с» позже даты «по» — период пуст. Список не изменён.');
    return;
  }
  filterShowError('');
  filterState = {
    type: filterEl('filterType').value,
    category: filterEl('filterCategory').value,
    from: from,
    to: to
  };
  filterDropStale();
  setChartMode(chartMode);   // вернёт или навяжет режим и погасит вкладку
  renderAll();
}

function filterReset() {
  filterState = { type: 'all', category: '', from: '', to: '' };
  filterDropStale();
  filterShowError('');
  setChartMode(chartMode);
}

/* ---------- события панели ---------- */

filterEl('filtersToggle').addEventListener('click', function () {
  var panel = filterEl('filtersPanel');
  var open = panel.hidden;
  panel.hidden = !open;
  this.setAttribute('aria-expanded', String(open));
});

['filterType', 'filterCategory', 'filterFrom', 'filterTo'].forEach(function (id) {
  filterEl(id).addEventListener('change', filterApplyFromPanel);
});

filterEl('filtersReset').addEventListener('click', function () {
  filterReset();
  renderAll();
});

// «Обновить» — пересобрать список по фильтру; посторонняя запись уходит.
filterEl('filtersRefresh').addEventListener('click', function () {
  filterDropStale();
  renderAll();
});

// Крестик закрывает только плашку: список остаётся прежним (решение человека).
filterEl('filtersClose').addEventListener('click', function () {
  filterStaleShown = false;
  filterRenderPanel();
});

/* ---------- посторонняя запись — самой верхней строкой ---------- */

/* renderTable() сортирует строки по дате (новые сверху), и это не зона фильтра.
   Но по SPEC посторонняя запись обязана стоять ПЕРВОЙ строкой независимо от даты
   (Сц-5): добавили расход задним числом при фильтре «доходы» — он всё равно сверху.
   Поэтому фильтр не трогает сортировку, а после отрисовки переставляет свои строки
   в своей же зоне. Порядок строк восстанавливается по тому же сравнению, что
   и в renderTable(), — единственная связь с чужим кодом, и она только на чтение. */
function filterLiftStrayRows() {
  if (!filterFrozenList) return;
  var stray = filterFrozenList.filter(function (t) { return !filterMatches(t); });
  if (!stray.length) return;

  var tbody = document.getElementById('tbody');
  var trs = [].slice.call(tbody.children);
  var sorted = filterFrozenList.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  if (trs.length !== sorted.length) return;   // разметку сменили — молча не ломаем

  // Идём с конца, вставляя каждую строку в начало: взаимный порядок сохраняется.
  for (var i = stray.length - 1; i >= 0; i--) {
    var pos = sorted.indexOf(stray[i]);
    if (pos !== -1) tbody.insertBefore(trs[pos], tbody.firstChild);
  }
}

/* ---------- включение в общий цикл отрисовки ---------- */

/* renderAll лежит выше черты и чужой правке не подлежит, поэтому фильтр
   оборачивает её здесь, в своей зоне: сначала учесть добавленное и удалённое,
   потом отрисовать, потом обновить панель. */
var filterBaseRenderAll = renderAll;
renderAll = function () {
  filterSyncChanges();
  filterBaseRenderAll();
  filterLiftStrayRows();
  filterRenderPanel();
};

renderAll();

/* ===== /ЗОНА filters ===== */

/* ===== ЗОНА theme. Владелец — feature/theme.
   Три состояния переключателя, отдельный ключ localStorage (НЕ finance.csv),
   подписка на смену системной темы. ===== */

/* ===== /ЗОНА theme ===== */

/* ===== ЗОНА storage. Владелец — feature/storage.
   Показ и скрытие сообщения о том, что запись не сохранена. ===== */

/* ===== /ЗОНА storage ===== */
