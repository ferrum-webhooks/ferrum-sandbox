# ferrum-sandbox

Try **Ferrum**, a service that delivers webhooks reliably, without installing anything. Open it in a GitHub Codespace (free for personal accounts within GitHub's monthly allowance), start the system with one command, and follow a guided tour: signed deliveries, retries, a crashed worker, and more.

**[Open in GitHub Codespaces](https://codespaces.new/pratishtha-abrol/ferrum-sandbox)** · [Project page](https://pratishtha-abrol.github.io/ferrum-sandbox/)

## Use it

In the Codespace terminal:

```bash
make up       # starts PostgreSQL, Redis, the API, a worker and a test receiver (about 10 seconds)
make tour     # runs all 7 steps, about 1 minute; or one step: scripts/tour.sh 2
make check    # the 13-point end-to-end check
make down     # stop (make reset also deletes the data)
```

The API is at `http://127.0.0.1:8100` (Codespaces forwards the port). Create your own account and try the endpoints with `curl`; the [API reference](https://github.com/pratishtha-abrol/ferrum/blob/main/docs/api.md) lists them.

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

There is no shared server. Every visitor runs a private copy inside their own Codespace, so no one can reach anyone else's data, and nothing here makes outbound requests from a machine you pay for. The sandbox uses throwaway credentials that exist only inside the Codespace.

MIT licensed.
