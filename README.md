# `ainize-agent` — autonomous knowledge buyer

**Ainize** = *AI + -ize*, "make it usable by AI". The 2019 `ainize` CLI ainized GitHub repos into running AI
services; today's Ainize ainizes *knowledge* — verified knowledge patches an AI model can test, buy and load
in seconds. `ainize-agent` is the buyer side of that story as an autonomous program: an AI agent that notices
it does not know something and ainizes its own knowledge gap. `ngram-agent` (the historical name) is an alias
of the same binary.

A rebuild of the patent prototype's `agent_client.py` on the marketplace node protocol. The agent

1. asks the serving model (OpenAI-compatible `/v1/completions`) and detects a wrong/unknown answer;
2. searches the market's catalog for a **LISTED** patch (refuses anything not yet verified by enough
   independent nodes — the verification quorum);
3. requests the patch's gateway → **automatic payment** challenge (HTTP 402 Payment Required,
   `x-payment-required` header);
4. pays — `local-credit`: signs a payment intent with its own key (node credit, no sign-up);
   `ain-transfer`: sends AIN on-chain — and retries with `X-PAYMENT`;
5. verifies the manifest hash, downloads the body from a peer, verifies **sha256 == on-ledger anchor**;
6. loads the knowledge into the running model without restart, re-asks, and restores it (unless `--keep`).

```
node packages/agent/dist/bin.js run --market http://localhost:3402                 # 픽셀플러스 087600 demo
node packages/agent/dist/bin.js run --market http://localhost:3402 --patch krx-all-2761 --question "삼성전자 종목코드" --expect 005930 --prompt "종목코드 삼성전자 "
node packages/agent/dist/bin.js catalog --market http://localhost:3402
node packages/agent/dist/bin.js keys            # identity in ~/.ngram-agent/identity.json (NGRAM_AGENT_HOME)
node packages/agent/dist/bin.js balance         # local-credit balance; the initial grant is read from the node's GET /api/info (initial_credit)
```

`balance` no longer assumes 100 credits: it reads `initial_credit` from the market node and subtracts this
agent's purchases (plus any royalties it received). `--initial N` overrides the value if you need to. CREDIT is
the node's local development credit; in AIN-ledger mode prices are AIN (fund the agent with
`ainize chain fund <address>`).

Want to *see* the knowledge before buying? `ainize chat <patch-id> "<question>"` (in `packages/cli`) runs the
same before/after comparison the agent does, interactively.

Options: `--api` serving API (default `http://localhost:8000`), `--repo` runtime repo with `scripts/patch.py`
(default `/mnt/newdata/qwen3.8`), `--pay auto|local-credit|ain-transfer`, `--ain-provider` (default
`http://localhost:8081`), `--json`.

Exit code is non-zero when any step fails (quorum not met, payment rejected, hash mismatch, wrong answer
after apply).

Programmatic use: `import { runAgent, creditBalance, fetchInitialCredit } from '@ngram/agent'`.
