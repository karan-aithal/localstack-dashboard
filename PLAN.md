# Local LocalStack dashboard (no sign-in)

## Context
You want a localhost replacement for app.localstack.cloud, covering its features, built in phases. The local Pro container (2026.11.0, `freemium` license) already exposes the APIs needed. The dashboard calls only those and official AWS APIs on your instance. No license bypass, no decrypting of Pro `.py.enc` files, own name and branding.

Decisions: new repo `~/2CODE/localstack-dashboard`; FastAPI + React; locked features built for a higher plan; cloud-only features get local substitutes.

## Architecture
```
React UI  ->  FastAPI (127.0.0.1:8080)  ->  LocalStack :4566   (boto3 + /_localstack, /_aws)
                                        ->  docker CLI         (logs, start/stop)
```
```
localstack-dashboard/
  backend/app/    main.py, security.py, instance.py, aws.py, logs.py, features/*.py
  backend/tests/
  web/src/        pages/, services/ (rich views), registry.ts, api.ts
  Makefile
```
Dependencies (approving this plan approves them): `fastapi`, `uvicorn`, `boto3`, `httpx`, `pytest`; `react`, `vite`, `typescript`, `react-router`, `@tanstack/react-query`; `@xyflow/react` added in Phase 4. Python via `uv`, Node 24 already installed.

**Core idea:** one generic endpoint, `POST /api/aws/{service}/{operation}`, backed by boto3. botocore service models give the operation list and input shapes, so the UI generates forms for every service. No per-service backend code.

**Security (Phase 0)**
- Bind 127.0.0.1 only; reject unknown `Host` headers (DNS rebinding).
- Require same-origin `Origin` plus a custom header on state-changing requests (CSRF).
- boto3 always gets an explicit `endpoint_url` and dummy credentials, so it cannot reach real AWS. No fallback to `~/.aws`.
- Never return or log the auth token; redact `ls-...` strings. Backend never reads `.env`.
- `docker` runs with argument lists (no shell).

**Account/region:** global switcher. A 12-digit access key ID selects the account; default `000000000000` / `us-east-1`.

**Feature gating:** read `is_loaded` from `/_localstack/plugins`. A page whose plugin is not loaded shows "Not in your plan" and makes no calls.

## Phases
Each phase ends working (commits only when you ask).

| # | Phase | Works on your plan now |
|---|---|---|
| 0 | Scaffold and security | yes |
| 1 | Instance management | yes |
| 2 | Generic resource explorer | yes |
| 3 | Rich service views | yes, for services your license covers |
| 4 | App Inspector and Extensions | yes (limited trace storage) |
| 5 | Stack Insights, local | yes |
| 6 | Paid-plan features | no, needs upgrade or trial |
| 7 | Packaging and polish | yes |

### 0. Scaffold and security
Repo, FastAPI app, Vite app with dev proxy to the backend, middleware above, `make dev`, health indicator.

### 1. Instance management
- Overview: `/_localstack/info`, `/_localstack/stackinfo`, license type and plugins.
- Status: `/_localstack/health` service grid; `/_localstack/init` scripts.
- Logs: live tail of `docker logs -f` over SSE, with text and level filter.
- Restart (health endpoint action), start/stop container, confirm before destructive actions.
- Instance bookmarks (name, endpoint, container) in a local JSON file; substitute for cloud ephemeral instances.
- Config view when the instance enables it.

### 2. Generic resource explorer
- Service list from health; operation list, generated input form, JSON editor, response viewer.
- Handles pagination, timestamps, binary fields (base64), streaming bodies.
- Confirm dialog for `Delete*`/`Terminate*`/`Purge*`.
- Stack Overview page from `/_localstack/resources` (resources by type, region, account).

### 3. Resource browser
All 51 tiles of the app's browser with their sub-pages, specified in the appendix. Of these, 24 are in your license and 27 are not.
- **3a, engine and data core:** registry engine, then S3, DynamoDB, SQS, SNS, Lambda (with web functions), CloudWatch and Logs.
- **3b, rest of your license (17):** API Gateway, Step Functions, EC2 (with VPCs, security groups), CloudFormation, EventBridge, SSM, SES, ACM, IAM, KMS, Secrets Manager, Transcribe, Redshift, Kinesis, Data Firehose, Route 53 (with resolver), OpenSearch.
- **3c, locked services (27 tiles and locked sub-pages):** registry entries plus custom views. Shown as "Not in your plan"; behaviour untestable until the license covers them.

