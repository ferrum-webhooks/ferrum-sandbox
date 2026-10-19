# ferrum-sandbox

Try **Ferrum**, a service that delivers webhooks reliably, and follow a guided tour: signed deliveries, retries, a crashed worker, and more. There is no shared server: every option below runs a private copy, so nothing you do affects anyone else, and none of them costs the project anything.

[Project page](https://ferrum-webhooks.github.io/ferrum-sandbox/) · [Documentation](https://ferrum-webhooks.github.io/docs/)

## Ways to try it

| | How | Needs |
|---|---|---|
| **Play in your browser** | Open the [playground](https://ferrum-webhooks.github.io/ferrum-sandbox/play.html): send events, make the receiver fail, kill the worker, replay a dead letter. It is a model of the delivery rules (`site/engine.js`, tested in CI), not the real service | a browser |
| **See a run, no setup** | Open the latest **Sandbox check** run in the [Actions tab](https://github.com/ferrum-webhooks/ferrum-sandbox/actions/workflows/ci.yml); the whole tour is printed in the run summary | nothing |
| **Run it yourself in the browser** | [Fork this repository](https://github.com/ferrum-webhooks/ferrum-sandbox/fork) to your own account, then **Code → Codespaces → Create codespace on main**. It uses your personal free Codespaces allowance, not ours | a GitHub account |
| **Run it on your computer** | `git clone`, install PostgreSQL, Redis, `jq` and Python 3.9 to 3.11, then the commands below | macOS or Linux |

You can also fork and press **Actions → Sandbox check → Run workflow** to run the tour on GitHub's machines (free for public repositories).

## Commands

In the Codespace (or any terminal in the repository):

```bash
make setup    # download the three Ferrum repositories and install packages (once, about a minute)
make up       # starts PostgreSQL, Redis, the API, a worker and a test receiver (about 10 seconds)
make tour     # runs all 7 steps, about 1 minute; or one step: scripts/tour.sh 2
make check    # the 13-point end-to-end check
make down     # stop (make reset also deletes the data)
```
(In a new Codespace, `make setup` has already run.)

The API is at `http://127.0.0.1:8100`. Create your own account and try the endpoints with `curl`; the [API reference](https://ferrum-webhooks.github.io/docs/api/) lists them.

## The tour

| Step | Shows |
|---|---|
| 1 | an event arrives at a receiver with a valid signature |
| 2 | the receiver fails twice; retries come after 5 s and 10 s |
| 3 | a delivery that never works is parked as `dead_letter`, then replayed |
| 4 | the same request sent three times creates one event |
| 5 | the worker is killed mid-delivery; another one finishes the job |
| 6 | webhook URLs aimed at private networks are refused |
| 7 | the rate limiter answers `429` |

## How this repository works

```
.devcontainer/   installs PostgreSQL, Redis and tools when the Codespace is created
versions.env     which version of each Ferrum repository to run (set to a commit to pin it)
scripts/         fetch.sh downloads the three Ferrum repositories into workspace/; tour.sh is the tour
site/            the project page, published with GitHub Pages
.github/         CI runs the check and the whole tour on every push and once a week
```

Nothing here is a copy of the application: `make setup` downloads the gateway, worker and infra repositories from GitHub.

## Safe by design

There is no shared server. Every visitor runs a private copy (in their own Codespace, on GitHub's runners, or on their own computer), so no one can reach anyone else's data, and nothing here makes outbound requests from a machine the project pays for. The sandbox uses throwaway credentials that exist only inside that copy.

MIT licensed.
