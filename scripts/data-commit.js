#!/usr/bin/env node
/**
 * scripts/data-commit.js —— ui/data 翻译数据变更 → 提交信息生成 + 交互式提交推送
 *
 * 背景：每次维护 ui/data 下的翻译 CSV 后，需要对比 Git 历史生成固定格式的
 * 变更记录并提交。本脚本把整套流程固化为静态脚本，无需 AI 介入。
 *
 * 用法：
 *   node scripts/data-commit.js              # 无参数=交互模式（见下方流程）
 *   node scripts/data-commit.js --dry-run    # 只打印变更记录，不提交不推送
 *   node scripts/data-commit.js --no-push    # 交互确认提交，但不询问/不推送
 *   npm run data-commit                      # 等价于无参数
 *
 * 无参数（交互模式）流程：
 *   1. 对比 HEAD 生成变更记录并打印到控制台
 *   2. 询问「是否生成变更记录并提交？」——选 n 直接退出，不提交不推送
 *   3. 选 y → 只提交 ui/data 下的变更（不影响暂存区里的其他文件）
 *   4. 提交完成后询问「是否推送更新？」——选 n 只提交不推送
 *
 * 作用范围：只处理 ui/data 里的内容变更。暂存与提交均限定 ui/data 路径，
 * 用户暂存的其他文件（代码等）不会被纳入本脚本的提交，可分批次自行提交。
 *
 * 变更记录格式（与历史提交保持一致）：
 *   [游戏翻译数据更新维护]
 *   affixName.csv，增加 灰色词条0条，绿色词条0条，蓝色词条0条，传奇词条10条，其他词条14条，修改 其他词条1条
 *   itemDataRow.csv，增加 灰色装备8条，绿色装备6条，蓝色装备12条，传奇装备8条，其他装备1条，修改 其他装备1条
 *   autoColor.csv，自动颜色规则，变更记录3条
 *   param.csv，游戏通用属性，增加5条
 *
 * 判定规则（与 ui/server.js / ui/index.html 的解析逻辑保持一致）：
 *   - 翻译 CSV：注释行（# 开头）与空行不计；条目按首列 key 比对新增/修改/删除
 *   - affixName.csv / itemDataRow.csv：按翻译文字里的 [传奇]/[蓝]/[绿]/[灰] 标签分级，
 *     无标签归「其他」；同时含多个标签时取优先级高的（传奇>蓝>绿>灰）
 *   - .autoColor.csv：首列是合法颜色（#hex 或 13 个命名色）的行才是规则，
 *     按正则文本比对颜色变更；「变更记录N条」= 新增+修改+删除的规则数
 *   - 其余 CSV（param.csv、traitName.csv 等）：用文件头 `# name:` 作中文标签，
 *     只统计条目总数的新增/修改/删除
 *   - autoColor.csv → .autoColor.csv 这类重命名按内容相同识别，规则未变则记 0 条
 *   - 条目零变更且非重命名的文件不出现在提交信息里
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = "ui/data";
const TITLE = "[游戏翻译数据更新维护]";

/* ---------------- CLI 参数 ---------------- */
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const noPush = argv.includes("--no-push");
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(
    [
      "用法：node scripts/data-commit.js [选项]",
      "  （无参数）  交互模式：打印变更记录 → 询问是否提交 → 提交后询问是否推送",
      "  --dry-run  只打印变更记录，不提交不推送，不询问",
      "  --no-push  询问是否提交；提交后不询问也不推送",
      "作用范围：只提交 ui/data 下的变更，暂存区里的其他文件不受影响。",
    ].join("\n")
  );
  process.exit(0);
}

/* ---------------- git 封装 ---------------- */
/* 参数逐个加双引号：兼容路径含空格（Git Bash / cmd 均可） */
function git(args, inherit) {
  const cmd = ["git"].concat(args).map((a) => '"' + String(a) + '"').join(" ");
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}
function gitOut(args) {
  try {
    return git(args);
  } catch (_) {
    return null;
  }
}