### 4. App Inspector and Extensions
- App Inspector: enable/disable via `/_localstack/appinspector/status`; operations list, search, spans, payloads, IAM events, delete; live updates from `/v1/ws/spans`; producer/consumer graph. Contract: the plain `appinspector/openapi/openapi.yaml` in the container.
- Extensions: list, install, remove via `/_localstack/extensions/*`; install by package name plus a small curated list (substitute for the cloud library). Request bodies are not in the spec; confirm from public docs or CLI first.

### 5. Stack Insights (local substitute)
Parse `AWS service.Operation => status` lines from container logs into SQLite (stdlib): call counts, services used, success/failure, time range filter, event list, per session. Nothing leaves the machine.

### 6. Paid-plan features (request shapes from the container's `pro/core/openapi.yaml`)
- **Chaos:** fault rules and latency (`/_localstack/chaos/faults`, `/effects`); templates for DynamoDB/Kinesis throughput errors, 500, 503 percentage, region outage, latency.
- **IAM:** enforcement config (`/_aws/iam/config`), action check (`/_aws/iam/check-actions-allowed`), policy stream with summary policy. The stream endpoint is **not in the spec**; needs discovery from public docs or CLI. Main unknown.
- **State:** save, load, reset (`/_localstack/state/...`).
- **Pods, local:** export/import state zip (`GET /_localstack/pods/state`, `POST /_localstack/pods`) into a local folder with a metadata list; metamodel browser; remotes management. LocalStack-hosted pod storage excluded.
- **Replicator:** job submit and status (`/_localstack/replicator/*`). This one reads your real AWS account, so credentials are entered per job, never stored, with an explicit warning.

### 7. Packaging and polish
FastAPI serves the built UI, single `make run` (optional compose service beside `docker-compose-pro.yml`), dark mode, keyboard-accessible tables and forms, README.

## Status of Phase 3a (2026-11-27)
Built: shared engine (`web/src/registry.json`, checked against botocore by tests) and S3, DynamoDB, SQS, SNS, Lambda with web functions, CloudWatch and Logs. The stack overview moved to `/stack`; `/resources` is the browser.

Differences from the appendix, still open:
- Large forms: optional fields are folded away, nested structures stay JSON. No per-structure sections yet.
- Web functions (changed 2026-11-28): a Hello World template uploads a small Node server to a bucket of its own and creates the function with an endpoint, with a role of its own unless another is named; the generated form stays for other code. Built from the AWS runtime documentation. Checked on the trial instance (2026-11-28): created from the browser, the endpoint answered with the greeting; test resources removed after. The instance downloaded `node:24-slim` (333 MB) to run it. `nodejs26.x` is untried.
- Uploads are limited to 50 MB per file.
- "Not in your plan" is implemented but unseen: every 3a service is licensed.

## Status of Phase 3b (2026-11-27)
Built: the other 17 licensed services, so all 24 licensed tiles have pages.

Differences from the appendix, still open:
- Step Functions flowchart is plain SVG; `@xyflow/react` was not added.
- Creating OpenSearch domains, Redshift clusters and transcription jobs is untested: LocalStack downloads large engines on first use. Their lists are tested.
- API keys, usage plans, authorizers, models and request validators are read-only, as planned. Stages can also be deployed and deleted.
- Deletes that AWS refuses while something is still attached (IAM users, rules with targets, non-empty zones) show the AWS error; there is no cascading delete.
- Transcribe has no audio upload; the job form takes an S3 URI.

## Status of Phase 3c (2026-11-27)
Built: the 27 locked tiles and the locked tabs of licensed tiles (API Gateway V2, EventBridge Pipes, Load Balancers V2, SES V2, Lambda capacity providers, Cognito identity pools), with custom views for the Athena and Timestream query editors, the AppSync schema and ECR push commands. They unlock by themselves when the license covers the service.

Checked on the freemium license: names, parameters, keys and columns against botocore; each page's first read reaches the instance and is refused for the license only; all pages render in a browser; the custom views with made-up answers.

Trial license (2026-11-27, expires after about 29 days): every locked page's first read answers, except DMS, which needs the instance started with `ENABLE_DMS=1`; account contacts answer "not found" until set. Create, view and remove pass for 25 cases in `backend/tests/test_trial.py`. The AppSync and Timestream cases are skipped by default and have not been run. Found and fixed: CloudFront distributions could not be removed, because the delete needs a version tag the list lacks. All 54 formerly locked pages draw real answers in a browser, apart from DMS and unset account contacts. The first Timestream call makes the instance install PostgreSQL, and AppSync downloads its utilities; tests skip both unless `DASHBOARD_TEST_DOWNLOADS=1`. Not covered by those tests because creating downloads or may download engines: CodeCommit, ECR, EKS, ElastiCache, RDS, DocumentDB, Neptune, MQ, MWAA, MSK, Athena, SageMaker endpoints, Lambda capacity providers.

