#!/usr/bin/env node
// Story Lab: check every run under runs/ and bundle them into viewer.html.
//   node story-lab/build.mjs                  -> story-lab/viewer.html
//   node story-lab/build.mjs --artifact FILE  -> also a wrapper-less copy for publishing
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNS = join(ROOT, 'runs');

// What the brief asks for at each level: [min, max].
const COUNTS = { premises: [10, 10], picks: [3, 3], cast: [5, 7], places: [5, 7],
  storylines: [3, 3], arcs: [5, 7], scenes: [6, 9], scenePicks: [2, 2], lines: [40, 80] };

let problems = [];
const say = (run, level, msg) => problems.push({ run, level, msg });

function readJson(run, path) {
  const file = join(RUNS, run, path);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { say(run, 'error', `${path}: not valid JSON (${e.message})`); return null; }
}

function checkList(run, path, list, key, idPrefix) {
  if (!Array.isArray(list)) { say(run, 'error', `${path}: "${key}" should be a list`); return []; }
  const [lo, hi] = COUNTS[key];
  if (list.length < lo || list.length > hi)
    say(run, 'warn', `${path}: ${list.length} ${key}, the brief asks for ${lo === hi ? lo : `${lo}-${hi}`}`);
  const seen = new Set();
  for (const item of list) {
    if (!item.id || !item.title && !item.name) say(run, 'error', `${path}: an entry in "${key}" has no id or title`);
    if (seen.has(item.id)) say(run, 'error', `${path}: id ${item.id} used twice`);
    if (idPrefix && item.id && !item.id.startsWith(idPrefix)) say(run, 'warn', `${path}: id ${item.id} should start with "${idPrefix}"`);
    seen.add(item.id);
  }
  return list;
}

function pickMap(run, path, picks, ids, key) {
  const map = {};
  for (const p of picks ? [].concat(picks) : []) {
    if (!ids.includes(p.id)) say(run, 'error', `${path}: pick ${p.id} is not one of the entries`);
    if (!p.why) say(run, 'warn', `${path}: pick ${p.id} has no reason`);
    map[p.id] = p.why || '';
  }
  if (key) {
    const n = Object.keys(map).length, [lo] = COUNTS[key];
    if (n !== lo) say(run, 'warn', `${path}: ${n} picked, the brief asks for ${lo}`);
  }
  return map;
}

