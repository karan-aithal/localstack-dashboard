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
| Resources | Pages for 51 services, such as S3, Lambda, IAM and Step Functions. A freemium license covers 24; the others show "Not in your plan" |
| Explorer | Any operation of any service: generated form or JSON, response, next page |
| App Inspector | Recorded operations as requests, with flow, sequence, payloads and IAM events |
| IAM Policies | Live policy stream, policy per principal, permission check, enforcement setting |
| Chaos | Ready-made fault experiments, a custom rule and added latency, with the matching API command |
| State | Local pods (save, import, export, load), reset, save and load, state browser, pod remotes |
| Replicator | Copy a resource from a real AWS account into the instance |
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

IAM Policies, Chaos, State and Replicator need a plan that includes them; otherwise they show
"Not in your plan".

With IAM enforcement set to `ENFORCED`, the instance we tested refused an IAM user without
permissions but still served calls signed with an account ID, which is how the dashboard signs.

Saving and loading state on the instance may need persistence: with it off, both answered 404.
Local pods worked there.

Local pods are zip files in `~/.config/localstack-dashboard/pods/`. They contain your instance's
data, secrets included.

Replicator is the one feature that reaches outside your machine: you enter AWS credentials per
job, the dashboard passes them to your instance and keeps no copy.

`DASHBOARD_TEST_STATE=1 make test` also runs tests that inject a fault, switch IAM to soft mode
and reset the SQS service of the instance.

## Resource pages

Pages are described in `web/src/registry.json`: for each tab the list operation, key, columns,
create and remove operations, and views. `make test` checks every entry against the AWS API
definitions. Views a table or generated form cannot express live in `web/src/browser/custom/`.

`make test` runs live checks against the instance when it is up; they create and remove
`dashboard-test-*` resources. Pages of services outside a freemium license are checked live only
where the license covers them. Services whose first use downloads software are skipped unless
`DASHBOARD_TEST_DOWNLOADS=1`. Creating resources that need large engines, such as EKS and MSK, is
not tested. [PLAN.md](PLAN.md) records what has been run against an instance.

Uploads through the dashboard are limited to 50 MB per file.

Two actions do more than their name says:

- **Create Hello World** (Lambda web functions) also creates the bucket
  `dashboard-web-functions-<account>-<region>` and, if you keep the default role, the role
  `dashboard-web-function-role`. Removing the function leaves both. To run it, the instance
  downloads the `node:24-slim` image (333 MB) if Docker does not have it.
- **Remove with final snapshot** (database lists) creates a snapshot and removes the database only
  if that worked, because the instance we tested made none from the removal call itself. There is
  no snapshot page; use the explorer to list or delete snapshots.

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