Differences from the appendix, still open:
- No Neptune graph browser or quick actions.
- AppSync query runner (added 2026-11-28): the backend reads the API's GraphQL address, then sends the query to the selected instance with that path and host name; no subscriptions. Checked on the trial instance (2026-11-28): a query with variables answered through a NONE data source, and an unknown field showed the AppSync error. A wrong API key was refused (401), but the instance also answered a query sent without a key. Mutations and other kinds of sign-in are untried.
- "Browse S3" (added 2026-11-28) sits on the Athena output location and on form fields whose names ask for an S3 address. It fills a text field; inside a nested JSON value it copies the address for pasting. It lists the first 1000 entries of a folder. Checked on the trial instance (2026-11-28) from the Athena page: walking folders and picking a file or folder, including a name with spaces and `&`.
- Glue table update (changed 2026-11-28) starts from the current definition; fields the update does not take are left out. Checked on the trial instance (2026-11-28): after changing the description in the browser, the rest of a test table read back unchanged.
- Athena (changed 2026-11-28): the Databases tab shows `AwsDataCatalog`; other catalogs list their databases and tables from the Catalogs tab. Checked on the trial instance (2026-11-28) with a test catalog of type GLUE; other catalog types are untried.
- Removing RDS instances and RDS, DocumentDB and Neptune clusters (changed 2026-11-28) offers "with final snapshot" beside "without snapshot". The snapshot is named `final-<identifier>-<time>`; there is no snapshot page (the API explorer lists them). On the trial instance (2026-11-28) removing an instance with `FinalDBSnapshotIdentifier` created no snapshot, so the dashboard takes the snapshot itself and removes only if that worked; both outcomes were checked there with a PostgreSQL 13 instance (the failure made up in the browser). Removing an Aurora PostgreSQL 13.9 cluster also left its snapshot, which the instance lists with identifiers only, no status or engine. DocumentDB and Neptune clusters are untried, and no snapshot has been restored.
- Lambda capacity providers belong to a licensed service, so the page shows the instance's error instead of "Not in your plan".
- MSK: the license lists only an unused legacy provider, which no longer counts as covered.

## Status of Phase 6 (2026-11-28)
Built: Chaos (six experiments, active rules, latency, API command), IAM Policies (policy stream, summary, permission check, enforcement), State (local pods with save, import, export, load, delete and keep-newest cleanup; reset; save and load; state browser; remotes) and Replicator (job form, jobs, supported resources).

API facts found: the policy stream is `GET /_aws/iam/policies/stream` (a line of JSON per call), the summary `/_aws/iam/policies/summary`; the permission check wants `required_permissions`, though the instance's API description says `required_permission`.

Verified: input checks, origin checks, pod files and credential redaction with the instance replaced; reads, permission check, policy stream and a state export against the trial instance; pages and confirm dialogs in a browser.

With `DASHBOARD_TEST_STATE=1` the live tests also passed (2026-11-28): adding and removing a fault, setting latency, switching IAM to soft mode and back, and a pod round trip (export, SQS reset, load).

Checked from the browser on the trial instance (2026-11-28):
- A pod of SQS only, loaded with `service-merge`, brought back a deleted queue and its message.
- Save and load on the instance answer 404 there (persistence off); the dashboard now says so. Not run with persistence on.
- Switching IAM to `ENFORCED` and back worked, but calls with the dashboard's account keys, made-up access keys and no signature (SQS and IAM lists) were still served. A call by an IAM user without permissions is untried.
- The permission check fails in the instance on the resource `*`; the form now asks for a full ARN.

**Not verified:** resetting all services, adding a remote, the `overwrite` merge strategy. **Never run:** a replication job.

Differences, still open:
- Pods cannot be saved to or loaded from a remote.
- Replicator offers MOCK and SINGLE_RESOURCE jobs; batch jobs and the tree strategy are not offered.
- Chaos custom rule form (added 2026-11-28): service, optional operation, regions and error, probability. The rules it builds are tested. Checked on the trial instance (2026-11-28): a rule added in the browser failed only the matching S3 operation and region, and its Remove button cleared it.

## Status of Phase 4 (2026-11-27)
Built: App Inspector (enable, requests, flow, sequence, operation tabs, IAM events, clear) and Extensions (list, install, remove, 16 known packages with names checked on PyPI).

Differences, still open:
- Live updates poll every 2 seconds; the `/v1/ws/spans` websocket is not used.
- Flow is plain SVG; `@xyflow/react` was not added.
- Auto-Derived Policies is not built: it needs the Ultimate plan, so it cannot be seen here.
- No extension was installed. The installed list's real shape and the success events are unseen.
- API contract found: install `POST /_localstack/extensions/install {"URL": <package>}` answers NDJSON events; uninstall takes `{"distribution": <package>}`.

