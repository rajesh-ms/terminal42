# Cowork (Microsoft Work IQ) in terminal42

terminal42 can give every Copilot CLI session access to **Microsoft 365 Copilot
"Work IQ"** — the intelligence layer behind Microsoft 365 Copilot and Cowork.
Once wired, the agent can ground its answers in your real email, calendar,
files, Teams messages, people and Planner instead of asking you to paste context.

It uses **your existing model** in the model picker. Nothing about model routing
changes: Work IQ arrives as an MCP server whose tools the current model can call.

## How terminal42 wires it

On launch, terminal42 ensures this entry exists in the Copilot CLI's own MCP
config, `~/.copilot/mcp-config.json` (honouring `COPILOT_HOME`):

```json
{
  "mcpServers": {
    "workiq": {
      "tools": ["*"],
      "type": "local",
      "command": "npx",
      "args": ["-y", "@microsoft/workiq@latest", "mcp"]
    }
  }
}
```

Notes on the choices:

- **Why the shared config file and not a spawn flag.** terminal42 spawns the
  `copilot` binary from chat, design, recipes *and* the integrated terminal. A
  `--additional-mcp-config` flag would only reach the spawns terminal42
  authors; the user-scope file is read by the CLI for every session, so one
  entry covers all of them, including a `copilot` you start by hand in the
  terminal pane.
- **The entry is additive and idempotent.** terminal42 only ever adds or removes
  the single `workiq` key. Your other servers (`azure`, `context7`, `firecrawl`,
  …) and every other top-level key are preserved. An entry you have edited by
  hand is left alone rather than overwritten.
- **The first edit leaves a backup** at
  `~/.copilot/mcp-config.json.t42-backup`, and an unparseable file is never
  rewritten.

## Turning it off

The intent lives in terminal42 settings as `coworkEnabled` (default `true`) and
is applied once per launch:

- `cowork:disable` (or setting `coworkEnabled` to `false`) removes **only** the
  `workiq` entry and keeps it removed across restarts.
- `cowork:enable` restores it.

Removing the `workiq` key from `mcp-config.json` by hand while the setting stays
`true` is treated as "re-add on next launch"; flip the setting if you want it to
stay gone.

## Prerequisites (these are yours to complete)

The MCP server starts immediately, but a *useful answer* needs tenant and account
setup that terminal42 cannot do for you:

1. **Accept the EULA** for the Work IQ CLI:

   ```bash
   workiq accept-eula
   ```

2. **Sign in** (Entra delegated auth, per user):

   ```bash
   workiq auth login
   ```

3. **Tenant admin consent.** Work IQ needs the delegated scope
   `api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask` consented tenant-wide by a
   Global Admin (one-time). Microsoft's guide:
   <https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md>
4. **A usage-based billing plan** (Copilot Credits) in Copilot Studio with an
   Azure subscription/resource group, and your account assigned to it.

Without these, the `workiq` tools load but calls fail — typically
`User does not have access to Microsoft 365 Copilot` (missing Copilot licence)
or `403 Forbidden` (not on a billing plan).

## Verify

```bash
workiq version                     # CLI present, e.g. 1.0.1.47154
workiq ask -q "What's on my calendar tomorrow?"
```

Then, inside terminal42, ask a question that needs M365 context, e.g.
*"Summarise what my manager emailed me yesterday about the budget"*, and confirm
the agent calls a `workiq-*` tool.

The MCP server reports itself to the CLI on startup; a healthy session shows:

```
workiq  connected
```

and the Work IQ proxy logs `Registered 10 remote tools from
https://workiq.svc.cloud.microsoft/mcp`.

## The standalone CLI

The same capability is available directly, outside terminal42:

```bash
npm install -g @microsoft/workiq     # provides: workiq ask | mcp | auth | agents | fetch | ...
workiq ask                           # interactive
workiq ask -q "Summarise today's messages in the Engineering channel"
```

Docs: <https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli>

This is Microsoft's official CLI, so it is the right artifact to build on — not a
generated wrapper. Wrapping the Work IQ *Chat API* by hand would only reproduce a
cloud chat endpoint, which is not what a local coding agent needs.
