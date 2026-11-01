# IWE for VS Code

IWE is a Markdown knowledge base you and your AI agent work on together. This extension brings it into VS Code. See the [VS Code guide on iwe.md](https://iwe.md/docs/editors/vscode/).

The extension provides essential features for notes management, such as:

- 🔍 Search through your notes
- 🧭 Navigate through markdown links
- ✨ Auto-complete links as you type
- 🧩 Extract or inline sub-notes seamlessly
- 🖋️ Format the document and refresh link titles
- 🏷️ Rename files and automatically update all related links
- 🔗 Select backlinks to find references to the current document
- 🔄 Convert lists into headers and vice versa
- 💡 Display inlay hints with parent note references and link counts

## How to use

- **Code Actions** menu (`⌘`+`.`) to see available options for the current element
- **Go to Definition** (`F12`) on a link to open the linked file
- **Format Document** command (`Shift`+`Option`+`F`) to restructure/format the document
- **Rename** command (`F2`) on a link will rename the file and update all the references
- Global notes **search** (`⌘`+`T`) using the headers text

## Language Server

The extension runs the IWE language server (`iwes`). It looks for it in this order:

1. The path in the `iwe.serverPath` setting
2. `iwes` on your `PATH`, for example installed with `cargo install iwes`, Homebrew or `npm install -g @iwe-org/iwe`
3. A copy the extension downloads from [GitHub releases](https://github.com/iwe-org/iwe/releases) and keeps up to date

Downloads are verified against the SHA-256 checksum published with each release. On Linux the static (musl) build is used, so it runs on any distribution.

The server runs in the workspace folder that contains `.iwe/config.toml`, or in the first workspace folder if none does.

The status bar shows whether the server is running. Click it to open the IWE output.

## Commands

- **IWE: Restart Language Server**
- **IWE: Update Language Server**: download the latest release now and restart the server
- **IWE: Show Output**

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `iwe.serverPath` | `""` | Absolute path to an `iwes` binary |
| `iwe.autoUpdate` | `true` | Check for language server updates in the background |
| `iwe.updateCheckInterval` | `24` | Hours between update checks |
| `iwe.debug` | `false` | Start the server with `IWE_DEBUG`, which writes `iwe.log` to the workspace folder |
| `iwe.trace.server` | `"off"` | Log LSP traffic to the output panel (`off`, `messages`, `verbose`) |

When an update is downloaded in the background, the extension asks you to restart the server so it can use the new version. Updates only apply to the downloaded copy. If `iwes` comes from `iwe.serverPath` or your `PATH`, update it with the tool you installed it with.

Learn more at [iwe.md](https://iwe.md)