## Status of Phase 5 (2026-11-27)
Built: Stack Insights from container logs into SQLite: session list with filter, session page with time range, service and failure filters, calls over time, calls per service, event list. Counts of the running session matched `/_localstack/stackinfo` exactly.

Differences, still open:
- No Clients chart or User agent column: the log has no client.
- Calls made by the dashboard are counted; they cannot be told apart.
- Sessions are identified by start time, not by LocalStack's session ID (the log does not print it).
- Logs are read when the page is open. A container removed before that loses its sessions.
- The event list shows the latest 500 of the selected range.

## Status of Phase 7 (2026-11-27)
Built: `make run` builds the UI and the backend serves it on 8080, with a content security policy that blocks other sites from framing it and the page from loading anything elsewhere. Status page split into Running, Available and Other with full service names; API docs link per bookmark (Phase 1 follow-ups). Phone width and table markup fixes. Lighthouse accessibility 100 on the eight pages audited.

Differences, still open:
- No compose service for the dashboard: it would need the Docker socket inside a container, which gives that container control of the host.
- Dark mode follows the system setting; there is no switch.
- Status cards have no service icons.

## Excluded
Accounts, login, workspaces, users and licenses, SSO/SCIM, billing, identity logs, CI analytics, hosted pod storage, cloud ephemeral instances. All depend on LocalStack's backend. (CI analytics UI was not verified in the docs.)

## Verification
- Backend: pytest against the running container, per phase: create resource, see it through the dashboard API, delete it. Security tests: bad `Host`, missing CSRF header, requests only reach the configured instance.
- UI: `tsc --noEmit`, `vite build`, then click through new pages in Chrome and check the console.
- Phase 6: locked state verified now; behaviour only once your plan loads those plugins. Until then reported as untested.

## Start
After approval: Phases 0 and 1 first, then stop for your review. Phases 0 to 5, 7 and 3c are committed. Phase 3c is tested on the trial license where no large download is needed. Phase 6 is committed; its state-changing tests pass.

## Appendix: other tabs (live app, 2026-11-26, view only)

Not clicked, so not seen: Enable Stream, Run Experiment, Install, Import, Export, Load, Save, Submit, Getting Started, account pages, ephemeral instances tab.

### Overview, called "Stack Overview" (Preview) — Phase 2
- One collapsible row per service: resource types with counts, region count, account count. Expanded: type tag, resource ID, region, account.
- "+ Add Resources" opens the resource browser. Data: `/_localstack/resources`.
- Add as a "Resources" page; our instance info page stays.

### Status ("System Status") — Phase 1 follow-up
- Two sections, Running and Available; cards with icon, friendly service name, state. Ours shows API IDs in one grid: add the sections and friendly names (botocore `serviceFullName`).

### Instance menu and bookmarks — Phase 1 follow-up
- Menu next to the instance name: Edit, Remove (disabled for the default), Restart, API Docs.
- Add the API Docs link (`/_localstack/swagger`; that page loads assets from unpkg).
- New instance: tabs Bookmarks and Ephemeral; the app's default endpoint is `https://localhost.localstack.cloud:4566`.

### State — Phase 6
- **Local:** Import (drag and drop a file, "Import State"), Export (download a file). Text names the CLI `localstack state export <file>`.
- **Cloud:** Load from pod (pod name, merge strategy, default `account-region-merge`); Save (new or existing pod switch, name, services, default All). Ours stores pods in the local folder.

### App Inspector — Phase 4
- Tabs: Requests, Auto-Derived Policies.
- Requests: search; All, Errors, Warnings filters with counts; Consumer dropdown; Clear Operations; columns Time, Action, Consumer (service icon and resource), Request Details (operation and error counts).
- Detail pane: views Flow, Operations, Sequence; expand and close.
- Selected operation: Details (service, action, resource, ARN, account, region, start, duration), Payload, Response, Permissions, Advanced (span, trace, request IDs).
- On `freemium`: 10 operations stored (instance logs "operation limit exceeded"), IAM errors hidden, Auto-Derived Policies need Ultimate.
- Dependency note: Flow uses `@xyflow/react`; Sequence is drawn with plain SVG.

### IAM Policy Stream (Preview) — Phase 6
- Landing: text, "Enable Stream", "Documentation". The streaming view was not seen.
- Lead for the unknown API: App Inspector recorded requests to `/_aws/iam/config` and `/_aws/iam/policies/summary` (answered by S3 as `NoSuchBucket` on this plan). The stream endpoint itself is still unconfirmed.