/* ---------------- CSV 解析 ---------------- */
function stripBom(s) {
  return String(s == null ? "" : s).replace(/^\uFEFF/, "");
}
function normalize(text) {
  return stripBom(text).replace(/\r\n/g, "\n");
}

/* 翻译 CSV → Map<key, 整行>；注释行与空行跳过 */
function parseTranslationCsv(text) {
  const map = new Map();
  for (const raw of normalize(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const ci = line.indexOf(",");
    const key = (ci < 0 ? line : line.slice(0, ci)).trim();
    if (!key) continue;
    map.set(key, line);
  }
  return map;
}

/* 取文件头 `# name: 中文标签`，没有则用传入的兜底名 */
function csvLabel(text, fallback) {
  const m = normalize(text).match(/^#\s*name:\s*(.+)$/m);
  return m ? m[1].trim() : fallback;
}

/* 按翻译文字里的品质标签分类（无标签 → 其他） */
const TAG_PRIORITY = [
  ["[传奇]", "传奇"],
  ["[蓝]", "蓝色"],
  ["[绿]", "绿色"],
  ["[灰]", "灰色"],
];
function categoryOf(line) {
  const ci = line.indexOf(",");
  const text = ci < 0 ? line : line.slice(ci + 1);
  for (const [tag, name] of TAG_PRIORITY) {
    if (text.includes(tag)) return name;
  }
  return "其他";
}

/* autoColor 规则解析（颜色判定与 index.html parseAutoColor 一致）：
   首列是合法颜色（#hex 或命名色）的行才是规则，#hex 让规则行也以 # 开头，
   因此「首个逗号前是合法颜色」优先于注释判定。返回 Map<正则文本, 颜色> */
const COLOR_NAMES = {
  red: "#e53935", orange: "#fb8c00", amber: "#ffb300", yellow: "#f2b600",
  green: "#43a047", teal: "#00acc1", blue: "#1e88e5", indigo: "#3949ab",
  purple: "#8e24aa", pink: "#d81b60", brown: "#6d4c41", gray: "#757575",
  gold: "#c9a227",
};
function normColor(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  if (s.charAt(0) === "#") {
    return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s) ? s : "";
  }
  return COLOR_NAMES[s] || "";
}
function parseAutoColorRules(text) {
  const rules = new Map();
  for (const raw of normalize(text).split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const ci = t.indexOf(",");
    if (ci <= 0) continue;
    const color = normColor(t.slice(0, ci).trim());
    if (!color) continue; // 注释行 / 首列颜色非法 → 跳过
    const re = t.slice(ci + 1).trim();
    if (re) rules.set(re, color);
  }
  return rules;
}

/* ---------------- 条目级 diff ---------------- */
function diffEntries(oldText, newText) {
  const oldMap = parseTranslationCsv(oldText || "");
  const newMap = parseTranslationCsv(newText || "");
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [k, v] of newMap) {
    if (!oldMap.has(k)) added.push(v);
    else if (oldMap.get(k) !== v) modified.push(v);
  }
  for (const [k, v] of oldMap) {
    if (!newMap.has(k)) deleted.push(v);
  }
  return { added, modified, deleted };
}

/* ---------------- 提交信息行生成 ---------------- */
/* 带品质标签的文件（affixName / itemDataRow） */
const TAGGED_FILES = { "affixName.csv": "词条", "itemDataRow.csv": "装备" };

function taggedLine(name, unit, oldText, newText) {
  const d = diffEntries(oldText, newText);
  const cats = ["灰色", "绿色", "蓝色", "传奇", "其他"];
  const tally = (lines) => {
    const t = {};
    for (const c of cats) t[c] = 0;
    for (const l of lines) t[categoryOf(l)]++;
    return t;
  };
  const a = tally(d.added);
  const m = tally(d.modified);
  const del = tally(d.deleted);
  const segs = [];
  if (d.added.length) {
    segs.push("增加 " + cats.map((c) => c + unit + a[c] + "条").join("，"));
  }
  if (d.modified.length) {
    segs.push("修改 " + cats.filter((c) => m[c] > 0).map((c) => c + unit + m[c] + "条").join("，"));
  }
  if (d.deleted.length) {
    segs.push("删除 " + cats.filter((c) => del[c] > 0).map((c) => c + unit + del[c] + "条").join("，"));
  }
  if (!segs.length) return null;
  return name + "，" + segs.join("，");
}

