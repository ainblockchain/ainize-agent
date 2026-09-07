# `ainize-agent` — an agent that ainizes its own experience

**Ainize** = *AI + -ize*, "make it usable by AI". The 2019 `ainize` CLI ainized GitHub repos into running AI
services; today's Ainize ainizes *knowledge* — verified memory-table patches an AI model can test, buy and load in
seconds. `ainize-agent` is the buyer side of that story as an autonomous program. `ngram-agent` (the historical
name) is an alias of the same binary.

There are two commands worth knowing. `run` buys **one** knowledge and proves it changed the model's answer. `ask`
is the loop: it answers a question the cheapest honest way it can, remembers what it learns, and eventually compiles
what it keeps looking up into a knowledge of its own.

---

## `ask` — the loop

```
a question arrives
  ├─ can I answer it from the memory I already carry?   yes → answer. no query, no completion, no cost.
  ├─ is there a LISTED knowledge that covers it?        yes → buy it, apply it, and KEEP it.
  ├─ otherwise ask upstream through the MCP client.     that costs a query EVERY time it is asked.
  └─ has this SHAPE been looked up often enough that
     querying has already cost more than compiling?     yes → AINIZE IT: build a dataset out of what was
                                                              retrieved, spend a lesson, keep the engram.
```

Retrieval is a cost paid **per question**; compiled memory is a cost paid **once**. `graph/bench` measures the static
version of that claim across four arms; this is the dynamic one, executed rather than asserted.

```bash
ainize-agent ask "what is the contract address of USDC?" --queries-per-day 20
ainize-agent ask "…" --bake-after 3 --lessons-per-day 1 --gpu-seconds-per-day 3600   # close the loop in one session
ainize-agent memory                    # facts, knowledge, shapes, and the disagreements it recorded
ainize-agent memory --why <shape>      # every gate, with the numbers it was decided from
ainize-agent budget                    # four caps, what is left of each, and where each cap came from
ainize-agent plans --check             # what it knows how to look up, and whether a plan is sane
```

Full guide: [docs/en/how-to/agent-memory.md](../../docs/en/how-to/agent-memory.md) · Korean:
[docs/ko/how-to/agent-memory.md](../../docs/ko/how-to/agent-memory.md).

**Four things it will not do.**

- **Spend anything it was not given a cap for.** Money, upstream queries, lessons and GPU seconds each have their
  own daily cap, and no cap set means "this agent will not spend that on its own" — with the flag that would change
  it in the refusal. A cap can only be set from a flag, the environment or `<home>/agent.json`: a plan file cannot
  raise one, a market's answer cannot, a 402 cannot.
- **Bake on a break-even it cannot compute.** N\* is `graph/bench`'s own arithmetic, computed from this agent's own
  measurements. Below three measurements on either side it is undefined and the agent refuses, naming the term it is
  short of. `--bake-after <n>` is a *declared policy* and is labelled as one everywhere it appears.
- **Retrieve a question no plan declares.** Plan matching collapses *declared* phrasings; it does not understand
  meaning, and it says so instead of guessing a query with somebody else's API key.
- **Publish.** A self-baked engram is private. Publishing writes an anchor nobody can recall, and the rows came from
  somebody else's data — the run names the one command a person would run.

**Exit codes:** `0` answered · `1` no answer · `2` a budget refused and nothing was spent.

---

## `run` — buy one knowledge and measure it

1. asks the serving model (OpenAI-compatible `/v1/completions`) and detects a wrong or unknown answer;
2. searches the market's catalog for a **LISTED** knowledge, refusing anything not verified by enough independent
   nodes (the verification quorum) or challenged by one;
3. requests its gateway → **automatic payment** challenge (HTTP 402, `x-payment-required`);
4. pays — `local-credit` signs an intent with its own key, `ain-transfer` sends AIN on-chain — and retries with
   `X-PAYMENT`;
5. verifies the manifest hash, downloads the body from a peer, verifies **sha256 == the on-ledger anchor**;
6. loads it into the running model without a restart and re-asks. **It is left loaded**: `--restore` unloads it
   again, and doing so writes the model's own rows back over whatever else is loaded.

```bash
ainize-agent run --market http://localhost:3402                                  # the built-in Pixelplus demo
ainize-agent run --patch krx-all-2761 --question "삼성전자 종목코드" --expect 005930 --prompt "종목코드 삼성전자 "
ainize-agent run --track daily/krx --max-price 5                                 # the newest verified bake of a track
ainize-agent catalog       # what is on sale, LISTED and the older versions still sold beside them
ainize-agent purchases     # what this agent bought, from whom, for how much, and where the file is
ainize-agent watch --track daily/krx --budget-per-day 30 --once
ainize-agent keys          # identity in <home>/identity.json (AINIZE_AGENT_HOME, or --home)
ainize-agent balance       # what it can spend here; the initial grant is read from the node's GET /api/info
```

`--api` is the serving API, and it has **no default**: it is read from the market node's `GET /api/runtime`, so the
before/after is measured on the model the knowledge was actually loaded into. `--repo` (the runtime repo whose
`scripts/patch.py` applies a patch) has no default either — writing into a model that belongs to a node is opt-in,
under that node's lock. Omitted, the run downloads and verifies but loads nothing, and says so.

`run` exits `0` only when the knowledge is LOADED (or `--download-only` was asked for); a run that ended with the
body on disk and nothing in any model exits `3`.

---

## What it keeps on disk

```
<home>/identity.json         the secp256k1 key it pays and teaches with
<home>/purchases.jsonl       receipts — the authority on what was bought and what was paid
<home>/pending-payments.jsonl  an intent written BEFORE the money moves
<home>/memory.jsonl          append-only: learn, recall, retrieve, buy, apply, bake, demote, conflict
<home>/memory-index.json     a derived snapshot; deleting it costs a replay, never a fact
<home>/spend.jsonl           one line per reservation and per settlement, intent first
<home>/retrieved/<shape>.*   the rows a bake trains on, and their sealed provenance
<home>/plans/*.json          what this agent knows how to look up
<home>/agent.json            caps, when you would rather not repeat the flags
```

All of it is text: `cat`, `grep` and `diff` work, and copying the directory moves the memory to another machine.

## Reuse, not rebuild

The loop owns none of the expensive parts. Buying is `runAgent` unchanged (`--no-probe`, keep). Retrieval is
`McpDataSource` from `@ainize/mcp/client`. Teaching is `runTeachLesson` — the body of the MCP `teach` tool, not a copy
of it. Residency is the node's own `applied` stack, read through the public `GET /api/runtime` (the agent is not the
node's operator). Prompt keys and dataset hashes are the node's own, so a fact learned from a training set and a
question typed by a person land on the same key.

Programmatic use: `import { ask, runAgent, shouldBake, AgentMemory, AgentBudget } from '@ainize/agent'` — importing
it costs the `@ainize/core` crypto every command already needs and about 6 ms more, not the MCP SDK, which is loaded
only on the branch that calls somebody else's server.
