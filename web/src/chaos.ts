/** The ready-made chaos experiments: what the reader fills in, and the fault rules that follow. */

export type Rule = {
  region?: string;
  service?: string;
  operation?: string;
  probability?: number;
  description?: string;
  error?: { statusCode?: number; code?: string };
};

export type Input = "probability" | "region" | "services" | "regions";
/** `probability` is in percent; lists are comma separated text. */
export type Values = Record<Input, string>;

export type Experiment = {
  title: string;
  about: string;
  inputs: Input[];
  defaults: Partial<Values>;
  rules: (values: Values) => Rule[];
};

export const list = (text: string) => text.split(",").map((part) => part.trim()).filter(Boolean);

const chance = ({ probability }: Values) => Number(probability) / 100;

const throughput = (service: string, title: string): Experiment => ({
  title,
  about: "Calls fail with ProvisionedThroughputExceededException.",
  inputs: ["probability"],
  defaults: {},
  rules: (values) => [
    { service, probability: chance(values), error: { statusCode: 400, code: "ProvisionedThroughputExceededException" } },
  ],
});

const unavailable = { statusCode: 503, code: "ServiceUnavailable" };

export const EXPERIMENTS: Experiment[] = [
  throughput("dynamodb", "DynamoDB error"),
  throughput("kinesis", "Kinesis error"),
  {
    title: "500 internal error",
    about: "Every service of a region answers with an internal error.",
    inputs: ["probability", "region"],
    defaults: { region: "us-east-1" },
    rules: (values) =>
      // without a region the rule would match every region
      list(values.region).map((region) => ({
        region,
        probability: chance(values),
        error: { statusCode: 500, code: "InternalError" },
      })),
  },
  {
    title: "Service unavailable (503)",
    about: "The listed services of a region answer 503.",
    inputs: ["services", "region"],
    defaults: { services: "kms, s3", region: "us-east-1" },
    rules: ({ services, region }) =>
      list(region).flatMap((where) => list(services).map((service) => ({ service, region: where, error: unavailable }))),
  },
  {
    title: "AWS region unavailable",
    about: "Every call to the listed regions answers 503.",
    inputs: ["regions"],
    defaults: { regions: "us-east-1, us-west-2" },
    rules: ({ regions }) => list(regions).map((region) => ({ region, error: unavailable })),
  },
];

/** The same change as a command, for scripts. */
export const template = (endpoint: string, rules: Rule[]) => {
  // inside single quotes the shell takes everything literally, except a single quote
  const body = JSON.stringify(rules).replace(/'/g, "'\\''");
  return `curl -X PATCH ${endpoint}/_localstack/chaos/faults -H 'Content-Type: application/json' -d '${body}'`;
};