### Chaos Engineering — Phase 6
Single page, one card per experiment, each with "Copy Chaos API Template" and "Run Experiment". The running and stop states were not seen.

| Experiment | Inputs (defaults) |
|---|---|
| DynamoDB Error (`ProvisionedThroughputExceededException`) | probability (100%) |
| Kinesis Error (same exception) | probability (100%) |
| 500 Internal Error | probability (100%), region |
| Service Unavailable (503) | services (KMS, S3), region |
| AWS Region Unavailable | regions (us-east-1, us-west-2) |
| Latency | 5 ms to 10000 ms slider |

### Extensions — Phase 4
- Instance tab "Extensions Manager": cards with name, publisher, description, Read more, Install.
- Listed: Claude (Anthropic API), Xero, Keycloak, ParadeDB, WireMock, TypeDB, Terraform Init Hooks, Resource Graph, Miniflare, MailHog, httpbin, Hello World, Diagnosis Viewer, AWS Proxy, Stripe, Authress. This is the curated list; PyPI package names still to be confirmed.
- Library: Browse ("Install On Instance") and Build (document, publish to PyPI with `setup.cfg`, `localstack extensions install <package>`).

### Cloud Pods — Phase 6 (local substitute)
- Storage bars (organization and user), table: Id, Pod name, Max version, Last change, Storage size, User id, Encrypted; "Show my pods only"; Actions: Delete; setting Auto-cleanup (versions to keep per pod).
- Ours: same table and auto-cleanup over the local folder; one storage bar; no user columns.

### Stack Insights — Phase 5
- Session list: ID, start time, state, version, runtime, API calls (ok and failed), service count; filter; Load More.
- Session detail: charts API Calls (successful, errored), Service Invocations, Clients; time slider; events table Service, Operation, Status code, Server time, User agent.
- **Limit for ours:** request log lines carry no user agent, so the Clients chart and column have no log source (`/_localstack/stackinfo` gives only the top user agent). Charts in plain SVG.

## Appendix: resource browser specification

### Sources and limits
- Live app (2026-11-26, signed in by you, view only): all 51 tiles and their sub-pages, list columns, bulk actions and create forms. Nothing was submitted.
- **Not seen:** detail pages, except the S3 bucket page (no other resources exist), dialogs behind row actions, ECS "Register Task Definition", RDS and DocumentDB create menus, "Publish Message", "Trigger Event". Those rows come from the public docs (some read only as summaries).
- Column lists show what was rendered; the table may hold more columns off screen.
- Operation names in "Behaviour per service" exist in botocore (pages found only in the live app have no operation list yet; check at build time). A list call per service showed license coverage. Create, update and delete calls were not run.

### Observed layout (copy the structure, not the branding)
- Landing: search box "Which service are you looking for?" above service tiles grouped in columns.
- List page: title with refresh button; top right: Create button, Actions menu (bulk, acts on checked rows), Region dropdown, Account ID input. Below: breadcrumb, row of sub-page links, table with checkboxes, 100 rows per page.
- Column headers are the API response keys in title case, so the engine can derive them.
- Create is its own page (`.../new`): fields follow the API input shape, required ones marked `*`, buttons "Reset Form" and "Submit". Same approach as our generated forms.
- S3 bucket page: links Objects and Permissions; Create Folder, Upload, Actions; path breadcrumb; "Copy S3 URI"; columns Key, Last Modified, Size.
- Locked service: red toast with the license error over an empty table. Ours shows "Not in your plan" instead.

### Route map
Routes are relative to `/resources`. 🔒 = not in your license.

