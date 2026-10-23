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

## Automatic Updates

The extension automatically keeps the IWE language server up to date:

- 🔄 **Auto-update** - Checks for updates every 24 hours by default
- ⚙️ **Configurable** - Control update behavior in VS Code settings (`iwe.autoUpdate`, `iwe.updateCheckInterval`)
- 🛠️ **Manual updates** - Use Command Palette: "IWE: Update Language Server"
- 📢 **Smart notifications** - Get notified when updates are available with links to release notes

### How to Update Manually

To manually update the IWE language server:

1. **Open Command Palette**: Press `⌘`+`Shift`+`P` (Mac) or `Ctrl`+`Shift`+`P` (Windows/Linux)
2. **Type**: `IWE: Update Language Server`
3. **Select** the command from the dropdown
4. **Confirm** the update when prompted
5. **Wait** for the download and restart to complete

The extension will:
- Download the latest version from GitHub releases
- Replace the old binary automatically  
- Restart the language server with the new version
- Show a success notification when complete

> **Note**: If auto-updates are enabled, you typically won't need to do this manually. The extension checks for updates automatically based on your configured interval.

Learn more at [iwe.md](https://iwe.md)
