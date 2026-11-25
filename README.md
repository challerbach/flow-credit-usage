# Flow Credit Usage

Local app that shows how many Amplience credits a Workforce flow used: per run, per action, per billing unit and over time, plus a ranking of all flows in the hub.

## Start

```bash
cd ~/Documents/GitHub/flow-credit-usage
npm start            # http://localhost:4310
```

Node 18+, no dependencies, nothing to install.

The app asks for a personal access token on first load. To skip that, copy `env.example` to `.env.local` and set `AMPLIENCE_PAT` (or start with `AMPLIENCE_PAT=... npm start`). The token stays in the local server's memory, goes only to `https://api.amplience.net/graphql` and is never sent to the browser.

After the token, choose the hub in the **Hub** dropdown: it lists every hub the token can see, grouped by organisation. Hub, flow, year and month are kept in the page URL, so a bookmark opens the same view. **Change token** (top right) switches to another token.

Options (environment or `.env.local`): `HUB_ID` (the hub preselected in the dropdown, default `641a123294efd40001d0f0d1`), `PORT` (default 4310).

## Where the numbers come from

| Data | GraphQL |
|---|---|
| Hubs and organisations | `viewer.organizations.cmsHubs` |
| Flows of the hub | `cmsHub.contentFlows` |
| Run status | `contentFlow.runs` |
| Balance and allowance | `organization.creditBalance` |
| Credits | `organization.creditTransactionReport(input: { year, format: JSON }).reportURL` |

The credit report is downloaded once per year and cached for 10 minutes (**Reload report** downloads it again). Every entry carries the attributes `cmsHubId`, `workflowId`, `workflowLabel`, `workflowRunId`, `workflowRunLabel` and line items with `unit`, `quantity`, `credits` and an `actionLabel` attribute. The app filters on hub and flow, then sums the line item credits.

Things to know:

- Workforce records credits each time a run pauses or stops, so one run can have several entries. The app groups them per run.
- Running runs have no credit entries yet ("runs without credit entries" on the Runs tile).
- Reading the credit report needs organisation admin rights. Without them the app shows the API's error.
- Billing units: `action.trigger` (flat fee per trigger), `{model}.input-tokens` / `{model}.output-tokens` (LLM and agent actions), `extension.cpu.seconds` (extensions), `action.cpu.seconds` (other actions), `{supplier}.credits` (third-party actions). Flow control, helper and Human Review actions are free.
- **Diagnostics** at the bottom lists the counts per filter step and the fields of the first report entry, in case the report format changes.

## Tests

```bash
npm test
```
