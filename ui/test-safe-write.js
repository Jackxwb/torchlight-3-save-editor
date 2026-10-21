/* 安全写入防护测试（零依赖：node ui/test-safe-write.js）
   背景：磁盘空间为 0 时，「打开即截断」的写入把 itemDataRow.csv 清空。
   本测试验证 safeWriteFile / backupFile 的防护行为：
   - 正常写 / 覆盖写 / 中文内容 / 无残留 tmp
   - backupFile 生成 .bak；无现文件 / 空文件返回 null
   - mock 磁盘满（statfs avail=0）：写入与备份都抛错，**原文件一个字节都不动**
   - live：起临时 server 验证 POST /api/translations 正常往返 + .bak + 空表 400
   运行环境：单测用系统临时目录；live 测试复制 server 到临时目录，不碰真实数据 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { safeWriteFile, backupFile, diskAvailBytes } = require(path.join(
  ROOT,
  "dist",
  "file.js"
));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL: " + msg);
  }
}
function eq(a, b, msg) {
  ok(a === b, msg + " （期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a) + "）");
}

const TMPBASE = path.join(ROOT, ".wb-test-tmp");
fs.mkdirSync(TMPBASE, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMPBASE, "run-"));
function tmp(name) {
  return path.join(TMP, name);
}

/* ===== 1. safeWriteFile 正常路径 ===== */
console.log("— safeWriteFile 正常路径 —");
{
  const f = tmp("a.txt");
  const n = safeWriteFile(f, "hello");
  eq(n, 5, "safeWriteFile: 返回写入字节数");
  eq(fs.readFileSync(f, "utf8"), "hello", "safeWriteFile: 内容正确");
  ok(!fs.existsSync(f + ".tmp-" + process.pid), "safeWriteFile: 无残留 tmp");

  safeWriteFile(f, "world"); // 覆盖
  eq(fs.readFileSync(f, "utf8"), "world", "safeWriteFile: 覆盖写生效");
  ok(!fs.existsSync(f + ".tmp-" + process.pid), "safeWriteFile: 覆盖后无残留 tmp");

  const zh = tmp("zh.csv");
  const zhContent = "# name: 物品\nArmor_Common_Gloves_Global_01,手套[灰]基础护腕\n";
  const zn = safeWriteFile(zh, zhContent);
  eq(zn, Buffer.byteLength(zhContent, "utf8"), "safeWriteFile: 中文按 utf8 字节数返回");
  eq(fs.readFileSync(zh, "utf8"), zhContent, "safeWriteFile: 中文内容一致");

  const buf = tmp("buf.bin");
  safeWriteFile(buf, Buffer.from([1, 2, 3, 4]));
  eq(fs.readFileSync(buf).length, 4, "safeWriteFile: Buffer 输入");

  // 深层目录自动创建
  const deep = tmp("x/y/z/deep.txt");
  safeWriteFile(deep, "deep");
  eq(fs.readFileSync(deep, "utf8"), "deep", "safeWriteFile: 自动创建目录");
}

/* ===== 2. backupFile ===== */
console.log("— backupFile —");
{
  const f = tmp("b.txt");
  safeWriteFile(f, "original");
  const bak = backupFile(f);
  eq(bak, f + ".bak", "backupFile: 返回备份路径");
  eq(fs.readFileSync(f + ".bak", "utf8"), "original", "backupFile: .bak 内容=原内容");
  eq(fs.readFileSync(f, "utf8"), "original", "backupFile: 原文件不动");

  eq(backupFile(tmp("not-exist.txt")), null, "backupFile: 无现文件 → null");

  const empty = tmp("empty.txt");
  safeWriteFile(empty, "");
  eq(backupFile(empty), null, "backupFile: 空文件 → null（无可保）");
}

/* ===== 3. mock 磁盘满：原文件一个字节都不能动 ===== */
console.log("— 磁盘满防护（mock statfs avail=0）—");
{
  const realStatfs = fs.statfsSync;
  const fullDisk = () => ({ bavail: 0, bsize: 4096 });
  const f = tmp("precious.csv");
  const original = "# name: 物品\nGoldBag,物品[灰]一笔金币\n";
  safeWriteFile(f, original);

  fs.statfsSync = fullDisk;
  let threw = null;
  try {
    safeWriteFile(f, "NEW CONTENT SHOULD NOT LAND");
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, "磁盘满 safeWriteFile: 抛错");
  eq(threw && threw.code, "ENOSPC", "磁盘满 safeWriteFile: code=ENOSPC");
  eq(fs.readFileSync(f, "utf8"), original, "磁盘满 safeWriteFile: 原文件保持原样");
  ok(!fs.existsSync(f + ".tmp-" + process.pid), "磁盘满 safeWriteFile: 无残留 tmp");

  let threw2 = null;
  try {
    backupFile(f);
  } catch (e) {
    threw2 = e;
  }
  ok(threw2 !== null, "磁盘满 backupFile: 抛错");
  eq(threw2 && threw2.code, "ENOSPC_BACKUP", "磁盘满 backupFile: code=ENOSPC_BACKUP");
  eq(fs.readFileSync(f, "utf8"), original, "磁盘满 backupFile: 原文件保持原样");
  ok(!fs.existsSync(f + ".bak"), "磁盘满 backupFile: 不产生 .bak");

  /* 半满磁盘：只够写 1 字节不够写完整内容 */
  fs.statfsSync = () => ({ bavail: 1, bsize: 4096 }); // 4096 字节可用
  let threw3 = null;
  try {
    safeWriteFile(f, "x".repeat(100000)); // 需要 20 万字节+
  } catch (e) {
    threw3 = e;
  }
  eq(threw3 && threw3.code, "ENOSPC", "半满磁盘 safeWriteFile: 空间不足也抛 ENOSPC");
  eq(fs.readFileSync(f, "utf8"), original, "半满磁盘 safeWriteFile: 原文件保持原样");

  fs.statfsSync = realStatfs;
}