| Tile | Pages | Bulk actions beyond delete/remove |
|---|---|---|
| API Gateway | `apigateway` (V1), `apigatewayv2` 🔒 | |
| SQS | `sqs` | |
| SNS | `sns`, button Publish Message | |
| Step Functions | `stepfunctions` | |
| EventBridge | `events/buses`, `events/pipes` 🔒 | Trigger Event |
| EventBridge Pipes 🔒 | `events/pipes` | |
| Application Auto Scaling 🔒 | `application-autoscaling` (namespace selector) | |
| MWAA 🔒 | `mwaa/environments` | |
| MQ 🔒 | `mq/brokers` | |
| EC2 | `ec2`, `ec2/vpcs`, `ec2/security-groups`, `elbv2` 🔒 | Start, Stop, Terminate |
| Lambda | `lambda/functions`, `lambda/web-functions`, `lambda/layers`, `lambda/capacity-providers` 🔒 | |
| ECS 🔒 | `ecs/clusters`, `ecs/definitions` | Deregister |
| ECR 🔒 | `ecr/repositories` | |
| EKS 🔒 | `eks/clusters` | |
| CloudFormation | `cloudformation/stacks` | |
| CloudWatch Logs | `cloudwatch/groups` | |
| CloudWatch | `cloudwatch/metrics` (Put Metric, no delete), `cloudwatch/alarms` | |
| SSM | `ssm` | |
| CloudTrail 🔒 | `cloudtrail/events`, `cloudtrail/trails` | |
| Account 🔒 | `account/contactinfo`, `account/alternatecontact` | |
| SES | `ses`, `sesv2` 🔒 | |
| AppConfig 🔒 | `appconfig/applications` | |
| CodeCommit 🔒 | `codecommit/repositories` | |
| AppSync 🔒 | `appsync` | |
| Amplify 🔒 | `amplify/apps` | |
| DMS 🔒 | `dms/replication-instances`, `dms/endpoints`, `dms/replication-tasks` | Start, Stop (tasks) |
| Cognito 🔒 | `cognito-idp` (user pools), `cognito-identity/pools` | |
| Secrets Manager | `secretsmanager` | |
| KMS | `kms` | Enable, Disable, Schedule Deletion |
| IAM | `iam` (users), `iam/groups`, `iam/roles`, `iam/policies` | |
| Certificate Manager | `acm/certificates` | |
| S3 | `s3`, `s3/<bucket>` | |
| Backup 🔒 | `backup/plans`, `backup/vaults` | |
| SageMaker 🔒 | `sagemaker/models`, `sagemaker/endpointconfigs`, `sagemaker/endpoints` ("Browse S3" picker) | |
| Transcribe | `transcribe/transcriptionjobs` | |
| Cost Explorer 🔒 | `ce/costcategorydefinitions` | |
| DynamoDB | `dynamodb`, `dynamodb/partiql` (editor, Run) | |
| RDS 🔒 | `rds/databases` | Create Database, Cluster, Instance in Actions menu |
| ElastiCache 🔒 | `elasticache` | |
| Timestream 🔒 | `timestream-write` | |
| DocumentDB 🔒 | `docdb/clusters` | Create Cluster, Instance in Actions menu |
| Neptune 🔒 | `neptune/instances`, `neptune/clusters`, `neptune/graph-browser` (Submit, Isolate, Focus), `neptune/quick-actions` (Add Node, Update Node, Add Edge) | |
| Athena 🔒 | `athena/databases`, `athena/catalogs`, `athena/sql` (Execute, Browse S3) | |
| Kinesis | `kinesis` | |
| Data Firehose | `firehose/delivery-streams` | |
| Kafka 🔒 | `kafka` | |
| Glue 🔒 | `glue/` + `databases`, `tables`, `connections`, `crawlers`, `jobs`, `registries`, `schemas` | Run, Stop (crawlers), Run (jobs) |
| Route 53 | `route53`, `route53resolver` | |
| CloudFront 🔒 | `cloudfront/distributions` | |
| OpenSearch | `opensearch/domains` | |
| Redshift | `redshift/clusters` | |

Form details the engine must handle (seen live):
- Very large forms (Firehose, EC2 launch, Lambda, OpenSearch): group nested structures into sections.
- Lambda code source: S3, zip upload, hot reload; web functions add a Hello World template.
- "Browse S3" picker for S3 URI fields (SageMaker, Athena, Glue jobs).

### Shared engine (built in 3a)
- Navigation `/resources/<service>/<tab>`, grouped as in the app; region and account selectors; "wrong region?" hint on empty lists.
- Registry entry: tabs; per tab the list operation, fixed params, result path, ID field, columns, describe, create, update, delete, row actions, child tabs (parent ID passed down).
- Every list: filter, pagination, multi-select with "Remove selected" and confirm. Name opens the detail view.
- Create, edit and action forms come from the botocore input shape (Phase 2), required fields first. This covers all form fields, including ones the docs do not name.
- "Locked" comes from the provider list in `/_localstack/licenseinfo` (backend returns service names only).
- Errors show the AWS error code and message.

### Behaviour per service
Notation: **Tabs** | actions with operations. `+` marks an addition the docs do not describe. **Custom** needs its own component.

Found live, missing from the docs:
- **Licensed:** Data Firehose (delivery streams; create, delete), EC2 VPCs and Security Groups (create, delete), Lambda Web Functions (service `lambda-web`), Route 53 Resolver endpoints (create, delete).
- **Locked:** EventBridge Pipes, Load Balancers V2, SES V2, Cognito Identity Pools, Lambda Capacity Providers, API Gateway V2.

### In your license (24 tiles)

