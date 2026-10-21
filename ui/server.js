/*
 * torchlight-3-save-editor - local Web UI
 * Zero dependencies: Node.js built-ins only (no npm install needed).
 *
 *   node ui/server.js            (or double-click ui\start-ui.bat)
 *   -> http://127.0.0.1:8791
 *
 * API:
 *   GET  /api/config             { dataDir, frontiers, projectRoot }
 *   GET  /api/files              list *.json in the data dir
 *   GET  /api/file?name=X        read + parse one JSON file
 *   POST /api/save               { name, content }  (backs up to .bak first)
 *   POST /api/export             { frontiers } extract .sav -> JSON (same
 *                                logic as the CLI export command)
 *   POST /api/import             { frontiers } repack JSON -> .sav (same
 *                                logic as the CLI import command)
 *   GET  /api/translations/files          list translation CSVs in ./ui/data
 *   GET  /api/translations?file=guid.csv        read a translation CSV
 *   POST /api/translations       { file, entries:[{value,text,color}] } rewrite it（color 可选：#hex 或命名色）
 *  GET  /api/autocolor                     read ./ui/data/autoColor.csv（自动配色规则库）
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "torchlight-3-save-editor");
/* 静态翻译数据目录：ui/data/{guid.csv,affixName.csv} */
const TRANSLATION_DIR = path.join(__dirname, "data");
/* autoColor 规则库文件名：也放在 data 目录，但不是翻译 kind，
   翻译清单 / 读写接口都要把它排除在外 */
const AUTOCOLOR_FILE = "autoColor.csv";
/* 动态列出 ./ui/data 下的翻译 CSV：文件名（去 .csv 后缀）即翻译 Key，
   新增一个 csv 文件就自动多一路翻译，无需改代码（autoColor.csv 除外） */
function listTranslationFiles() {
  try {
    return fs
      .readdirSync(TRANSLATION_DIR)
      .filter((f) => /\.csv$/i.test(f) && f.toLowerCase() !== AUTOCOLOR_FILE.toLowerCase() &&
        fs.statSync(path.join(TRANSLATION_DIR, f)).isFile())
      .sort();
  } catch (_) {
    return [];
  }
}
const NO_OPEN = process.argv.includes("--no-open");

/* 颜色值标准化（与前端一致）：#hex(3/4/6/8) 或内置命名色 → 小写 #hex；非法返回 "" */
const COLOR_NAMES = {
  red: "#e53935", orange: "#fb8c00", amber: "#ffb300", yellow: "#f2b600",
  green: "#43a047", teal: "#00acc1", blue: "#1e88e5", indigo: "#3949ab",
  purple: "#8e24aa", pink: "#d81b60", brown: "#6d4c41", gray: "#757575",
  gold: "#c9a227",
};
function normColorValue(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  if (s.charAt(0) === "#") {
    return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s) ? s : "";
  }
  return COLOR_NAMES[s] || "";
}

// dist/file.js holds the .sav <-> JSON packing logic (compiled from src).
const fileMod = require(path.join(ROOT, "dist", "file.js"));
const file = fileMod.default || fileMod;
// 安全写入三件套（src/file.ts 编译而来）：备份 / 原子写 / 空间查询
const backupFile = file.backupFile;
const safeWriteFile = file.safeWriteFile;

/* 错误日志：写 ui/server.log（超 256KB 自动重建，防日志本身把磁盘写满），
   同时打一份到 stderr。任何写盘异常都留痕，避免"静默丢失" */
const UI_LOG = path.join(__dirname, "server.log");
const UI_LOG_MAX = 256 * 1024;
function uiLog(scope, err) {
  const line =
    "[" + new Date().toISOString() + "] " + scope + ": " +
    String((err && err.stack) || err) + "\n";
  try {
    fs.appendFileSync(UI_LOG, line);
    if (fs.statSync(UI_LOG).size > UI_LOG_MAX) {
      fs.writeFileSync(UI_LOG, line);
    }
  } catch (_) {}
  try {
    process.stderr.write(line);
  } catch (_) {}
}

/* 写盘类错误的 HTTP 状态码：磁盘空间不足 → 507，其余 → 500 */
function writeErrStatus(e) {
  return e && (e.code === "ENOSPC" || e.code === "ENOSPC_BACKUP") ? 507 : 500;
}

const START_PORT = Number(process.env.PORT) || 8791;
const MAX_PORT = START_PORT + 10;
const MAX_BODY = 64 * 1024 * 1024;

function defaultFrontiers() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Frontiers");
  }
  return path.join(os.homedir(), "Frontiers");
}