/* autoColor 规则库 */
function autoColorLine(name, oldText, newText) {
  const oldR = parseAutoColorRules(oldText || "");
  const newR = parseAutoColorRules(newText || "");
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const [re, color] of newR) {
    if (!oldR.has(re)) added++;
    else if (oldR.get(re) !== color) modified++;
  }
  for (const re of oldR.keys()) {
    if (!newR.has(re)) deleted++;
  }
  return name + "，自动颜色规则，变更记录" + (added + modified + deleted) + "条";
}

/* 通用翻译表：param.csv / traitName.csv 等 */
function genericLine(name, oldText, newText) {
  const d = diffEntries(oldText, newText);
  const label = csvLabel(newText || oldText || "", name.replace(/\.csv$/i, ""));
  const segs = [];
  if (d.added.length) segs.push("增加" + d.added.length + "条");
  if (d.modified.length) segs.push("修改" + d.modified.length + "条");
  if (d.deleted.length) segs.push("删除" + d.deleted.length + "条");
  if (!segs.length) return null;
  return name + "，" + label + "，" + segs.join("，");
}

/* ---------------- 收集 ui/data 变更 ---------------- */
function listWorkCsvs() {
  try {
    return fs
      .readdirSync(path.join(ROOT, DATA_DIR))
      .filter((f) => /\.csv$/i.test(f))
      .sort();
  } catch (_) {
    return [];
  }
}
function listHeadCsvs() {
  const out = gitOut(["ls-tree", "--name-only", "-r", "HEAD", DATA_DIR + "/"]) || "";
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith(DATA_DIR + "/") && /\.csv$/i.test(s))
    .map((s) => s.slice(DATA_DIR.length + 1))
    .sort();
}
function readWork(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, DATA_DIR, rel), "utf8");
  } catch (_) {
    return null;
  }
}
function readHead(rel) {
  return gitOut(["show", "HEAD:" + DATA_DIR + "/" + rel]);
}

/* 配对：同名 → 重命名（内容相同）→ 新增 / 删除 */
function collectPairs() {
  const workFiles = listWorkCsvs();
  const headFiles = listHeadCsvs();
  const pairs = [];
  const usedHead = new Set();
  for (const w of workFiles) {
    if (headFiles.includes(w)) {
      pairs.push({ work: w, head: w, renamed: false });
      usedHead.add(w);
    }
  }
  const restWork = workFiles.filter((w) => !headFiles.includes(w));
  const restHead = headFiles.filter((h) => !workFiles.includes(h));
  for (const w of restWork) {
    const wc = normalize(readWork(w) || "");
    let matched = null;
    for (const h of restHead) {
      if (usedHead.has(h)) continue;
      const hc = readHead(h);
      if (hc != null && normalize(hc) === wc) {
        matched = h;
        break;
      }
    }
    if (matched) {
      pairs.push({ work: w, head: matched, renamed: true });
      usedHead.add(matched);
    } else {
      pairs.push({ work: w, head: null, renamed: false });
    }
  }
  for (const h of restHead) {
    if (!usedHead.has(h)) pairs.push({ work: null, head: h, renamed: false });
  }
  return pairs;
}

/* 展示名去掉前导点（.autoColor.csv → autoColor.csv），与历史提交信息一致 */
function displayName(rel) {
  return rel.replace(/^\./, "");
}

/* 输出顺序：常用文件优先，其余按字母序 */
const PRIORITY = ["affixName.csv", "itemDataRow.csv", "autoColor.csv", "param.csv"];
function sortKey(name) {
  const i = PRIORITY.indexOf(name);
  return (i < 0 ? PRIORITY.length : i) + ":" + name;
}