**App Integration**
- **API Gateway** (v1; v2 is not licensed): Resources, Stages, Authorizers, Models, Request Validators, API Keys, Usage Plans | `Create/Update/DeleteRestApi`; `GetResources`, `GetStages`, `GetAuthorizers`, `GetModels`, `GetRequestValidators`, `GetApiKeys`, `GetUsagePlans` read-only; `+TestInvokeMethod`. V2 tab locked (`apigatewayv2`).
- **SQS**: Details, Messages | `CreateQueue`, `GetQueueAttributes`, `SendMessage` (body, delay, attributes), `DeleteQueue`, `+PurgeQueue`. **Custom:** messages peek via `/_aws/sqs/messages` (does not consume).
- **SNS**: Details, Subscriptions | `CreateTopic` (name, attributes, tags), `Subscribe`, `DeleteTopic`, `+Publish`, `+Unsubscribe`, `+`SMS, platform messages and subscription tokens via `/_aws/sns/*`.
- **Step Functions**: State machines; Executions, Definition | `CreateStateMachine`, `DescribeStateMachine`, `StartExecution` (input JSON), `ListExecutions`, `DeleteStateMachine`, `+GetExecutionHistory`. **Custom:** definition flowchart (`@xyflow/react`).
- **EventBridge**: Event buses, Rules | `ListEventBuses`, `PutRule` (pattern, schedule, state, role, tags), `PutEvents` (source, bus, detail, detail type, resources), `DeleteEventBus`, `+`trigger rule via `/_aws/events/rules/{arn}/trigger`.

**Compute**
- **Lambda**: Functions, Layers; version switcher | `CreateFunction`, `GetFunction`, `ListVersionsByFunction`, `DeleteFunction`, `Get/DeleteLayerVersion`, `+Invoke`, `+UpdateFunctionCode`, `+PublishLayerVersion`, `+`log link, `+`runtime list. **Custom:** zip upload, invoke panel.
- **EC2**: Instances | Launch (`RunInstances`), `StartInstances`, `StopInstances`, `TerminateInstances` (no delete).

**Management and Business**
- **CloudFormation**: Stacks; Status, Resources | `CreateStack` (file or URL, name, parameters), `UpdateStack`, `DeleteStack`, `+DescribeStackEvents`, `+GetTemplate`. **Custom:** template upload, parameter form.
- **CloudWatch Logs**: Groups, Streams, Events | `CreateLogGroup`, `CreateLogStream`, `FilterLogEvents` (pattern), `DeleteLogGroup/Stream`. **Custom:** event viewer.
- **CloudWatch Metrics**: Metrics, Alarms | `PutMetricData`, `PutMetricAlarm` (name, metric, namespace, statistic, operator, threshold, periods, unit, missing data, actions, tags), edit by re-put, `DeleteAlarms`, `+GetMetricData` chart.
- **SSM**: Parameters | `PutParameter`, `GetParameter` (value hidden until asked), `DeleteParameter`.
- **SES**: Identities, Sent mail | `VerifyEmailIdentity`, `SendEmail` (to, cc, bcc, text or HTML), `+DeleteIdentity`. **Custom:** mailbox via `/_aws/ses`, HTML shown in a sandboxed iframe without scripts.

**Security**
- **ACM**: Certificates | `RequestCertificate`, `DescribeCertificate`, `DeleteCertificate`.
- **IAM**: Users, Groups, Roles, Policies | create, view, edit, delete each; policy edit is `CreatePolicyVersion`.
- **KMS**: Keys | `CreateKey`, `UpdateKeyDescription`, bulk `Enable/DisableKey`, delete is `ScheduleKeyDeletion`.
- **Secrets Manager**: Secrets | `CreateSecret`, `DescribeSecret`, reveal on demand (`GetSecretValue`), `PutSecretValue`, `DeleteSecret`.

**Storage, ML, Database, Analytics**
- **S3**: Objects, Permissions | `CreateBucket` (name, config, ACL, ownership), folders, upload, download, view, `DeleteObject`, CORS and `+`policy editors, `DeleteBucket`. **Custom:** file browser.
- **Transcribe**: Jobs | `StartTranscriptionJob`, `GetTranscriptionJob`, `DeleteTranscriptionJob`.
- **DynamoDB**: Tables, Items, PartiQL | `Create/Update/DeleteTable`; item add, view, edit, delete; Scan and Query modes; `ExecuteStatement`; `+`delete expired TTL items. **Custom:** item editor, query builder.
- **Redshift**: Clusters | `CreateCluster` (identifier, database, user, password, node type), `ModifyCluster`, `DeleteCluster`.
- **Kinesis**: Streams; Kafka tab (locked, see MSK) | `CreateStream` (name, shards, mode), `UpdateShardCount`, `DeleteStream`, `+PutRecord`, `+GetRecords`.
- **Route 53**: Hosted zones, Records | `Create/DeleteHostedZone`; record create, edit, delete via `ChangeResourceRecordSets`.
- **OpenSearch**: Domains | `CreateDomain`, `DescribeDomain`, `UpdateDomainConfig`, `DeleteDomain`.

