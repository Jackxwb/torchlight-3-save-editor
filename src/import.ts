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

    file.saveFile(
      path.join(outputFolder, fileName.replace(".json", ".sav")),
      JSON.parse(content)
    );
  }
}

export default command;
