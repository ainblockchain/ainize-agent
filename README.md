# `ngram-agent` — autonomous knowledge buyer

A rebuild of the patent prototype's `agent_client.py` on the marketplace node protocol. The agent

1. asks the serving model (OpenAI-compatible `/v1/completions`) and detects a wrong/unknown answer;
2. searches the market's catalog for a **LISTED** patch (refuses anything below the verification quorum);
3. requests the patch's x402 gateway → **HTTP 402 Payment Required** (`x-payment-required` header);
4. pays — `local-credit`: signs a payment intent with its own key; `ain-transfer`: sends AIN on-chain — and
   retries with `X-PAYMENT`;
5. verifies the manifest hash, downloads the body from a peer, verifies **sha256 == on-ledger anchor**;
6. applies the rows to the running model without restart, re-asks, and restores them (unless `--keep`).

```
node packages/agent/dist/bin.js run --market http://localhost:3402                 # 픽셀플러스 087600 demo
node packages/agent/dist/bin.js run --market http://localhost:3402 --patch krx-all-2761 --question "삼성전자 종목코드" --expect 005930 --prompt "종목코드 삼성전자 "
node packages/agent/dist/bin.js catalog --market http://localhost:3402
node packages/agent/dist/bin.js keys            # identity in ~/.ngram-agent/identity.json (NGRAM_AGENT_HOME)
node packages/agent/dist/bin.js balance         # local-credit balance (assumes the node's default 100 initial credit)
```

Options: `--api` serving API (default `http://localhost:8000`), `--repo` runtime repo with `scripts/patch.py`
(default `/mnt/newdata/qwen3.8`), `--pay auto|local-credit|ain-transfer`, `--ain-provider` (default
`http://localhost:8081`; fund the agent with `ngram chain fund <address>` first), `--json`.

Exit code is non-zero when any step fails (quorum not met, payment rejected, hash mismatch, wrong answer
after apply).

Programmatic use: `import { runAgent } from '@ngram/agent'`.
