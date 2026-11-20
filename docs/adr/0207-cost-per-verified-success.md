# 0207. Cost per independently verified successful task (measurement only)

- Status: Proposed
- Date: 2026-11-19
- Builds on: ADR 0012 (budget reservation and usage), ADR 0017 (outcomes), ADR 0063 (usage views), ADR 0085 (roles: `view_usage`), ADR 0204 (founder status from evidence)
- Code: `packages/engine/src/cost-per-success.ts` (`costPerSuccess`), route `GET /api/app/organizations/{orgId}/usage/cost-per-success` (`apps/server/src/routes/app/plan-usage.ts`), client `useCostPerSuccess`, web `apps/web/src/components/CostPerSuccess.tsx` in Settings › Usage; tests `packages/engine/test/cost-per-success.test.ts`, `apps/server/test/person-usage.test.ts`

## Context

The usage views (ADR 0063) say what agents spent, not what the spend bought. Choosing a model or a brain for an agent needs the price of a result, and the only result this product records independently of the agent is a task whose acceptance criteria people checked (`criteria_met`, recorded only when every criterion's `doneBy` is a person, ADR 0204). An agent's own "done" or its own ticks are no evidence.

## Decision

A read-only report, per agent × brain × model and per time window (runs created in `[from, to)`, 30 days by default, at most 92), shows: finished runs, failed or stopped runs, retries, verified successes, tokens, total cost and cost per verified success.

1. **Success.** A task (`agent_runs.issue_id`) whose newest `criteria_met` / `issue_reopened` outcome is a `criteria_met` with every `checkedBy` a person. Reopening takes the success away; verifying again restores it. A task counts once, for the group of its latest finished run in the window.
2. **Cost.** Every finished run (`done`, `failed`, `canceled`) counts, verified or not. Usage billed to `platform` (this server's own services) is left out, as in ADR 0063. A run's cost is unknown when it has no usage rows or any row is a plan turn (`billed_to = plan` records no price). One unknown run makes its group's money `null`, never a 0 summed in.
3. **Cost per success.** `cost / verified successes` only when both are known and successes > 0; otherwise `null` with `missing` = `unknown_cost` or `no_success`. No division by zero.
4. **Retries.** Runs on a task after its first in the window.
5. **Model.** The model with the most tokens in the run's usage; a run with none goes to a group whose model is `null`. Brain is `agent_runs.brain`, `api` when null.
6. **Who sees it.** `view_usage` only: it is money.
7. **Words.** Each row and the total carry `text`, the number in plain Hong Kong Chinese, from the server (as ADR 0204's lines); the card's labels are i18n keys `usageViews.costPerSuccess.*` in every locale.
8. **Measurement only.** Nothing reads this report to change routing, models or budgets.

## Consequences

- Teams on plans see "Cost unknown" until per-turn prices exist for plan turns; that is the honest answer.
- Work not tracked as a task with criteria never shows a success; its cost still shows.
- The report loads the window's runs in memory; the 92-day cap bounds it.
