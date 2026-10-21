# torchlight-3-save-editor

火炬之光 3 单机版（Torchlight 3 Singleplayer / Frontiers）存档编辑器。

## 关于本项目

本项目是 [GalacticCapybara/torchlight-3-save-editor](https://github.com/GalacticCapybara/torchlight-3-save-editor)
的个人 fork。原版是一个命令行工具：把游戏的 `.sav` 存档导出为 JSON，
编辑后再打包导回游戏。本 fork 在保留原有命令行能力的基础上，修复了
原生依赖带来的安装问题，并新增了一个**零依赖的本地 Web 可视化编辑界面**
和一套**中英翻译词库系统**，让修存档不再需要手啃几千行 JSON。

## 与原版的差异

### 修改

- **移除 `platform-folders` 原生依赖**，改为自研的 `src/folders.ts`
  解析用户文档目录——不再需要 node-gyp 编译，`pnpm install` 不会再
  因为本地 C++ 编译环境失败。
- JSON 工作目录改为**相对于当前运行目录**的 `./torchlight-3-save-editor`，
  在项目目录内运行即可，导出产物集中好找。
- Web UI 的存档读写（导出 / 导入 / 保存）复用 CLI 同一套逻辑
  （`dist/file.js`），两种方式行为完全一致。

### 新增功能

**本地 Web UI（`ui/`）**

- JSON 可视化树：行内编辑、增删字段、克隆、上下移动、双击重命名、
  关键字过滤
- 数组 / 对象支持整段局部 JSON 编辑弹窗，适合大刀阔斧改数据
- 未保存修改时切换文件会弹窗确认，不再静默拦截或丢失修改
- 一键「导出 / 导入 / 保存」，保存前自动备份原文件为 `*.bak`
- JSON 路径面包屑：点击任意输入框，在顶部显示完整路径
  （`wardrobeInventories > [0] > entries > [0] > affixName`），点击路径段
  平滑滚动跳转，悬停弹出同级兄弟节点菜单快速切换
- 界面语言为中文，无需任何配置

**翻译词库系统（`ui/data/*.csv`）**

- **动态扫描**：页面启动时自动读取 `ui/data/` 下所有 CSV，**文件名
  （去掉 `.csv`）就是翻译 Key**——树中出现同名键即显示翻译，新增一个
  CSV 文件就自动多一路翻译，无需改代码
- `# name: 附魔属性` —— 键名中文标签（如 `affixName → 附魔属性`）
- `# isKey: true` —— 纯 Key 汉化模式（适合 `entries → 条目` 这类场景）
- `# color: blue` —— 该 Key 的主题色（13 个命名色或 `#hex`）
- 行末第三列 `数值,翻译,#ff8800` —— 单条翻译文字颜色
- 翻译文本支持 `<font color="#fff">变色</font>` 内联局部上色
- `autoColor.csv` —— 正则自动配色规则库：翻译未手动设色时，按正则
  匹配翻译文字自动着色（如所有含「火焰」的翻译显示为橙色）
- 翻译选择弹窗：新增 / 修改 / 删除 / 刷新 / 按原文或翻译排序，
  窗口大小可拖动调整并记忆在浏览器本地

## 环境要求

- **Node.js 16 或更高版本**（CLI 与 Web UI 均只依赖 Node，无其他运行时要求）
- 包管理器：pnpm / npm / yarn 任一即可
- 操作系统：Windows / Linux 均可（`ui/start-ui.bat` 为 Windows 专用启动器，
  其他系统用 `node ui/server.js` 启动）

## 安装与构建

```bash
# 1. 克隆仓库
git clone https://github.com/Jackxwb/torchlight-3-save-editor.git
cd torchlight-3-save-editor

# 2. 安装依赖（pnpm / npm / yarn 任一）
pnpm install

# 3. 构建（编译 TypeScript → dist/，并拷贝示例存档）
pnpm build
```

`pnpm build` 依次执行：清理 `dist/` → Prettier 格式化源码 →
TypeScript 编译（`tsc`）→ 拷贝 `assets/` 示例存档到 `dist/`。
用 npm 的话对应命令是 `npm run build`。

> **注意**：Web UI 的存档读写依赖 `dist/file.js`，使用 Web UI 前
> 必须先完成构建。`dist/` 已加入 `.gitignore`，属于构建产物。

## 使用方法

### 方式一：命令行（CLI）

```bash
# 存档目录（Frontiers 文件夹）：
#   Windows: %localappdata%\Frontiers\
#   Linux:   <steam库>/steamapps/common/<游戏安装目录>/Frontiers

# 1. 导出存档为 JSON（在项目目录下执行）
node dist/index.js -p <Frontiers目录> export

# 2. 编辑 ./torchlight-3-save-editor/ 下生成的 JSON 文件
#    （也可用下面的 Web UI 编辑）

# 3. 导入回游戏存档
node dist/index.js -p <Frontiers目录> import
```

`<Frontiers目录>` 可以用相对路径（在项目目录内运行）或绝对路径。

### 方式二：Web UI（推荐）

```bash
# 在项目目录下
node ui/server.js

# Windows 也可以直接双击 ui\start-ui.bat
```

启动后浏览器打开 <http://127.0.0.1:8791>（端口被占用时自动顺延，
最多尝试 10 个端口）。Web UI 本身零 npm 依赖，但需要 `dist/` 已构建。

界面功能：

- 左侧文件列表（来自 `./torchlight-3-save-editor/*.json`），右上角
  「导出 / 导入」直接操作 `.sav`
- 树中编辑：点击输入框改值，行内按钮增删 / 克隆 / 移动 / 重命名 /
  局部 JSON 编辑
- 英文键自动显示中文翻译（见下方词库说明），选择弹窗里可以直接
  增删改翻译并写回 CSV
- 顶部路径面包屑定位当前字段，点击跳转、悬停切换同级节点
- 「保存」写回 JSON 并同步生成 `.sav` 备份

## 翻译词库（ui/data）

翻译数据全部来自 `ui/data/` 下的 CSV 文件，不内置词典、不需要改代码：

```csv
# name: 附魔属性
# color: orange
FireResist,火焰抗性,#ff8800
```

- 每行 `数值,翻译`（按第一个逗号分割，翻译里可以含逗号）
- `#` 开头为注释行；`# 参数名: 值` 形式的注释是头部参数
  （`name` / `isKey` / `color`）
- 行末第三列 `#hex` 是该条翻译的文字颜色
- `autoColor.csv` 是正则自动配色规则库（`颜色,正则1,正则2,...`），
  格式见文件内注释

删除 `ui/data/` 下的 CSV 不影响程序运行，只是对应键不再显示翻译。

## 数据安全与可靠性

本项目曾因磁盘可用空间为 0，写入时「打开即截断」把翻译 CSV 整个清空。
此后所有写盘路径（CSV 写回、JSON 保存、`.sav` 导入导出）统一遵循：

- **原子写入**：永不直接打开原文件写。一律「写临时文件 → 回读校验
  字节数 → 同目录 rename 原子替换」，任何一步失败原文件保持原样
- **写入前备份**：覆盖已有文件前先复制为 `.bak`；备份失败（如空间
  不足）直接拒绝写入——宁可写不进去，也不让原文件失去保护
- **空间预检**：写入前检查磁盘可用空间，不足时以 HTTP 507 明确报错
  （「磁盘空间不足……原文件未改动，请清理空间后重试」），不做无谓尝试
- **异常留痕**：服务端异常统一记录到 `ui/server.log`（自动轮换防写满），
  未捕获异常不再静默崩溃退出
- **失败回滚**：前端保存失败时自动重新读取文件真实内容，避免把损坏
  状态当成有效数据继续操作

**给你的建议**：`ui/data/` 已纳入 git 跟踪，修改翻译后及时 commit
并推送——版本库就是最后的异地备份网。游戏存档本身请以游戏内云存档/
手动复制 `Frontiers` 目录为准，本工具写入前也会生成 `*.sav.bak`。

## 项目结构

```
├── src/                  # TypeScript 源码（CLI）
│   ├── index.ts          #   入口：export / import 命令
│   ├── export.ts         #   .sav → JSON
│   ├── import.ts         #   JSON → .sav
│   ├── file.ts           #   存档读写与备份逻辑（Web UI 复用）
│   └── folders.ts        #   文档目录定位（替代原生依赖）
├── dist/                 # 构建产物（pnpm build 生成，已 gitignore）
├── assets/               # 示例存档
├── ui/                   # 本地 Web UI（零依赖，仅需 Node）
│   ├── server.js         #   HTTP 服务 + 存档读写 API
│   ├── index.html        #   前端单页（全部逻辑内联）
│   ├── start-ui.bat      #   Windows 双击启动器
│   └── data/             #   翻译词库 CSV + autoColor 规则库
└── torchlight-3-save-editor/   # 运行时生成的 JSON 工作目录（已 gitignore）
```

## 致谢与许可

- 原项目：[GalacticCapybara/torchlight-3-save-editor](https://github.com/GalacticCapybara/torchlight-3-save-editor)
- 许可证：ISC License（与原项目一致，见 [LICENSE](LICENSE)）
