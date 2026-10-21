import path from "path";
import fs from "fs";

import file from "./file";

function command(frontiersFolder) {
  const inputFolder = path.resolve("./torchlight-3-save-editor");
  const outputFolder = path.join(frontiersFolder, file.saveGameFolder);

  if (!fs.existsSync(inputFolder)) {
    console.error(
      `JSON folder not found: ${inputFolder}\n` +
        `Run the export command first to create it.`
    );
    process.exit(1);
  }

  const fileNames = file.listAllValidFiles(inputFolder);

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  for (let fileName of fileNames) {
    const content = fs.readFileSync(path.join(inputFolder, fileName), "utf-8");

    const savPath = path.join(
      outputFolder,
      fileName.replace(".json", ".sav")
    );
    // 写 .sav 前先备份（磁盘空间不足时备份失败 → 抛错中断，原存档不动）
    file.backupFile(savPath);
    file.saveFile(savPath, JSON.parse(content));
  }
}

export default command;