function loadRun(run) {
  const meta = readJson(run, 'run.json') || {};
  if (!existsSync(join(RUNS, run, 'run.json'))) say(run, 'error', 'run.json is missing');
  const top = readJson(run, 'premises.json');
  if (!top) { say(run, 'error', 'premises.json is missing or unreadable'); return { id: run, ...meta, premises: [] }; }
  const premises = checkList(run, 'premises.json', top.premises, 'premises', 'p');
  const pPicks = pickMap(run, 'premises.json', top.picks, premises.map(p => p.id), 'picks');

  const out = premises.map(p => {
    const node = { kind: 'premise', ...p, pick: pPicks[p.id], children: [] };
    const world = readJson(run, `${p.id}/world.json`);
    if (world) {
      checkList(run, `${p.id}/world.json`, world.cast, 'cast');
      checkList(run, `${p.id}/world.json`, world.places, 'places');
      node.world = world;
    }
    const sl = readJson(run, `${p.id}/storylines.json`);
    if (p.id in pPicks && (!world || !sl)) say(run, 'warn', `${p.id} is picked but has no ${!world ? 'world.json' : 'storylines.json'}`);
    if (!sl) return node;
    const stories = checkList(run, `${p.id}/storylines.json`, sl.storylines, 'storylines', 's');
    const sPicks = pickMap(run, `${p.id}/storylines.json`, sl.pick, stories.map(s => s.id));
    node.children = stories.map(s => {
      const sNode = { kind: 'storyline', ...s, pick: sPicks[s.id], children: [] };
      const ar = readJson(run, `${p.id}/${s.id}/arcs.json`);
      if (s.id in sPicks && !ar) say(run, 'warn', `${p.id}/${s.id} is picked but has no arcs.json`);
      if (!ar) return sNode;
      const arcs = checkList(run, `${p.id}/${s.id}/arcs.json`, ar.arcs, 'arcs', 'a');
      const aPicks = pickMap(run, `${p.id}/${s.id}/arcs.json`, ar.pick, arcs.map(a => a.id));
      sNode.children = arcs.map(a => {
        const aNode = { kind: 'arc', ...a, pick: aPicks[a.id], children: [] };
        const base = `${p.id}/${s.id}/${a.id}`;
        const sc = readJson(run, `${base}/scenes.json`);
        if (a.id in aPicks && !sc) say(run, 'warn', `${base} is picked but has no scenes.json`);
        if (!sc) return aNode;
        const scenes = checkList(run, `${base}/scenes.json`, sc.scenes, 'scenes', 'sc');
        const scPicks = pickMap(run, `${base}/scenes.json`, sc.picks, scenes.map(x => x.id), 'scenePicks');
        aNode.children = scenes.map(x => {
          const xNode = { kind: 'scene', ...x, pick: scPicks[x.id], children: [] };
          const md = join(RUNS, run, base, `${x.id}.md`);
          if (existsSync(md)) {
            xNode.dialogue = readFileSync(md, 'utf8');
            const n = xNode.dialogue.split('\n').filter(l => l.trim()).length;
            if (n < COUNTS.lines[0] || n > COUNTS.lines[1] + 20)
              say(run, 'warn', `${base}/${x.id}.md: ${n} lines, the brief asks for ${COUNTS.lines.join('-')}`);
          } else if (x.id in scPicks) say(run, 'warn', `${base}/${x.id} is picked but has no ${x.id}.md`);
          return xNode;
        });
        return aNode;
      });
      return sNode;
    });
    return node;
  });
  return { id: run, label: meta.label || '', date: meta.date || '', brief_version: meta.brief_version ?? null,
    notes: meta.notes || '', premises: out };
}

const runIds = existsSync(RUNS)
  ? readdirSync(RUNS).filter(d => statSync(join(RUNS, d)).isDirectory()).sort() : [];
const runs = runIds.map(loadRun);

const count = (nodes, kind) => nodes.reduce((n, x) => n + (x.kind === kind ? 1 : 0) + count(x.children || [], kind), 0);
const lines = nodes => nodes.reduce((n, x) => n + (x.dialogue ? 1 : 0) + lines(x.children || []), 0);
for (const r of runs) {
  console.log(`${r.id}: ${r.premises.length} premises, ${r.premises.filter(p => p.world).length} worlds, ` +
    `${count(r.premises, 'storyline')} storylines, ${count(r.premises, 'arc')} arcs, ` +
    `${count(r.premises, 'scene')} scenes, ${lines(r.premises)} dialogues`);
  for (const p of problems.filter(x => x.run === r.id)) console.log(`  ${p.level === 'error' ? 'ERROR' : 'warn '}  ${p.msg}`);
}
if (!runs.length) console.log('No runs yet. See INSTRUCTIONS.md.');

const data = JSON.stringify({ built: new Date().toISOString().slice(0, 10), runs }).replace(/</g, '\\u003c');
const page = readFileSync(join(ROOT, 'viewer.template.html'), 'utf8').replace('/*__DATA__*/null', () => data);
writeFileSync(join(ROOT, 'viewer.html'),
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  '<style>body{margin:0}[hidden]{display:none!important}</style>\n</head><body>\n' + page + '\n</body></html>\n');
console.log('wrote story-lab/viewer.html');
const ai = process.argv.indexOf('--artifact');
if (ai > 0 && process.argv[ai + 1]) { writeFileSync(process.argv[ai + 1], page); console.log(`wrote ${process.argv[ai + 1]}`); }

const errors = problems.filter(p => p.level === 'error').length;
if (errors) { console.log(`${errors} error(s)`); process.exit(1); }
