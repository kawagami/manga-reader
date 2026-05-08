# manga-reader

本地漫畫閱覽器，支援 zip / cbz 格式。

## 功能

- 選擇根目錄，自動掃描子資料夾內的 zip / cbz 檔案
- 三種閱讀模式：單頁 / 雙頁（右翻）/ 連續滾動
- 快速翻頁：鍵盤方向鍵、空白鍵
- zip 之間快速切換：Alt+↑↓ 或 Numpad0 隨機
- 拖放資料夾或 zip 檔案直接開啟
- 右鍵選單→在檔案總管中顯示
- 記憶上次開啟的目錄、閱讀模式、視窗大小與位置

## 鍵盤快捷鍵

| 按鍵 | 動作 |
|------|------|
| `←` / `↑` | 上一頁 |
| `→` / `↓` | 下一頁 |
| `Space` | 下一頁 |
| `Alt+↑` | 上一個 zip |
| `Alt+↓` | 下一個 zip |
| `Numpad 0` | 隨機跳到一個 zip |

## 開發

**需求**

- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/)
- [Tauri 前置需求（Windows）](https://tauri.app/start/prerequisites/)

**啟動開發環境**

```bash
pnpm install
pnpm tauri dev
```

**建置**

```bash
pnpm tauri build
```

## 技術

- [Tauri v2](https://tauri.app/) — Rust 後端
- [React 19](https://react.dev/) + TypeScript — 前端
- [Vite 7](https://vite.dev/) — 打包工具