function buildMessage() {
  const pairs = collectPairs();
  const lines = [];
  for (const p of pairs) {
    const rel = p.work || p.head;
    const name = displayName(rel);
    const oldText = p.head ? readHead(p.head) || "" : "";
    const newText = p.work ? readWork(p.work) || "" : "";
    if (TAGGED_FILES[name]) {
      const line = taggedLine(name, TAGGED_FILES[name], oldText, newText);
      if (line) lines.push({ name, line });
    } else if (name === "autoColor.csv") {
      /* 规则有变，或文件被重命名（如 autoColor.csv → .autoColor.csv）时才列出 */
      const line = autoColorLine(name, oldText, newText);
      const changed = !/变更记录0条$/.test(line);
      if (changed || p.renamed) lines.push({ name, line });
    } else {
      const line = genericLine(name, oldText, newText);
      if (line) lines.push({ name, line });
    }
  }
  lines.sort((a, b) => (sortKey(a.name) < sortKey(b.name) ? -1 : 1));
  const body = lines.map((l) => l.line);
  const message = body.length
    ? TITLE + "\n" + body.join("\n")
    : TITLE + "\n（ui/data 无条目变更）";
  return message;
}

/* ---------------- 交互询问 ---------------- */
/* 读一行输入；stdin 结束（EOF / 管道输入用完）按空值处理 → 视为否 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.question(question, (a) => finish(String(a == null ? "" : a).trim().toLowerCase()));
    rl.on("close", () => finish(""));
  });
}
/* 只有明确的 y / yes / 是 算同意；直接回车或其他一律视为否 */
function isYes(answer) {
  return answer === "y" || answer === "yes" || answer === "是";
}

/* ---------------- 主流程 ---------------- */
async function main() {
  /* 1. 生成并打印变更记录 */
  const message = buildMessage();
  console.log(message);

  if (dryRun) {
    console.log("\n[dry-run] 未提交、未推送。");
    return;
  }

  /* 2. ui/data 没有任何改动 → 无需询问，直接退出 */
  const dataChanges = (gitOut(["status", "--porcelain", "--", DATA_DIR]) || "").trim();
  if (!dataChanges) {
    console.log("\n[data-commit] ui/data 无变更，无需提交。");
    return;
  }

  /* 3. 询问是否提交 */
  const commitAnswer = await ask("\n是否生成变更记录并提交？[y/N] ");
  if (!isYes(commitAnswer)) {
    console.log("已取消，未提交、未推送。");
    return;
  }

  /* 4. 只暂存并只提交 ui/data 路径：
       - add -A -- ui/data：纳入该路径下的增/删/改/重命名
       - commit -- ui/data：路径限定提交，暂存区里的其他文件保持原样不被带入 */
  git(["add", "-A", "--", DATA_DIR]);
  const staged = (gitOut(["diff", "--cached", "--name-only", "--", DATA_DIR]) || "").trim();
  if (!staged) {
    console.log("\n[data-commit] ui/data 没有可提交的内容，终止。");
    return;
  }
  console.log("\n本次提交包含的 ui/data 文件：\n" + staged.split(/\r?\n/).map((f) => "  " + f).join("\n"));

  const tmpMsg = path.join(os.tmpdir(), "tl3-data-commit-msg.txt");
  fs.writeFileSync(tmpMsg, message + "\n", "utf8");
  try {
    git(["commit", "-F", tmpMsg, "--", DATA_DIR], true);
  } finally {
    try {
      fs.unlinkSync(tmpMsg);
    } catch (_) {
      /* 临时文件删不掉无所谓 */
    }
  }

  /* 5. 询问是否推送 */
  if (noPush) {
    console.log("\n[data-commit] 已提交（--no-push，未推送）。");
    return;
  }
  const pushAnswer = await ask("\n是否推送更新到远程仓库？[y/N] ");
  if (!isYes(pushAnswer)) {
    console.log("已提交，未推送。");
    return;
  }
  try {
    git(["push"], true);
  } catch (_) {
    /* 没有设置上游时补一次 -u */
    git(["push", "--set-upstream", "origin", "HEAD"], true);
  }
  console.log("\n[data-commit] 完成。");
}

main().catch((e) => {
  console.error("[data-commit] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
