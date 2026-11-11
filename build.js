#!/usr/bin/env node
'use strict';
/*
 * build.js —— 极简 CommonJS 打包器（无外部依赖）。
 *
 * Obsidian 只会加载插件目录下的 main.js；为了让插件零依赖、单文件分发，
 * 这里把 src/*.js 内联成一个自包含的 main.js。
 * 模块内部的相对 require('./xxx.js') 会被改写成本地的 __load，其余
 * require('obsidian' | 'fs' | 'path' | 'crypto') 仍走 Node 全局 require。
 *
 * 用法：node build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const ENTRY = 'main.js';
const OUT = path.join(ROOT, 'main.js');

function listModules() {
  return fs.readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

function normalizeId(base, name) {
  const joined = (base ? base + '/' : '') + name;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  let id = parts.join('/');
  if (!id.endsWith('.js')) id += '.js';
  return id;
}

function main() {
  const mods = listModules();
  if (!mods.includes(ENTRY)) {
    console.error(`缺少入口 ${ENTRY}`);
    process.exit(1);
  }

  const chunks = [];
  chunks.push(`/* eslint-disable */
/* LLM Wiki Ingest —— 单文件构建产物（由 build.js 从 src/ 生成，勿直接修改） */
/* 构建时间：${new Date().toISOString()} */

(function () {
  'use strict';
  var __defs = {};
  var __cache = {};

  function __define(id, fn) { __defs[id] = fn; }

  function __req(fromId, name) {
    if (name.charAt(0) !== '.') return require(name);
    var base = fromId.indexOf('/') === -1 ? '' : fromId.slice(0, fromId.lastIndexOf('/'));
    var id = normalize(base, name);
    return __load(id);
  }

  function normalize(base, name) {
    var joined = (base ? base + '/' : '') + name;
    var parts = joined.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    var id = out.join('/');
    if (id.slice(-3) !== '.js') id += '.js';
    return id;
  }

  function __load(id) {
    if (__cache[id]) return __cache[id].exports;
    if (!__defs[id]) throw new Error('模块未找到：' + id);
    var m = { exports: {} };
    __cache[id] = m;
    __defs[id](m, m.exports, function (name) { return __req(id, name); });
    return m.exports;
  }
`);

  for (const id of mods) {
    const code = fs.readFileSync(path.join(SRC, id), 'utf8');
    chunks.push(`\n  __define(${JSON.stringify(id)}, function (module, exports, require) {\n`);
    chunks.push(code);
    chunks.push('\n  });\n');
  }

  chunks.push(`
  module.exports = __load(${JSON.stringify(ENTRY)});
})();
`);

  fs.writeFileSync(OUT, chunks.join(''), 'utf8');
  const bytes = fs.statSync(OUT).size;
  console.log(`已生成 ${OUT}（${(bytes / 1024).toFixed(1)} KB，${mods.length} 个模块）`);
}

main();