function isSafeJsonName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name === path.basename(name) &&
    !name.includes("..") &&
    /\.json$/i.test(name)
  );
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function apiFiles(res) {
  if (!fs.existsSync(DATA_DIR)) {
    return sendJson(res, 404, {
      error: "data dir not found: " + DATA_DIR,
      hint: "run: node dist/index.js -p <Frontiers folder> export",
    });
  }
  let validSet = new Set();
  try {
    validSet = new Set(file.listAllValidFiles(DATA_DIR));
  } catch (_) {
    /* data dir unreadable - treat everything as non-matching */
  }
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => {
      const lower = f.toLowerCase();
      return lower.endsWith(".json") && !lower.endsWith(".bak");
    })
    .sort()
    .map((name) => {
      const st = fs.statSync(path.join(DATA_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs, valid: validSet.has(name) };
    });
  sendJson(res, 200, { dataDir: DATA_DIR, files });
}

function apiGetFile(res, name) {
  if (!isSafeJsonName(name)) {
    return sendJson(res, 400, { error: "invalid file name" });
  }
  const target = path.join(DATA_DIR, name);
  if (!fs.existsSync(target)) {
    return sendJson(res, 404, { error: "file not found: " + name });
  }
  const raw = fs.readFileSync(target, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return sendJson(res, 400, { error: "JSON parse failed: " + e.message });
  }
  sendJson(res, 200, {
    name,
    raw,
    json,
    compactLength: JSON.stringify(json).length,
    mtime: fs.statSync(target).mtimeMs,
  });
}

function apiSave(res, body) {
  const name = String((body && body.name) || "");
  if (!isSafeJsonName(name)) {
    return sendJson(res, 400, { error: "invalid file name" });
  }
  const target = path.join(DATA_DIR, name);
  if (!fs.existsSync(target)) {
    return sendJson(res, 404, { error: "file not found: " + name });
  }
  const content = String((body && body.content) || "");
  try {
    JSON.parse(content);
  } catch (e) {
    return sendJson(res, 400, { error: "JSON parse failed: " + e.message });
  }
  try {
    backupFile(target); // 覆盖前备份，失败则拒绝写入（原文件不动）
    const bytes = safeWriteFile(target, content);
    sendJson(res, 200, {
      ok: true,
      bytes,
      backup: path.basename(target + ".bak"),
    });
  } catch (e) {
    uiLog("apiSave " + name, e);
    sendJson(res, writeErrStatus(e), { error: String((e && e.message) || e) });
  }
}

function apiImport(res, body) {
  const frontiers =
    body && body.frontiers
      ? path.resolve(String(body.frontiers))
      : defaultFrontiers();
  if (!fs.existsSync(DATA_DIR)) {
    return sendJson(res, 404, { error: "data dir not found: " + DATA_DIR });
  }
  const saveGames = path.join(frontiers, file.saveGameFolder);
  if (!fs.existsSync(saveGames)) {
    return sendJson(res, 400, { error: "save game folder not found: " + saveGames });
  }
  const names = file
    .listAllValidFiles(DATA_DIR)
    .filter((f) => !f.toLowerCase().endsWith(".bak"));
  const results = [];
  for (const name of names) {
    const savName = name.replace(/\.json$/i, ".sav");
    const savPath = path.join(saveGames, savName);
    try {
      const json = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
      if (!fs.existsSync(savPath)) {
        results.push({ name, ok: false, reason: "no matching save: " + savName });
        continue;
      }
      const capacity = file.getContent(savPath).length;
      const compact = JSON.stringify(json);
      if (compact.length > capacity) {
        results.push({
          name,
          ok: false,
          reason: "Content too large (" + compact.length + " > " + capacity + ")",
        });
        continue;
      }
      backupFile(savPath); // 备份失败 → 该文件记 errors，原 .sav 不动
      file.saveFile(savPath, json); // 内部为 tmp+rename 原子写
      results.push({
        name,
        ok: true,
        bytes: fs.statSync(savPath).size,
        backup: savName + ".bak",
      });
    } catch (e) {
      results.push({ name, ok: false, reason: String((e && e.message) || e) });
    }
  }
  sendJson(res, 200, { ok: true, frontiers, saveGames, results });
}

