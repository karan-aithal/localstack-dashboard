# Local Cloud Dashboard

A localhost dashboard for a running LocalStack instance. No sign-in.

Needs Docker, [uv](https://docs.astral.sh/uv/), Node 24 and a running LocalStack container.

```bash
make install
make run          # build the UI and open http://localhost:8080
make check        # tests and production build
```

`make dev` serves the UI with live reload on http://localhost:5180 instead, for working on the
dashboard. Both use port 8080, so run one at a time. Colours follow the system's light or dark
setting.

## Pages

| Page | Shows |
|---|---|
| Overview | Instance info, license type, active features, start / restart / stop |
| Status | Service states and init scripts |
| Stack | Resources of all accounts and regions, grouped by service |
| Resources | Pages for the 24 services of a freemium license, such as S3, Lambda, IAM and Step Functions |
| Explorer | Any operation of any service: generated form or JSON, response, next page |
| App Inspector | Recorded operations as requests, with flow, sequence, payloads and IAM events |
| Extensions | Installed extensions, install by package name, known packages |
| Stack Insights | One session per run of the instance: calls over time, per service and one by one |
| Logs | Live container logs with text and level filter |
| Config | Instance configuration, if the instance exposes it |
| Instances | Bookmarks: name, endpoint, container |

Bookmarks are stored in `~/.config/localstack-dashboard/instances.json`.

Stack Insights reads the request lines of `docker logs` when you open it and keeps service,
operation, status and error code in `insights.db` next to the bookmarks. Sessions stay listed
after the container is removed; delete that file to forget them. Runs that were removed before
the page read them are gone.

## Resource pages

Pages are described in `web/src/registry.json`: for each tab the list operation, key, columns,
create and remove operations, and views. `make test` checks every entry against the AWS API
definitions. Views a table or generated form cannot express live in `web/src/browser/custom/`.

Uploads through the dashboard are limited to 50 MB per file.

Installing an extension runs third-party code inside the instance. The dashboard accepts
package names only, not URLs or paths, and asks before installing.

## Security

The dashboard can start and stop containers, so keep it on localhost. It binds to
`127.0.0.1`, rejects foreign `Host` headers and cross-site writes, and redacts auth tokens.
It never reads your `.env`.

AWS calls go only to the selected instance, signed with dummy credentials. `AWS_*`
variables and `~/.aws` are ignored, so the dashboard cannot reach your real account.
The account ID switcher selects the LocalStack account.

In the explorer, binary values are base64 in the JSON editor. The form accepts text or a file.
