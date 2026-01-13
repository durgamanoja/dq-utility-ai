#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { DQUtilityMergedStack } = require('../lib/dq-utility-merged-stack');

const app = new cdk.App();

// Deploy the merged stack that resolves cyclic dependencies
const mergedStack = new DQUtilityMergedStack(app, 'DQUtilityMergedStack', {
  env: {account: '<AWS ACCOUNT>', region: 'us-east-1'},
  pollIntervalSeconds: 60,
});
