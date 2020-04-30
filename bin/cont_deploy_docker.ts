#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ContDeployDockerStack } from '../lib/cont_deploy_docker-stack';

const app = new cdk.App();
new ContDeployDockerStack(app, 'ContDeployDockerStack');