/* ===== 4. diskAvailBytes 真实调用 ===== */
console.log("— diskAvailBytes —");
{
  const avail = diskAvailBytes(TMP);
  ok(typeof avail === "number" && (avail === Infinity || avail > 0),
    "diskAvailBytes: 返回正数或 Infinity（当前 " + avail + "）");
}

/* ===== 5. live：临时 server POST /api/translations 往返 ===== */
console.log("— live server 往返 —");
(async () => {
  const TMPLIVE = fs.mkdtempSync(path.join(TMPBASE, "live-"));
  // 复制 server + index.html + dist + 测试 data 目录（不碰真实项目数据）
  fs.mkdirSync(path.join(TMPLIVE, "ui", "data"), { recursive: true });
  fs.mkdirSync(path.join(TMPLIVE, "dist"), { recursive: true });
  fs.mkdirSync(path.join(TMPLIVE, "data"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "ui", "server.js"), path.join(TMPLIVE, "ui", "server.js"));
  fs.copyFileSync(path.join(ROOT, "ui", "index.html"), path.join(TMPLIVE, "ui", "index.html"));
  fs.copyFileSync(path.join(ROOT, "dist", "file.js"), path.join(TMPLIVE, "dist", "file.js"));
  fs.copyFileSync(path.join(ROOT, "dist", "index.js"), path.join(TMPLIVE, "dist", "index.js"));
  fs.copyFileSync(path.join(ROOT, "dist", "export.js"), path.join(TMPLIVE, "dist", "export.js"));
  fs.copyFileSync(path.join(ROOT, "dist", "import.js"), path.join(TMPLIVE, "dist", "import.js"));
  fs.copyFileSync(path.join(ROOT, "assets", "1mb.sav"), path.join(TMPLIVE, "dist", "1mb.sav"));
  const csvName = "testkind.csv";
  const csvPath = path.join(TMPLIVE, "ui", "data", csvName);
  const initial = "# name: 测试\nFoo,原始翻译\nBar,另一条\n";
  fs.writeFileSync(csvPath, initial, "utf8");

  const PORT = 18791;
  const srv = spawn(process.execPath, [path.join(TMPLIVE, "ui", "server.js"), "--no-open"], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: path.join(TMPLIVE, "data"),
    }),
    stdio: "pipe",
  });
  let stderrBuf = "";
  srv.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });

  function req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: urlPath,
          method,
          headers: body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {},
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: buf })
          );
        }
      );
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });
  }

  try {
    // 等 server 起来
    for (let i = 0; i < 50; i++) {
      try {
        await req("GET", "/api/config");
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    /* 1. 正常 POST：写回 CSV + 生成 .bak（= 原内容） */
    const entries = JSON.stringify({
      file: csvName,
      entries: [
        { value: "Foo", text: "修改后的翻译" },
        { value: "Bar", text: "另一条" },
        { value: "New", text: "新增条目" },
      ],
    });
    const r1 = await req("POST", "/api/translations", entries);
    eq(r1.status, 200, "live POST: 200");
    const written = fs.readFileSync(csvPath, "utf8");
    ok(written.indexOf("修改后的翻译") !== -1, "live POST: 新翻译已写入");
    ok(written.indexOf("# name: 测试") !== -1, "live POST: 注释头保留");
    const bak = fs.readFileSync(csvPath + ".bak", "utf8");
    eq(bak, initial, "live POST: .bak = 写入前的原内容");
    ok(!fs.existsSync(csvPath + ".tmp-" + srv.pid), "live POST: 无残留 tmp");

    /* 2. 空表 → 400（原有防护仍在） */
    const r2 = await req("POST", "/api/translations", JSON.stringify({ file: csvName, entries: [] }));
    eq(r2.status, 400, "live POST 空表: 400");

    /* 3. 白名单外文件 → 400 */
    const r3 = await req("POST", "/api/translations", JSON.stringify({ file: "autoColor.csv", entries: [{ value: "x", text: "y" }] }));
    eq(r3.status, 400, "live POST autoColor.csv: 400（非翻译 kind）");

    /* 4. 真实项目数据未被触碰 */
    const realCsv = path.join(ROOT, "ui", "data", "itemDataRow.csv");
    ok(fs.readFileSync(realCsv, "utf8").indexOf("GoldBag") !== -1,
      "live 测试后: 真实 itemDataRow.csv 完好");
  } finally {
    srv.kill();
  }

  /* 清理本次临时产物（个别平台文件句柄未释放时静默失败，无碍） */
  for (const d of [TMP, TMPLIVE]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
  }
  try {
    if (fs.readdirSync(TMPBASE).length === 0) fs.rmdirSync(TMPBASE);
  } catch (_) {}

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("live 测试异常:", e);
  process.exit(1);
});
