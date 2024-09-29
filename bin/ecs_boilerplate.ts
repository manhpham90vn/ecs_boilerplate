#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import "dotenv/config";
import { EcsBoilerplateStack } from "../lib/ecs_boilerplate-stack";

const app = new cdk.App();
new EcsBoilerplateStack(app, "EcsBoilerplateStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
