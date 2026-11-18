-- Baseline B0 of the long-term memory plan (T03/T09): what a whole run costs today, read-only.
-- psql -v days=14 -f packages/engine/eval/memory-baseline.sql
-- Per finished run of the last :days days: model tokens (usage_records, as billed, cache reads apart), model calls,
-- tool calls, memory searches (search_context), memory expansions (expand), memory items it received
-- (context_usage) and whether it finished done. Aggregates only; no content, no ids.
\if :{?days}
\else
  \set days 14
\endif
with runs as (
  select r.id, r.status, r.created_at, r.updated_at
  from agent_runs r
  where r.created_at > now() - make_interval(days => :days)
    and r.status in ('done', 'failed', 'canceled')
),
usage as (
  select u.run_id,
         sum(u.input_tokens)::bigint as input_tokens,
         sum(u.output_tokens)::bigint as output_tokens,
         sum(u.cache_read_tokens)::bigint as cache_read_tokens,
         sum(u.cache_write_tokens)::bigint as cache_write_tokens,
         count(*) as model_calls
  from usage_records u
  join runs on runs.id = u.run_id
  where u.purpose is null
  group by u.run_id
),
steps as (
  select s.run_id,
         count(*) filter (where s.kind = 'tool_call') as tool_calls,
         count(*) filter (where s.kind = 'tool_call' and s.data->>'name' = 'search_context') as memory_searches,
         count(*) filter (where s.kind = 'tool_call' and s.data->>'name' = 'expand') as memory_expands
  from agent_run_steps s
  join runs on runs.id = s.run_id
  group by s.run_id
),
memory as (
  select c.run_id, count(*) as memory_items
  from context_usage c
  join runs on runs.id = c.run_id
  group by c.run_id
),
per_run as (
  select runs.status,
         coalesce(u.input_tokens, 0) + coalesce(u.output_tokens, 0) as total_tokens,
         coalesce(u.input_tokens, 0) as input_tokens,
         coalesce(u.output_tokens, 0) as output_tokens,
         coalesce(u.cache_read_tokens, 0) as cache_read_tokens,
         coalesce(u.model_calls, 0) as model_calls,
         coalesce(s.tool_calls, 0) as tool_calls,
         coalesce(s.memory_searches, 0) as memory_searches,
         coalesce(s.memory_expands, 0) as memory_expands,
         coalesce(m.memory_items, 0) as memory_items,
         extract(epoch from runs.updated_at - runs.created_at) as seconds
  from runs
  left join usage u on u.run_id = runs.id
  left join steps s on s.run_id = runs.id
  left join memory m on m.run_id = runs.id
  where u.model_calls > 0
)
select :days as days,
       count(*) as runs,
       round(avg((status = 'done')::int) * 100, 1) as done_pct,
       percentile_disc(0.5) within group (order by total_tokens) as tokens_p50,
       percentile_disc(0.95) within group (order by total_tokens) as tokens_p95,
       round(avg(total_tokens)) as tokens_avg,
       round(avg(output_tokens)) as output_avg,
       round(sum(cache_read_tokens)::numeric / nullif(sum(input_tokens + cache_read_tokens), 0) * 100, 1) as cache_read_pct,
       round(avg(model_calls), 2) as model_calls_avg,
       round(avg(tool_calls), 2) as tool_calls_avg,
       round(avg(memory_searches), 3) as memory_searches_avg,
       round(avg(memory_expands), 3) as memory_expands_avg,
       round(avg((memory_items > 0)::int) * 100, 1) as runs_with_memory_pct,
       percentile_disc(0.5) within group (order by seconds) as seconds_p50,
       percentile_disc(0.95) within group (order by seconds) as seconds_p95
from per_run;
