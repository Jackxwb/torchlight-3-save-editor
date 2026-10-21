import fs from "fs";
import path from "path";

import appRoot from "app-root-path";

const saveGameFolder = "Saved/SaveGames";

// TODO: get JSON by jumpTo instead last dataVersion
// /[0-9]*-QuestData\.(sav|json)/,
// /[0-9]*-AccountQuests\.(sav|json)/,
const validFiles = [
  /[0-9]*-CharacterData\.(sav|json)$/,
  /[0-9]*-AccountWide\.(sav|json)$/,
  /[0-9]*-FortInventory\.(sav|json)$/,
  /[0-9]*-FortStash\.(sav|json)$/,
];

function getStartindex(fileAsBuffer) {
  const jsonType = fileAsBuffer.indexOf("JsonString", 0, "utf-8");
  return fileAsBuffer.indexOf("{", jsonType, "utf-8");
}

function getEndIndex(fileAsBuffer) {
  var lastDataVersion = fileAsBuffer.indexOf("dataVersion", 0, "utf-8");
  while (
    fileAsBuffer.indexOf("dataVersion", lastDataVersion + 1, "utf-8") > -1
  ) {
    lastDataVersion = fileAsBuffer.indexOf(
      "dataVersion",
      lastDataVersion + 1,
      "utf-8"
    );
  }

  return fileAsBuffer.indexOf("}", lastDataVersion, "utf-8") + 1;
}

/* ================= 安全写入（防磁盘满/异常写坏文件） =================
 * 曾因磁盘可用空间为 0，写文件时「打开即截断」把整个文件清空。
 * 此后所有写入遵守以下原则：
 *   1. 原文件永不被直接打开写——只走 tmp + rename 原子替换
 *   2. 覆盖前先备份 .bak；备份失败 = 拒绝写入（原文件裸奔比没备份更糟）
 *   3. 写入前预检磁盘空间；tmp 落盘后回读校验字节数
 *   4. 任一步骤失败：清理 tmp、原文件保持原样、向上抛错
 * ==================================================================== */

/* 目录可用字节数；statfs 不可用（旧版 Node）时放行，靠后续校验兜底 */
function diskAvailBytes(dir: string): number {
  try {
    const st = (fs as any).statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) {
    return Infinity;
  }
}

function fmtKB(n: number): string {
  return (n / 1024).toFixed(0) + "KB";
}

/* 备份现文件到 fp + ".bak"；无现文件返回 null。
   备份失败（含空间不足）会抛错——宁可拒绝写入也不裸奔 */
function backupFile(fp: string): string | null {
  let old: Buffer | null = null;
  try {
    old = fs.readFileSync(fp);
  } catch (_) {
    return null; // 现文件不存在或读不了：无从备份
  }
  if (!old.length) return null; // 空壳没什么可保
  const bak = fp + ".bak";
  const avail = diskAvailBytes(path.dirname(fp));
  if (avail < old.length + 65536) {
    const e: any = new Error(
      "磁盘空间不足：无法创建备份 " +
        path.basename(bak) +
        "（需要 " +
        fmtKB(old.length + 65536) +
        "，可用 " +
        fmtKB(avail) +
        "）。已取消写入，原文件未改动，请清理空间后重试"
    );
    e.code = "ENOSPC_BACKUP";
    throw e;
  }
  fs.writeFileSync(bak, old); // 失败同样抛出，且原文件未动
  return bak;
}

/* 原子安全写：空间预检 → 写 tmp → 回读校验 → rename 替换。
   任一步骤失败都清理 tmp 并抛出，原文件保持原样 */
function safeWriteFile(fp: string, content: any): number {
  const buf: Buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content == null ? "" : content), "utf8");
  const dir = path.dirname(fp);
  const avail = diskAvailBytes(dir);
  const need = buf.length * 2 + 131072; // tmp + rename 缓冲 + 128KB 余量
  if (avail < need) {
    const e: any = new Error(
      "磁盘空间不足：写入 " +
        path.basename(fp) +
        " 需要约 " +
        fmtKB(need) +
        "，当前可用 " +
        fmtKB(avail) +
        "。原文件未改动，请清理空间后重试"
    );
    e.code = "ENOSPC";
    throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fp + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, buf);
    const back = fs.readFileSync(tmp);
    if (back.length !== buf.length) {
      throw new Error(
        "写入校验失败：临时文件 " +
          back.length +
          " 字节，预期 " +
          buf.length +
          " 字节"
      );
    }
    fs.renameSync(tmp, fp); // 同分区原子替换：原文件要么旧的要么新的
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
  return buf.length;
}

function saveFile(path: string, content: any) {
  const fileAsBuffer = fs.readFileSync(`${appRoot.path}/assets/1mb.sav`);

  const indexOfFirstBracket = getStartindex(fileAsBuffer);
  const indexOfLastBracket = getEndIndex(fileAsBuffer);

  if (typeof content === "object") {
    content = JSON.stringify(content);
  }

  if (content.length > indexOfLastBracket - indexOfFirstBracket) {
    throw new Error("Content too large");
  }

  const paddedContent =
    content.slice(0, -1).padEnd(indexOfLastBracket - indexOfFirstBracket - 1) +
    content[content.length - 1];

  for (
    let index = 0;
    index <= indexOfLastBracket - indexOfFirstBracket;
    index++
  ) {
    fileAsBuffer[indexOfFirstBracket + index] = paddedContent.charCodeAt(index);
  }

  // 写前备份：磁盘满等原因失败则抛错，游戏存档保持原样
  backupFile(path);
  // 原子安全写：tmp + rename，任何失败原 .sav 不动
  safeWriteFile(path, fileAsBuffer);
}

function getContent(filePath) {
  const fileAsBuffer = fs.readFileSync(filePath);

  const indexOfFirstBracket = getStartindex(fileAsBuffer);
  const indexOfLastBracket = getEndIndex(fileAsBuffer);

  const content = fileAsBuffer
    .slice(indexOfFirstBracket, indexOfLastBracket)
    .toString("utf-8");
  return content;
}

function listAllValidFiles(dirPath) {
  const fileList = fs.readdirSync(dirPath);

  const validFileList = fileList.filter(
    (fileName) =>
      validFiles.filter((pattern) => fileName.match(pattern)).length > 0
  );

  return validFileList;
}

export { diskAvailBytes, backupFile, safeWriteFile };

export default {
  saveGameFolder,

  saveFile,
  listAllValidFiles,
  getContent,
  backupFile,
  safeWriteFile,
};