function apiExport(res, body) {
  const frontiers =
    body && body.frontiers
      ? path.resolve(String(body.frontiers))
      : defaultFrontiers();
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const inputFolder = path.join(frontiers, file.saveGameFolder);
  if (!fs.existsSync(inputFolder)) {
    return sendJson(res, 400, {
      error: "save game folder not found: " + inputFolder,
      hint: "Windows: %localappdata%\\Frontiers",
    });
  }
  const fileNames = file
    .listAllValidFiles(inputFolder)
    .filter((f) => !f.toLowerCase().endsWith(".bak"));
  if (!fileNames.length) {
    return sendJson(res, 200, {
      ok: true,
      frontiers,
      inputFolder,
      outputFolder: DATA_DIR,
      exported: [],
      message:
        "No save files (*-CharacterData.sav, *-AccountWide.sav, " +
        "*-FortInventory.sav, *-FortStash.sav) found in " + inputFolder,
    });
  }
  const exported = [];
  const errors = [];
  for (const fileName of fileNames) {
    try {
      const content = file.getContent(path.join(inputFolder, fileName));
      const outName = fileName.replace(/\.sav$/i, ".json");
      const outPath = path.join(DATA_DIR, outName);
      backupFile(outPath); // 覆盖同名导出产物前先备份
      safeWriteFile(outPath, JSON.stringify(JSON.parse(content), null, 2));
      exported.push(outName);
    } catch (e) {
      uiLog("apiExport " + fileName, e);
      errors.push({ name: fileName, reason: String((e && e.message) || e) });
    }
  }
  sendJson(res, 200, {
    ok: true,
    frontiers,
    inputFolder,
    outputFolder: DATA_DIR,
    exported,
    errors,
  });
}

let indexHtml = null;
let indexHtmlMtime = -1;
/* 页面缓存按 mtime 失效：改了 index.html 后刷新浏览器即可生效，无需重启服务器 */
function getIndexHtml() {
  try {
    const st = fs.statSync(path.join(__dirname, "index.html"));
    if (indexHtml === null || st.mtimeMs !== indexHtmlMtime) {
      indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      indexHtmlMtime = st.mtimeMs;
    }
  } catch (e) { /* stat/read 失败时保留上一份可用副本 */ }
  return indexHtml;
}

/* 白名单 = data 目录下真实存在的 .csv 文件名（防目录穿越） */
function isSafeTranslationFile(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name === path.basename(name) &&
    !name.includes("..") &&
    /\.csv$/i.test(name) &&
    listTranslationFiles().indexOf(name) !== -1
  );
}

/* GET /api/translations/files —— 列出 data 目录下全部翻译 CSV 文件名 */
function apiListTranslationFiles(res) {
  sendJson(res, 200, { files: listTranslationFiles() });
}

/* GET /api/translations?file=guid.csv —— 返回 CSV 原文（带浏览器缓存头，
 * 前端"刷新"按钮用 cache:reload 绕过） */
function apiGetTranslations(res, name) {
  if (!isSafeTranslationFile(name)) {
    return sendJson(res, 400, { error: "unknown translation file: " + name });
  }
  let text = "";
  try {
    text = fs.readFileSync(path.join(TRANSLATION_DIR, name), "utf8");
  } catch (_) {
    /* 文件不存在 → 空内容，前端得到空表 */
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=60",
  });
  res.end(text);
}

/* GET /api/autocolor —— 返回 autoColor.csv 原文（文件不存在 → 空串，前端得到空规则）。
   与翻译 CSV 同样的缓存头：手改规则后刷新浏览器最多等 60 秒，
   或点选择窗「刷新」（带 cache:reload）立即生效 */
function apiGetAutoColor(res) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(TRANSLATION_DIR, AUTOCOLOR_FILE), "utf8");
  } catch (_) {
    /* 文件不存在 → 空内容，前端按"无规则"处理 */
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=60",
  });
  res.end(text);
}

