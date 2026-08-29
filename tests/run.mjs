#!/usr/bin/env node
// Раннер смоук-набора.
//
//   node tests/run.mjs                     — поднять стенд, прогнать всё
//   node tests/run.mjs --headed            — с видимым окном браузера
//   node tests/run.mjs --base-url=http://127.0.0.1:8080   — на уже поднятом стенде
//   node tests/run.mjs --only=ПР-F         — прогнать подмножество
//
// Стенд проверяется по ответу, а не по факту запуска команды, и порт
// не подбирается молча: занят — падаем с объяснением (AGENTS.md).

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Browser, sleep } from './lib/cdp.mjs';
import { App, F1 } from './lib/app.mjs';
import { runAll, summary, listTests } from './lib/runner.mjs';
import './smoke.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..', 'app');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PORT = Number(flag('port', '8086'));
const EXTERNAL_URL = flag('base-url');
const HEADLESS = !has('headed');
const ONLY = flag('only') ? flag('only').split(',') : null;

async function alive(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/index.html`, { cache: 'no-store' });
    return res.ok;
  } catch { return false; }
}

async function startStand(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (await alive(baseUrl)) {
    throw new Error(
      `Порт ${port} уже занят чем-то, что отвечает по HTTP. Соседний порт не подбирается молча:\n` +
      `остановите стенд или укажите --base-url=${baseUrl}, если это он и есть.`);
  }
  const proc = spawn('py', ['-m', 'http.server', String(port), '--directory', APP_DIR, '--bind', '127.0.0.1'],
    { stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await alive(baseUrl)) return { baseUrl, stop: () => proc.kill() };
    await sleep(200);
  }
  proc.kill();
  throw new Error(`Стенд на ${baseUrl} не ответил за 15 с. Проверьте, что работает «py -m http.server».`);
}

async function main() {
  let stand = null;
  let baseUrl = EXTERNAL_URL;

  if (baseUrl) {
    if (!(await alive(baseUrl))) throw new Error(`Стенд ${baseUrl}/index.html не отвечает.`);
    console.log(`Стенд: ${baseUrl} (внешний, поднят не нами)`);
  } else {
    stand = await startStand(PORT);
    baseUrl = stand.baseUrl;
    console.log(`Стенд: ${baseUrl} (поднят раннером, будет остановлен по окончании)`);
  }

  const work = await mkdtemp(join(tmpdir(), 'finance-smoke-'));
  const downloadsRoot = join(work, 'downloads');
  await mkdir(downloadsRoot, { recursive: true });
  const fixtureFile = join(work, 'f1.csv');
  await writeFile(fixtureFile, '﻿' + F1, 'utf8');
  const brokenFile = join(work, 'broken.csv');
  await writeFile(brokenFile, [
    'date,type,category,amount,comment',
    '2026-08-01,expense,Продукты,1000.00,первая',
    'это-не-дата,expense,Кафе,неЧисло,битая третья строка',
    '2026-08-05,income,Зарплата,50000.00,четвёртая',
  ].join('\n'), 'utf8');

  const browser = await Browser.launch({ headless: HEADLESS });
  console.log(`Браузер: ${browser.version}`);
  console.log(`Node: ${process.version}`);
  console.log(`Проверок в наборе: ${listTests().length}${ONLY ? ` (фильтр: ${ONLY.join(', ')})` : ''}`);
  console.log('');

  const pages = [];
  let n = 0;
  const makeContext = async () => {
    const page = await browser.newPage();
    pages.push(page);
    const downloads = join(downloadsRoot, String(n++));
    await mkdir(downloads, { recursive: true });
    return { app: new App(page, baseUrl), page, downloads, fixtureFile, brokenFile };
  };

  let ok = false;
  try {
    const results = await runAll(makeContext, { only: ONLY });
    ok = summary(results);
  } finally {
    for (const p of pages) await p.close();
    await browser.close();
    if (stand) stand.stop();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('Прогон не состоялся:', e.message);
  process.exit(2);
});
