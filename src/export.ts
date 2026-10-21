import path from "path";
import fs from "fs";

import file from "./file";

function command(frontiersFolder) {
  const inputFolder = path.join(frontiersFolder, file.saveGameFolder);
  const outputFolder = path.resolve("./torchlight-3-save-editor");

  if (!fs.existsSync(inputFolder)) {
    console.error(
      `Save game folder not found: ${inputFolder}\n` +
        `Make sure -p points to the Frontiers folder ` +
        `(Windows: %localappdata%\\Frontiers).`
    );
    process.exit(1);
  }

  const fileNames = file.listAllValidFiles(inputFolder);

  if (fileNames.length === 0) {
    console.log(
      `No save files (*-CharacterData.sav, *-AccountWide.sav, ` +
        `*-FortInventory.sav, *-FortStash.sav) found in ${inputFolder}`
    );
    return;
  }

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  for (let fileName of fileNames) {
    const content = file.getContent(path.join(inputFolder, fileName));
    fs.writeFileSync(
      path.join(outputFolder, fileName.replace(".sav", ".json")),
      JSON.stringify(JSON.parse(content), null, 2)
    );
  }
}

export default command;