/* POST /api/translations { file, entries:[{value,text}] } —— 重写 CSV */
async function apiSaveTranslations(res, body) {
  const name = body && body.file;
  if (!isSafeTranslationFile(name)) {
    return sendJson(res, 400, { error: "unknown translation file: " + name });
  }
  const entries = body.entries;
  if (!Array.isArray(entries)) {
    return sendJson(res, 400, { error: "entries must be an array" });
  }
  /* 防空表写入：entries 为空只会来自客户端缓存加载失败后的误操作，
     一旦写进去会把整张翻译表清剩注释头，必须拦住 */
  if (entries.length === 0) {
    return sendJson(res, 400, {
      error: "拒绝写入空翻译表（entries 为空）。若页面翻译缓存为空，请先点选择窗的「刷新」重新读取 CSV",
    });
  }
  const lines = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    // value 不允许含逗号/换行（CSV 首列）；text 不允许含换行（逗号允许）
    const value = String(e.value == null ? "" : e.value).replace(/[,\r\n]/g, "").trim();
    const text = String(e.text == null ? "" : e.text).replace(/[\r\n]/g, "").trim();
    // 行末第三列颜色（可选）：统一归一化为 #hex，非法值直接丢弃该列
    const color = normColorValue(e.color);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    lines.push(color ? value + "," + text + "," + color : value + "," + text);
  }
  lines.sort((a, b) => a.localeCompare(b));
  /* 注释头：优先原样保留原文件的全部注释行（含 # name: 等自定义参数），
     避免 UI 里增删改一次就把头部参数冲掉；原文件不存在时才用默认头 */
  const fp = path.join(TRANSLATION_DIR, name);
  let header =
    "# Torchlight 3 存档编辑器 - " + name.replace(/\.csv$/, "") + " 翻译表\n" +
    "# 格式：每行 「数值,翻译」，第三列可选 #hex 颜色；井号开头为注释；翻译中可以包含逗号\n";
  try {
    const old = fs.readFileSync(fp, "utf8");
    const oldComments = old.split(/\r?\n/).filter((l) => l.trim().charAt(0) === "#");
    if (oldComments.length) header = oldComments.join("\n") + "\n";
  } catch (_) {}
  const content = header + lines.join("\n") + (lines.length ? "\n" : "");
  /* 安全写入：备份 → tmp + rename 原子替换。
     磁盘满等异常时原 CSV 保持原样（绝不被截断），错误透传给前端 */
  try {
    backupFile(fp);
    const bytes = safeWriteFile(fp, content);
    sendJson(res, 200, { ok: true, file: name, count: lines.length, bytes, path: fp });
  } catch (e) {
    uiLog("apiSaveTranslations " + name, e);
    sendJson(res, writeErrStatus(e), { error: String((e && e.message) || e) });
  }
}

async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return sendHtml(res, getIndexHtml());
    }
    if (req.method === "GET" && p === "/api/config") {
      return sendJson(res, 200, {
        dataDir: DATA_DIR,
        frontiers: defaultFrontiers(),
        projectRoot: ROOT,
      });
    }
    if (req.method === "GET" && p === "/api/files") return apiFiles(res);
    if (req.method === "GET" && p === "/api/file") {
      return apiGetFile(res, u.searchParams.get("name") || "");
    }
    if (req.method === "GET" && p === "/api/translations/files") {
      return apiListTranslationFiles(res);
    }
    if (req.method === "GET" && p === "/api/translations") {
      return apiGetTranslations(res, u.searchParams.get("file") || "");
    }
    if (req.method === "GET" && p === "/api/autocolor") {
      return apiGetAutoColor(res);
    }
    if (req.method === "POST" && p === "/api/save") {
      return apiSave(res, JSON.parse(await readBody(req)));
    }
    if (req.method === "POST" && p === "/api/translations") {
      return apiSaveTranslations(res, JSON.parse((await readBody(req)) || "{}"));
    }
    if (req.method === "POST" && p === "/api/import") {
      return apiImport(res, JSON.parse((await readBody(req)) || "{}"));
    }
    if (req.method === "POST" && p === "/api/export") {
      return apiExport(res, JSON.parse((await readBody(req)) || "{}"));
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url], () => {});
    } else {
      execFile("xdg-open", [url], () => {});
    }
  } catch (_) {
    /* opening the browser is best-effort */
  }
}

const server = http.createServer(handler);
let port = START_PORT;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && port < MAX_PORT) {
    port += 1;
    server.listen(port, "127.0.0.1");
  } else {
    console.error("[torchlight-ui] failed to start: " + e.message);
    process.exit(1);
  }
});
server.listen(port, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + port + "/";
  console.log("====================================================");
  console.log(" Torchlight 3 save editor UI");
  console.log(" URL        : " + url);
  console.log(" Data dir   : " + DATA_DIR);
  console.log(" Frontiers  : " + defaultFrontiers());
  console.log(" Stop       : Ctrl+C (close this window)");
  console.log("====================================================");
  if (!NO_OPEN) openBrowser(url);
});

/* 进程级兜底：未捕获异常/未处理 Promise 拒绝不再静默崩溃退出，
   统一记日志（ui/server.log，带堆栈）后尽量保持服务存活。
   所有已知写盘路径均已原子化，这里只是最后一道保险 */
process.on("uncaughtException", (e) => {
  uiLog("uncaughtException", e);
});
process.on("unhandledRejection", (e) => {
  uiLog("unhandledRejection", e);
});
