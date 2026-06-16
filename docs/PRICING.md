# Freestyle pricing — what the integration costs

Snapshot of [freestyle.sh/pricing](https://www.freestyle.sh/pricing) as it
applies to **hosted trail authoring** (see [`README.md`](../README.md) for the
flow). Captured **2026-06-16** — re-check the page before quoting these numbers;
Freestyle can change them.

## TL;DR — the VM is the only metered cost

For one authoring session we provision a Git repo, an identity/token, and a VM,
then tear all three down. Of those, **only the VM accrues usage charges.** The
repo counts against a plan cap (not a per-repo fee) and identities/tokens are
not separately billed.

## Plan tiers (base subscription)

| Plan | Base / month | Repo cap | Concurrent VMs |
|---|---:|---:|---:|
| Free | $0 | 500 | 10 |
| Hobby | $50 | 5,000 | 40 |
| Pro | $500 | 50,000 | 400 |
| Enterprise | custom | custom | custom |

## VM usage (metered, billed by the hour)

| Resource | Rate |
|---|---:|
| vCPU | $0.04032 / vCPU-hour |
| Memory | $0.0129 / GiB-hour |
| Storage | $0.000086 / GiB-hour |

Free tier includes a daily allowance: 20 vCPU-hours, 40 memory-hours, 16,800
storage-hours.

## How this maps to the integration

- **`git.repos.create({ source })`** — consumes one repository slot from the
  plan cap above. No per-repo dollar charge. `git.repos.delete` returns the slot.
- **`identities.create` / `tokens.create`** — not separately billed.
- **The Freestyle VM** — the metered cost. A session is billed for the vCPU,
  memory, and storage it holds, by the hour, for as long as the VM is alive.
  A short clone-and-run keeps cost low; `vms.delete` stops the meter.

So cost scales with **VM time**, not repo count — and teardown
(`vms.delete` → `identities.delete` → `git.repos.delete`) leaves nothing
accruing charges after a session ends.
