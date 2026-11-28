/** Views that a table or a generated form cannot express. Names are used in registry.json. */

import type { ComponentType } from "react";
import StackEditor from "./CloudFormation";
import PushCommands from "./Ecr";
import DynamoItems from "./DynamoItems";
import { PutEvent, TriggerRule } from "./Events";
import KinesisRecords from "./Kinesis";
import { CreateFunction, Invoke, PublishLayer } from "./Lambda";
import LogEvents from "./Logs";
import { SnsSent, SnsToken, SqsMessages } from "./Messages";
import MetricGraph from "./MetricGraph";
import RecordEditor from "./Route53";
import S3Objects from "./S3Objects";
import { AthenaSql, TimestreamQuery } from "./Queries";
import Schema, { Query } from "./AppSync";
import { Mailbox, SendEmail } from "./Ses";
import Definition from "./StepFunctions";

export const CUSTOM: Record<string, ComponentType<{ ids: string[] }>> = {
  "appsync-query": Query,
  "appsync-schema": Schema,
  "athena-sql": AthenaSql,
  "cfn-stack": StackEditor,
  "ecr-push": PushCommands,
  "dynamo-items": DynamoItems,
  "kinesis-records": KinesisRecords,
  "lambda-create": CreateFunction,
  "lambda-invoke": Invoke,
  "layer-publish": PublishLayer,
  "log-events": LogEvents,
  "metric-graph": MetricGraph,
  "put-event": PutEvent,
  "route53-record": RecordEditor,
  "rule-trigger": TriggerRule,
  "s3-objects": S3Objects,
  "ses-mailbox": Mailbox,
  "ses-send": SendEmail,
  "sfn-graph": Definition,
  "sns-sent": SnsSent,
  "sns-token": SnsToken,
  "sqs-messages": SqsMessages,
  "timestream-query": TimestreamQuery,
};