### Locked on your license (27 tiles, including EventBridge Pipes)

**App Integration**
- **Amazon MQ**: Brokers | `CreateBroker`, `DescribeBroker`, `DeleteBroker`.
- **MWAA**: Environments | `Create/Get/Update/DeleteEnvironment`.
- **Application Auto Scaling**: Scalable targets, namespace dropdown (required by `DescribeScalableTargets`) | `RegisterScalableTarget`, `DeregisterScalableTarget`.

**Compute**
- **ECS**: Clusters, Task definitions | `Create/Describe/Update/DeleteCluster`; `RegisterTaskDefinition`, edit by new revision, `DeregisterTaskDefinition`.
- **ECR**: Repositories, Images | `CreateRepository` (registry ID, name, tags), `ListImages`, push commands panel, `DeleteRepository`.
- **EKS**: Clusters | `CreateCluster`, `DescribeCluster`, `UpdateClusterConfig`, `DeleteCluster`.

**Management, Developer, Front-end**
- **Account**: Contact, Alternate contacts (filter billing, operations, security) | `Get/PutContactInformation`, `Get/PutAlternateContact`. No list-table; custom form. Provider is mock.
- **CloudTrail**: Trails, Event history | `CreateTrail` (name, bucket), `DescribeTrails`, `LookupEvents`, `+DeleteTrail`.
- **AppConfig**: Applications | `Create/Get/Update/DeleteApplication`.
- **CodeCommit**: Repositories | `CreateRepository` (name, description, tags, KMS key), `GetRepository` with clone URLs, `DeleteRepository`.
- **Amplify**: Apps | `Create/Get/Update/DeleteApp`.
- **AppSync** (GraphQL only; docs say Events APIs have no browser): APIs, Data sources, Schema, Query, Types, Resolvers, Functions, API keys | `Create/Update/DeleteGraphqlApi`, `Create/UpdateDataSource`, `CreateType`, `StartSchemaCreation`, `GetIntrospectionSchema`, `CreateResolver`, `CreateFunction`, `CreateApiKey`. **Custom:** schema editor, query runner (backend sends to the instance only).

**Security and Storage**
- **Cognito**: User pools; Details, Groups, Users | `Create/Update/DeleteUserPool`, `Create/DeleteGroup`, `AdminCreateUser`, `AdminDeleteUser`. The app lists "Cognito Identity" but the docs describe user pools only; identity pools unverified.
- **Backup**: Plans, Vaults | `CreateBackupPlan`, `CreateBackupVault`, `StartBackupJob`, `CreateBackupSelection`, delete plan and vault.

**Machine Learning and Database**
- **SageMaker**: Models, Endpoint configs, Endpoints | create, view, `DeleteModel`.
- **RDS**: Instances, Clusters | create, view, modify, delete both.
- **ElastiCache**: Cache clusters | `CreateCacheCluster`, view, `DeleteCacheCluster`.
- **DocumentDB**: Clusters, Instances | create, view, modify, delete both.
- **Neptune**: Clusters, Instances; Graph browser, Quick actions | create, view, modify instance. **Custom:** graph query and visualisation, add or modify node, create edge (graph client protocol needs research; may need a dependency, ask first).
- **Timestream**: Databases, Tables, Query | `timestream-write` create, describe, delete; `timestream-query` `Query`.

**Analytics, Finance, Migration**
- **Athena**: Databases, Catalogs, SQL | `ListDatabases`, `ListDataCatalogs`, `Create/UpdateDataCatalog`, `StartQueryExecution`, `GetQueryResults`. **Custom:** SQL editor.
- **MSK**: Clusters | `CreateCluster` (name, version, broker count, instance type), `DescribeCluster`, `UpdateBrokerCount`, `DeleteCluster`.
- **Glue**: Databases, Tables, Connections, Crawlers, Jobs, Schema registries, Schemas | create, view, delete each; tables also edit.
- **CloudFront**: Distributions | `Create/Get/Update/DeleteDistribution` (update needs the `ETag`).
- **Cost Explorer**: Cost categories | create, describe, delete `CostCategoryDefinition`.
- **DMS** (docs: preview, needs `ENABLE_DMS=1`): Replication instances, Endpoints (Connections tab with `TestConnection`), Tasks | create, view, delete.

### Acceptance per service
Licensed: pytest creates, lists, views and deletes one resource through the dashboard API, then a browser check of each tab. Locked: operation names checked against botocore and the locked state shown; reported as untested.
