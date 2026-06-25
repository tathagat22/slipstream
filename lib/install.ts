/** Shared install config — used by the homepage tabs and the /install how-to page. */
export const MCP_URL = "https://slipstream-pi.vercel.app/api/mcp";

export type InstallMethod = {
  label: string;
  /** One-line plain-English step for HowTo schema. */
  step: string;
  code: string;
};

export const INSTALL: Record<string, InstallMethod> = {
  "claude-code": {
    label: "Claude Code",
    step: "In Claude Code, run the one-line add command in your terminal.",
    code: `claude mcp add --transport http slipstream ${MCP_URL}`,
  },
  cursor: {
    label: "Cursor / Windsurf / VS Code",
    step: "In Cursor, Windsurf, or VS Code, add Slipstream to your MCP config (mcp.json).",
    code: `{
  "mcpServers": {
    "slipstream": { "url": "${MCP_URL}" }
  }
}`,
  },
  "claude-desktop": {
    label: "Claude Desktop",
    step: "In Claude Desktop, bridge the remote server with mcp-remote (npx handles it).",
    code: `{
  "mcpServers": {
    "slipstream": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}"]
    }
  }
}`,
  },
};
