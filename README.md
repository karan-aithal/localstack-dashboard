# Local Cloud Dashboard

A localhost dashboard for a running LocalStack instance. No sign-in.

Needs Docker, [uv](https://docs.astral.sh/uv/), Node 24 and a running LocalStack container.

```bash
make install
make dev          # open http://localhost:5180
make check        # tests and production build
```

## Pages

| Page | Shows |
|---|---|
| Overview | Instance info, license type, active features, start / restart / stop |
| Status | Service states and init scripts |
| Stack | Resources of all accounts and regions, grouped by service |
| Resources | Pages for the 24 services of a freemium license, such as S3, Lambda, IAM and Step Functions |
| Explorer | Any operation of any service: generated form or JSON, response, next page |
| Logs | Live container logs with text and level filter |
| Config | Instance configuration, if the instance exposes it |
| Instances | Bookmarks: name, endpoint, container |

Bookmarks are stored in `~/.config/localstack-dashboard/instances.json`.

## Resource pages

Pages are described in `web/src/registry.json`: for each tab the list operation, key, columns,
create and remove operations, and views. `make test` checks every entry against the AWS API
definitions. Views a table or generated form cannot express live in `web/src/browser/custom/`.

Uploads through the dashboard are limited to 50 MB per file.

## Security

The dashboard can start and stop containers, so keep it on localhost. It binds to
`127.0.0.1`, rejects foreign `Host` headers and cross-site writes, and redacts auth tokens.
It never reads your `.env`.

AWS calls go only to the selected instance, signed with dummy credentials. `AWS_*`
variables and `~/.aws` are ignored, so the dashboard cannot reach your real account.
The account ID switcher selects the LocalStack account.

In the explorer, binary values are base64 in the JSON editor. The form accepts text or a file.
